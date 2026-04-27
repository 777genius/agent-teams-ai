import type { RuntimeProcessTableRow, TmuxPaneRuntimeInfo } from '@features/tmux-installer/main';
import type {
  MemberSpawnStatusEntry,
  TeamAgentRuntimeBackendType,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
  TeamProviderId,
} from '@shared/types';

export interface ResolveTeamMemberRuntimeLivenessInput {
  teamName: string;
  memberName: string;
  agentId?: string;
  backendType?: TeamAgentRuntimeBackendType;
  providerId?: TeamProviderId;
  tmuxPaneId?: string;
  persistedRuntimePid?: number;
  persistedRuntimeSessionId?: string;
  trackedSpawnStatus?: MemberSpawnStatusEntry;
  runtimePid?: number;
  runtimeSessionId?: string;
  pane?: TmuxPaneRuntimeInfo;
  processRows: readonly RuntimeProcessTableRow[];
  processTableAvailable: boolean;
  nowIso: string;
}

export interface ResolvedTeamMemberRuntimeLiveness {
  alive: boolean;
  livenessKind: TeamAgentRuntimeLivenessKind;
  pidSource?: TeamAgentRuntimePidSource;
  pid?: number;
  metricsPid?: number;
  panePid?: number;
  paneCurrentCommand?: string;
  processCommand?: string;
  runtimeSessionId?: string;
  runtimeLastSeenAt?: string;
  runtimeDiagnostic: string;
  runtimeDiagnosticSeverity: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics: string[];
}

const SHELL_COMMAND_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'login', 'tmux']);
const SECRET_FLAG_PATTERN =
  /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;

function basenameCommand(command: string | undefined): string {
  const firstToken = command?.trim().split(/\s+/, 1)[0] ?? '';
  const base = firstToken.split(/[\\/]/).pop() ?? firstToken;
  return base.replace(/^-/, '').toLowerCase();
}

export function isShellLikeCommand(command: string | undefined): boolean {
  return SHELL_COMMAND_NAMES.has(basenameCommand(command));
}

export function sanitizeProcessCommandForDiagnostics(
  command: string | undefined
): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(SECRET_FLAG_PATTERN, '$1[redacted]').slice(0, 500);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractCliArgValues(command: string, argName: string): string[] {
  const escapedArg = escapeRegexLiteral(argName);
  const pattern = new RegExp(
    `(?:^|\\s)${escapedArg}(?:=|\\s+)("([^"]*)"|'([^']*)'|([^\\s]+))`,
    'g'
  );

  const values: string[] = [];
  for (const match of command.matchAll(pattern)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (value) values.push(value);
  }
  return values;
}

export function commandArgEquals(
  command: string,
  argName: string,
  expected: string | undefined
): boolean {
  const normalizedExpected = expected?.trim();
  if (!normalizedExpected) return false;
  return extractCliArgValues(command, argName).some((value) => value === normalizedExpected);
}

function collectDescendants(
  rows: readonly RuntimeProcessTableRow[],
  rootPid: number
): RuntimeProcessTableRow[] {
  const childrenByParent = new Map<number, RuntimeProcessTableRow[]>();
  for (const row of rows) {
    const current = childrenByParent.get(row.ppid) ?? [];
    current.push(row);
    childrenByParent.set(row.ppid, current);
  }

  const descendants: RuntimeProcessTableRow[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const row = queue.shift();
    if (!row || seen.has(row.pid)) continue;
    seen.add(row.pid);
    descendants.push(row);
    queue.push(...(childrenByParent.get(row.pid) ?? []));
  }
  return descendants;
}

function isVerifiedRuntimeProcess(params: {
  row: RuntimeProcessTableRow;
  teamName: string;
  agentId?: string;
}): boolean {
  return (
    commandArgEquals(params.row.command, '--team-name', params.teamName) &&
    commandArgEquals(params.row.command, '--agent-id', params.agentId)
  );
}

function isOpenCodeRuntimeProcess(command: string | undefined): boolean {
  return (command ?? '').toLowerCase().includes('opencode');
}

function hasPersistedEvidence(input: ResolveTeamMemberRuntimeLivenessInput): boolean {
  return Boolean(
    input.agentId?.trim() ||
    input.tmuxPaneId?.trim() ||
    input.persistedRuntimePid ||
    input.runtimePid ||
    input.persistedRuntimeSessionId?.trim() ||
    input.runtimeSessionId?.trim() ||
    input.backendType
  );
}

function result(params: {
  alive: boolean;
  livenessKind: TeamAgentRuntimeLivenessKind;
  runtimeDiagnostic: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics?: string[];
  pidSource?: TeamAgentRuntimePidSource;
  pid?: number;
  metricsPid?: number;
  panePid?: number;
  paneCurrentCommand?: string;
  processCommand?: string;
  runtimeSessionId?: string;
  runtimeLastSeenAt?: string;
}): ResolvedTeamMemberRuntimeLiveness {
  return {
    alive: params.alive,
    livenessKind: params.livenessKind,
    runtimeDiagnostic: params.runtimeDiagnostic,
    runtimeDiagnosticSeverity: params.runtimeDiagnosticSeverity ?? 'info',
    diagnostics: params.diagnostics ?? [params.runtimeDiagnostic],
    ...(params.pidSource ? { pidSource: params.pidSource } : {}),
    ...(typeof params.pid === 'number' && params.pid > 0 ? { pid: params.pid } : {}),
    ...(typeof params.metricsPid === 'number' && params.metricsPid > 0
      ? { metricsPid: params.metricsPid }
      : {}),
    ...(typeof params.panePid === 'number' && params.panePid > 0
      ? { panePid: params.panePid }
      : {}),
    ...(params.paneCurrentCommand ? { paneCurrentCommand: params.paneCurrentCommand } : {}),
    ...(params.processCommand ? { processCommand: params.processCommand } : {}),
    ...(params.runtimeSessionId ? { runtimeSessionId: params.runtimeSessionId } : {}),
    ...(params.runtimeLastSeenAt ? { runtimeLastSeenAt: params.runtimeLastSeenAt } : {}),
  };
}

export function resolveTeamMemberRuntimeLiveness(
  input: ResolveTeamMemberRuntimeLivenessInput
): ResolvedTeamMemberRuntimeLiveness {
  const tracked = input.trackedSpawnStatus;
  const runtimeSessionId = input.runtimeSessionId ?? input.persistedRuntimeSessionId;
  const hasConfirmedBootstrap =
    tracked?.bootstrapConfirmed === true || tracked?.launchState === 'confirmed_alive';
  const diagnostics: string[] = [];
  if (!input.processTableAvailable) {
    diagnostics.push('process table unavailable');
  }

  if (
    tracked?.launchState === 'runtime_pending_permission' ||
    (tracked?.pendingPermissionRequestIds?.length ?? 0) > 0
  ) {
    return result({
      alive: false,
      livenessKind: 'permission_blocked',
      runtimeSessionId,
      runtimeDiagnostic: 'waiting for permission approval',
      runtimeDiagnosticSeverity: 'warning',
      diagnostics: [...diagnostics, 'permission approval pending'],
    });
  }

  const verifiedProcess = input.processRows
    .filter((row) =>
      isVerifiedRuntimeProcess({ row, teamName: input.teamName, agentId: input.agentId })
    )
    .sort((left, right) => right.pid - left.pid)[0];
  if (verifiedProcess) {
    return result({
      alive: true,
      livenessKind: 'runtime_process',
      pidSource: 'agent_process_table',
      pid: verifiedProcess.pid,
      runtimeSessionId,
      processCommand: sanitizeProcessCommandForDiagnostics(verifiedProcess.command),
      runtimeDiagnostic: 'verified runtime process detected',
      diagnostics: [...diagnostics, 'matched process table by team-name and agent-id'],
    });
  }

  const runtimePid = input.runtimePid ?? input.persistedRuntimePid;
  const runtimePidRow =
    typeof runtimePid === 'number' && runtimePid > 0
      ? input.processRows.find((row) => row.pid === runtimePid)
      : undefined;
  if (runtimePidRow && input.providerId === 'opencode') {
    const processCommand = sanitizeProcessCommandForDiagnostics(runtimePidRow.command);
    if (isOpenCodeRuntimeProcess(runtimePidRow.command)) {
      if (hasConfirmedBootstrap) {
        return result({
          alive: true,
          livenessKind: 'runtime_process',
          pidSource: 'opencode_bridge',
          pid: runtimePidRow.pid,
          runtimeSessionId,
          processCommand,
          runtimeLastSeenAt: tracked?.lastHeartbeatAt ?? tracked?.updatedAt,
          runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
          diagnostics: [
            ...diagnostics,
            'matched OpenCode runtime pid and process identity',
            'bootstrap confirmed',
          ],
        });
      }
      return result({
        alive: false,
        livenessKind: 'runtime_process_candidate',
        pidSource: 'opencode_bridge',
        pid: runtimePidRow.pid,
        runtimeSessionId,
        processCommand,
        runtimeDiagnostic:
          'OpenCode runtime process detected, but teammate bootstrap is not confirmed',
        runtimeDiagnosticSeverity: 'warning',
        diagnostics: [
          ...diagnostics,
          'matched OpenCode runtime pid and process identity',
          'waiting for teammate bootstrap confirmation',
        ],
      });
    }
    return result({
      alive: false,
      livenessKind: 'runtime_process_candidate',
      pidSource: 'opencode_bridge',
      pid: runtimePidRow.pid,
      runtimeSessionId,
      processCommand,
      runtimeDiagnostic: 'OpenCode runtime pid is alive, but process identity is unverified',
      runtimeDiagnosticSeverity: 'warning',
      diagnostics: [
        ...diagnostics,
        'matched OpenCode runtime pid without OpenCode process identity',
      ],
    });
  }

  if (hasConfirmedBootstrap) {
    return result({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'runtime_bootstrap',
      runtimeSessionId,
      runtimeLastSeenAt: tracked.lastHeartbeatAt ?? tracked.updatedAt,
      runtimeDiagnostic: 'bootstrap confirmed',
      diagnostics: [...diagnostics, 'bootstrap confirmed'],
    });
  }

  const pane = input.pane;
  if (pane) {
    const descendants = collectDescendants(input.processRows, pane.panePid);
    const verifiedDescendant = descendants
      .filter((row) =>
        isVerifiedRuntimeProcess({ row, teamName: input.teamName, agentId: input.agentId })
      )
      .sort((left, right) => right.pid - left.pid)[0];
    if (verifiedDescendant) {
      return result({
        alive: true,
        livenessKind: 'runtime_process',
        pidSource: 'tmux_child',
        pid: verifiedDescendant.pid,
        panePid: pane.panePid,
        paneCurrentCommand: pane.currentCommand,
        runtimeSessionId,
        processCommand: sanitizeProcessCommandForDiagnostics(verifiedDescendant.command),
        runtimeDiagnostic: 'verified tmux runtime child detected',
        diagnostics: [...diagnostics, 'matched tmux descendant by team-name and agent-id'],
      });
    }

    const candidate = descendants.find((row) => !isShellLikeCommand(row.command));
    if (candidate) {
      return result({
        alive: false,
        livenessKind: 'runtime_process_candidate',
        pidSource: 'tmux_child',
        pid: candidate.pid,
        panePid: pane.panePid,
        paneCurrentCommand: pane.currentCommand,
        runtimeSessionId,
        processCommand: sanitizeProcessCommandForDiagnostics(candidate.command),
        runtimeDiagnostic: 'runtime process candidate detected',
        runtimeDiagnosticSeverity: 'warning',
        diagnostics: [...diagnostics, 'tmux descendant found without runtime identity match'],
      });
    }

    const shellOnly = isShellLikeCommand(pane.currentCommand);
    return result({
      alive: false,
      livenessKind: shellOnly ? 'shell_only' : 'runtime_process_candidate',
      pidSource: 'tmux_pane',
      pid: pane.panePid,
      panePid: pane.panePid,
      paneCurrentCommand: pane.currentCommand,
      runtimeSessionId,
      runtimeDiagnostic: shellOnly
        ? `tmux pane foreground command is ${pane.currentCommand ?? 'a shell'}`
        : 'tmux pane is alive, but runtime identity is not verified',
      runtimeDiagnosticSeverity: shellOnly ? 'warning' : 'info',
      diagnostics: [
        ...diagnostics,
        shellOnly
          ? `tmux pane is alive, but foreground command is ${pane.currentCommand ?? 'a shell'}`
          : 'tmux pane exists, but no verified runtime process was found',
      ],
    });
  }

  if (runtimePid && !runtimePidRow) {
    if (!input.processTableAvailable) {
      return result({
        alive: false,
        livenessKind: 'registered_only',
        pidSource: 'persisted_metadata',
        pid: runtimePid,
        runtimeSessionId,
        runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
        runtimeDiagnosticSeverity: 'warning',
        diagnostics: [...diagnostics, 'runtime pid could not be verified'],
      });
    }
    return result({
      alive: false,
      livenessKind: 'stale_metadata',
      pidSource: 'persisted_metadata',
      pid: runtimePid,
      runtimeSessionId,
      runtimeDiagnostic: 'persisted runtime pid is not alive',
      runtimeDiagnosticSeverity: 'warning',
      diagnostics: [...diagnostics, 'persisted runtime pid was not found in process table'],
    });
  }

  if (hasPersistedEvidence(input)) {
    return result({
      alive: false,
      livenessKind: 'registered_only',
      runtimeSessionId,
      runtimeDiagnostic: 'registered runtime metadata without live process',
      runtimeDiagnosticSeverity: 'warning',
      diagnostics: [...diagnostics, 'member has persisted runtime metadata only'],
    });
  }

  return result({
    alive: false,
    livenessKind: 'not_found',
    runtimeDiagnostic: 'runtime process not found',
    runtimeDiagnosticSeverity: 'warning',
    diagnostics: [...diagnostics, 'runtime process not found'],
  });
}

export function isStrongRuntimeEvidence(
  value: { livenessKind?: TeamAgentRuntimeLivenessKind } | undefined
): boolean {
  return value?.livenessKind === 'confirmed_bootstrap' || value?.livenessKind === 'runtime_process';
}
