import { buildClaudeWorkspaceTrustPreflightArgs } from './ClaudePreflightCommand';
import { runPtyDialogEngine } from './PtyDialogEngine';
import { detectClaudeStartupState, normalizeTerminalText } from './StartupDialogRules';

import type { WorkspaceTrustDiagnosticStrategyResult, WorkspaceTrustWorkspace } from '../domain';
import type {
  ProviderStateProbe,
  ProviderTrustPersister,
  PtyProcessPort,
  TempEmptyMcpConfigStore,
  TerminalSnapshot,
} from './ports';

const WORKSPACE_TRUST_RAW_TAIL_LIMIT = 4096;
const CLAUDE_WORKSPACE_TRUST_PREFLIGHT_TIMEOUT_MS = 60_000;
const CLAUDE_WORKSPACE_TRUST_CONFIRM_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ClaudePtyWorkspaceTrustStrategyInput {
  claudePath: string;
  workspaces: WorkspaceTrustWorkspace[];
  env: Record<string, string | undefined>;
  ptyProcess?: PtyProcessPort;
  stateProbe?: ProviderStateProbe;
  trustPersister?: ProviderTrustPersister;
  tempEmptyMcpConfigStore?: TempEmptyMcpConfigStore;
  isCancelled(): boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function toPtyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      output[key] = value;
    }
  }
  return output;
}

function buildRawTail(snapshot: TerminalSnapshot | undefined): string | undefined {
  if (!snapshot) {
    return undefined;
  }
  const normalized = normalizeTerminalText(snapshot.text).trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(-WORKSPACE_TRUST_RAW_TAIL_LIMIT);
}

async function waitForTrustedState(input: {
  stateProbe: ProviderStateProbe;
  workspace: WorkspaceTrustWorkspace;
  isCancelled(): boolean;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<Awaited<ReturnType<ProviderStateProbe['readTrustState']>>> {
  const pollIntervalMs = Math.max(1, input.pollIntervalMs);
  const deadline = Date.now() + input.timeoutMs;
  let last = await input.stateProbe.readTrustState(input.workspace);
  while (last.status !== 'trusted' && !input.isCancelled()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
    last = await input.stateProbe.readTrustState(input.workspace);
  }
  return last;
}

function worseStatus(
  current: WorkspaceTrustDiagnosticStrategyResult['status'],
  next: WorkspaceTrustDiagnosticStrategyResult['status']
): WorkspaceTrustDiagnosticStrategyResult['status'] {
  const rank: Record<WorkspaceTrustDiagnosticStrategyResult['status'], number> = {
    skipped: 0,
    ok: 1,
    soft_failed: 2,
    blocked: 3,
    cancelled: 4,
  };
  return rank[next] > rank[current] ? next : current;
}

export class ClaudePtyWorkspaceTrustStrategy {
  constructor(
    private readonly defaults: {
      ptyProcess?: PtyProcessPort;
      stateProbe?: ProviderStateProbe;
      trustPersister?: ProviderTrustPersister;
      tempEmptyMcpConfigStore?: TempEmptyMcpConfigStore;
    } = {}
  ) {}

  async execute(
    input: ClaudePtyWorkspaceTrustStrategyInput
  ): Promise<WorkspaceTrustDiagnosticStrategyResult> {
    const ptyProcess = input.ptyProcess ?? this.defaults.ptyProcess;
    const stateProbe = input.stateProbe ?? this.defaults.stateProbe;
    const trustPersister = input.trustPersister ?? this.defaults.trustPersister;
    const tempEmptyMcpConfigStore =
      input.tempEmptyMcpConfigStore ?? this.defaults.tempEmptyMcpConfigStore;
    if (!stateProbe || (!trustPersister && (!ptyProcess || !tempEmptyMcpConfigStore))) {
      return {
        id: 'claude-pty-workspace-trust',
        provider: 'claude',
        status: 'soft_failed',
        workspaceIds: input.workspaces.map((workspace) => workspace.id),
        errorCode: 'workspace_trust_strategy_not_configured',
        errorMessage: 'Claude workspace trust strategy ports are not configured.',
      };
    }

    const startedAt = Date.now();
    const workspaceIds: string[] = [];
    const matchedRuleIds: string[] = [];
    const actions: string[] = [];
    const evidence: string[] = [];
    let status: WorkspaceTrustDiagnosticStrategyResult['status'] = 'ok';
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    let rawTail: string | undefined;

    for (const workspace of input.workspaces) {
      workspaceIds.push(workspace.id);
      if (input.isCancelled()) {
        status = 'cancelled';
        break;
      }

      if (!workspace.persistable) {
        status = worseStatus(status, 'blocked');
        errorCode = `workspace_trust_not_persistable_${workspace.nonPersistableReason ?? 'unknown'}`;
        evidence.push(`${workspace.id}:${errorCode}`);
        continue;
      }

      const before = await stateProbe.readTrustState(workspace);
      if (before.status === 'trusted') {
        evidence.push(...before.evidence);
        continue;
      }

      if (trustPersister) {
        const persisted = await trustPersister.persistTrustState(workspace);
        if (persisted.ok) {
          evidence.push(...persisted.evidence);
          const afterPersist = await stateProbe.readTrustState(workspace);
          if (afterPersist.status === 'trusted') {
            evidence.push(...afterPersist.evidence);
            continue;
          }
          evidence.push(
            afterPersist.status === 'unknown'
              ? (afterPersist.errorMessage ??
                  'Claude trust direct persist could not be verified after write.')
              : 'Claude trust direct persist did not produce a trusted project key.'
          );
        } else {
          evidence.push(persisted.message, ...(persisted.evidence ?? []));
        }
      }

      if (!ptyProcess || !tempEmptyMcpConfigStore) {
        status = worseStatus(status, 'soft_failed');
        errorCode = 'workspace_trust_strategy_not_configured';
        errorMessage = 'Claude workspace trust PTY fallback ports are not configured.';
        evidence.push(errorMessage);
        continue;
      }

      let mcpConfigHandle: Awaited<ReturnType<TempEmptyMcpConfigStore['create']>> | null = null;
      try {
        mcpConfigHandle = await tempEmptyMcpConfigStore.create();
        const command = buildClaudeWorkspaceTrustPreflightArgs({
          emptyMcpConfigPath: mcpConfigHandle.path,
        });
        if (!command.ok) {
          status = worseStatus(status, 'soft_failed');
          errorCode = command.code;
          errorMessage = command.message;
          evidence.push(command.message);
          continue;
        }

        const spawnResult = await ptyProcess.spawn({
          command: input.claudePath,
          args: command.args,
          cwd: workspace.cwd,
          env: toPtyEnv(input.env),
          cols: 120,
          rows: 36,
          name: 'xterm-256color',
        });
        if (!spawnResult.ok) {
          status = worseStatus(status, 'soft_failed');
          errorCode = spawnResult.code;
          errorMessage = spawnResult.message;
          evidence.push(spawnResult.message);
          continue;
        }

        try {
          const engineResult = await runPtyDialogEngine({
            session: spawnResult.session,
            detect: detectClaudeStartupState,
            isCancelled: input.isCancelled,
            timeoutMs: input.timeoutMs ?? CLAUDE_WORKSPACE_TRUST_PREFLIGHT_TIMEOUT_MS,
            pollIntervalMs: input.pollIntervalMs,
            afterDialogAction: async ({ ruleId }) => {
              if (ruleId !== 'claude.workspace_trust') {
                return { action: 'continue' };
              }
              const after = await waitForTrustedState({
                stateProbe,
                workspace,
                isCancelled: input.isCancelled,
                timeoutMs: Math.min(
                  CLAUDE_WORKSPACE_TRUST_CONFIRM_TIMEOUT_MS,
                  input.timeoutMs ?? CLAUDE_WORKSPACE_TRUST_CONFIRM_TIMEOUT_MS
                ),
                pollIntervalMs: input.pollIntervalMs ?? 100,
              });
              if (after.status === 'trusted') {
                evidence.push(...after.evidence);
                return { action: 'stop', reason: 'workspace_trust_persisted' };
              }
              return { action: 'continue' };
            },
          });
          matchedRuleIds.push(...engineResult.matchedRuleIds);
          actions.push(...engineResult.actions);
          if (engineResult.status !== 'ok') {
            rawTail = buildRawTail(engineResult.lastSnapshot) ?? rawTail;
          }

          if (engineResult.status === 'cancelled') {
            status = 'cancelled';
            break;
          }
          if (engineResult.status === 'blocked') {
            // Dialog-engine blocks are preflight uncertainty; only non-persistable paths block launch.
            status = worseStatus(status, 'soft_failed');
            errorCode = engineResult.code;
            errorMessage = engineResult.evidence[0] ?? engineResult.code;
            evidence.push(...engineResult.evidence);
            continue;
          }

          const after = await stateProbe.readTrustState(workspace);
          if (after.status === 'trusted') {
            evidence.push(...after.evidence);
            continue;
          }

          status = worseStatus(status, 'soft_failed');
          errorCode =
            engineResult.status === 'timeout'
              ? 'workspace_trust_preflight_timeout'
              : 'workspace_trust_preflight_not_confirmed';
          errorMessage = `Claude workspace trust was not confirmed for ${workspace.configKeyCwd}`;
          evidence.push(errorMessage);
        } finally {
          await spawnResult.session.kill().catch(() => undefined);
        }
      } catch (error) {
        status = worseStatus(status, 'soft_failed');
        errorCode = 'workspace_trust_preflight_error';
        errorMessage = error instanceof Error ? error.message : String(error);
        evidence.push(errorMessage);
      } finally {
        await mcpConfigHandle?.cleanup().catch(() => undefined);
      }
    }

    return {
      id: 'claude-pty-workspace-trust',
      provider: 'claude',
      status,
      workspaceIds,
      matchedRuleIds: [...new Set(matchedRuleIds)],
      actions,
      evidence: [...new Set(evidence)],
      elapsedMs: Date.now() - startedAt,
      errorCode,
      errorMessage,
      rawTail,
    };
  }
}
