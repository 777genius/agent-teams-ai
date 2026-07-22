import {
  commandArgEquals,
  extractCliArgValues,
  isShellLikeCommand,
  projectRuntimeLiveness,
  readVerifiedRuntimeProcessLivenessEvidence,
  type RuntimeProjectionLivenessProjection,
  sanitizeProcessCommandForDiagnostics,
} from './runtime-projection';

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

export {
  commandArgEquals,
  extractCliArgValues,
  isShellLikeCommand,
  sanitizeProcessCommandForDiagnostics,
};

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

function resultFromRuntimeProjection(
  projection: RuntimeProjectionLivenessProjection,
  params: {
    runtimeDiagnostic: string;
    runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
    diagnostics?: string[];
    pid?: number;
    panePid?: number;
    paneCurrentCommand?: string;
    runtimeSessionId?: string;
  }
): ResolvedTeamMemberRuntimeLiveness {
  return result({
    alive: projection.alive,
    livenessKind: projection.livenessKind,
    pidSource: projection.pidSource,
    pid: projection.pid,
    metricsPid: projection.metricsPid,
    processCommand: projection.processCommand,
    runtimeSessionId: projection.runtimeSessionId,
    runtimeLastSeenAt: projection.runtimeLastSeenAt,
    ...params,
  });
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

  const verifiedProcess = readVerifiedRuntimeProcessLivenessEvidence({
    rows: input.processRows,
    teamName: input.teamName,
    agentId: input.agentId,
    runtimeSessionId,
    pidSource: 'agent_process_table',
  });
  if (verifiedProcess) {
    return resultFromRuntimeProjection(projectRuntimeLiveness(verifiedProcess.evidence), {
      runtimeSessionId,
      runtimeDiagnostic: 'verified runtime process detected',
      diagnostics: [...diagnostics, ...verifiedProcess.diagnostics],
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
      alive: hasConfirmedBootstrap,
      livenessKind: hasConfirmedBootstrap ? 'confirmed_bootstrap' : 'runtime_process_candidate',
      pidSource: hasConfirmedBootstrap ? 'runtime_bootstrap' : 'opencode_bridge',
      pid: hasConfirmedBootstrap ? undefined : runtimePidRow.pid,
      runtimeSessionId,
      processCommand: hasConfirmedBootstrap ? undefined : processCommand,
      runtimeLastSeenAt: hasConfirmedBootstrap
        ? (tracked?.lastHeartbeatAt ?? tracked?.updatedAt)
        : undefined,
      runtimeDiagnostic: hasConfirmedBootstrap
        ? 'bootstrap confirmed; runtime pid currently points to a different process'
        : 'OpenCode runtime pid is alive, but process identity is unverified',
      runtimeDiagnosticSeverity: hasConfirmedBootstrap ? 'info' : 'warning',
      diagnostics: [
        ...diagnostics,
        hasConfirmedBootstrap
          ? 'bootstrap confirmed despite runtime pid identity mismatch'
          : 'matched OpenCode runtime pid without OpenCode process identity',
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
    const verifiedDescendant = readVerifiedRuntimeProcessLivenessEvidence({
      rows: descendants,
      teamName: input.teamName,
      agentId: input.agentId,
      runtimeSessionId,
      pidSource: 'tmux_child',
      diagnostic: 'matched tmux descendant by team-name and agent-id',
    });
    if (verifiedDescendant) {
      return resultFromRuntimeProjection(projectRuntimeLiveness(verifiedDescendant.evidence), {
        panePid: pane.panePid,
        paneCurrentCommand: pane.currentCommand,
        runtimeSessionId,
        runtimeDiagnostic: 'verified tmux runtime child detected',
        diagnostics: [...diagnostics, ...verifiedDescendant.diagnostics],
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
        runtimeDiagnostic: 'Runtime process candidate detected, but bootstrap is unconfirmed.',
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
      return resultFromRuntimeProjection(
        projectRuntimeLiveness({
          registration: {
            runtimePid,
            runtimeSessionId,
          },
          process: {
            pid: runtimePid,
            running: false,
            pidSource: 'persisted_metadata',
            processTableAvailable: false,
          },
        }),
        {
          pid: runtimePid,
          runtimeSessionId,
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
          diagnostics: [...diagnostics, 'runtime pid could not be verified'],
        }
      );
    }
    return resultFromRuntimeProjection(
      projectRuntimeLiveness({
        registration: {
          runtimePid,
          runtimeSessionId,
        },
        process: {
          pid: runtimePid,
          running: false,
          pidSource: 'persisted_metadata',
          processTableAvailable: true,
        },
      }),
      {
        pid: runtimePid,
        runtimeSessionId,
        runtimeDiagnostic: 'persisted runtime pid is not alive',
        runtimeDiagnosticSeverity: 'warning',
        diagnostics: [...diagnostics, 'persisted runtime pid was not found in process table'],
      }
    );
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
