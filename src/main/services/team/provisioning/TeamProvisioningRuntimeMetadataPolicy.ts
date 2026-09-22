import {
  normalizeRuntimeProcessRowsForTelemetry,
  type RuntimeTelemetryProcessTableRow,
} from '../TeamRuntimeTelemetry';

import type { TmuxPaneRuntimeInfo } from '@features/tmux-installer/main';
import type {
  PersistedTeamLaunchSnapshot,
  TeamAgentRuntimeBackendType,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
  TeamProviderId,
} from '@shared/types';

export interface LiveTeamAgentRuntimeMetadata {
  alive: boolean;
  backendType?: TeamAgentRuntimeBackendType;
  providerId?: TeamProviderId;
  agentId?: string;
  cwd?: string;
  pid?: number;
  metricsPid?: number;
  model?: string;
  tmuxPaneId?: string;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  pidSource?: TeamAgentRuntimePidSource;
  processCommand?: string;
  panePid?: number;
  paneCurrentCommand?: string;
  runtimeSessionId?: string;
  runtimeLastSeenAt?: string;
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics?: string[];
}

export interface RuntimeProcessRowsCacheEntry {
  expiresAtMs: number;
  generation: number;
  runId: string | null;
  sampledAtMs: number;
  rows: RuntimeTelemetryProcessTableRow[] | null;
  includesWindowsHostRows: boolean;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function shouldReadProcessTableForLiveRuntimeMetadata(params: {
  metadataByMember: ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>;
  launchSnapshot: PersistedTeamLaunchSnapshot | null | undefined;
  paneInfoById: ReadonlyMap<string, TmuxPaneRuntimeInfo>;
}): boolean {
  for (const [memberName, metadata] of params.metadataByMember.entries()) {
    if (metadata.agentId?.trim()) {
      return true;
    }
    const paneId = metadata.tmuxPaneId?.trim() ?? '';
    if (paneId && params.paneInfoById.has(paneId)) {
      return true;
    }
    const launchRuntimePid = params.launchSnapshot?.members[memberName]?.runtimePid;
    if (isPositiveFiniteNumber(metadata.metricsPid) || isPositiveFiniteNumber(launchRuntimePid)) {
      return true;
    }
  }
  return false;
}

export function readCachedRuntimeProcessRowsForLiveRuntimeMetadata(params: {
  cached: RuntimeProcessRowsCacheEntry | null | undefined;
  runId: string | null;
  nowMs: number;
  processTableCacheTtlMs: number;
  processTableFailureCacheTtlMs: number;
}): { rows: RuntimeTelemetryProcessTableRow[] | null } | null {
  const cached = params.cached;
  if (!cached || cached.expiresAtMs <= params.nowMs || cached.runId !== params.runId) {
    return null;
  }

  // Process table rows are sampled global OS state. Do not tie reuse to
  // runtime snapshot generation: launch progress invalidates runtime metadata
  // frequently, and the age gate below keeps liveness freshness bounded.
  const sampledAtMs =
    typeof cached.sampledAtMs === 'number' && Number.isFinite(cached.sampledAtMs)
      ? cached.sampledAtMs
      : 0;
  const maxAgeMs =
    cached.rows === null ? params.processTableFailureCacheTtlMs : params.processTableCacheTtlMs;
  if (sampledAtMs <= 0 || params.nowMs - sampledAtMs > maxAgeMs) {
    return null;
  }

  if (cached.rows === null) {
    return { rows: null };
  }

  const rows =
    normalizeRuntimeProcessRowsForTelemetry(cached.rows)?.filter(
      (row) => row.runtimeTelemetrySource !== 'windows-host'
    ) ?? [];
  return { rows };
}
