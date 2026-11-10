import type { RuntimeProjectionSnapshotResourceFields } from './RuntimeProjectionSnapshotResource';
import type {
  TeamAgentRuntimeBackendType,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
  TeamAgentRuntimeSnapshot,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface RuntimeProjectionMemberEntryInput extends RuntimeProjectionSnapshotResourceFields {
  memberName: string;
  alive: boolean;
  restartable: boolean;
  backendType?: TeamAgentRuntimeBackendType;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  pid?: number;
  runtimeModel?: string;
  cwd?: string;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  pidSource?: TeamAgentRuntimePidSource;
  processCommand?: string;
  paneId?: string;
  panePid?: number;
  paneCurrentCommand?: string;
  runtimePid?: number;
  runtimeSessionId?: string;
  runtimeLeaseExpiresAt?: string;
  runtimeLastSeenAt?: string;
  historicalBootstrapConfirmed?: boolean;
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics?: string[];
  updatedAt: string;
}

export interface RuntimeProjectionSnapshotDtoInput {
  teamName: string;
  updatedAt: string;
  runId: string | null;
  providerBackendId?: TeamProviderBackendId;
  fastMode?: TeamFastMode;
  members: Record<string, TeamAgentRuntimeEntry>;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function mapRuntimeProjectionMemberEntry(
  input: RuntimeProjectionMemberEntryInput
): TeamAgentRuntimeEntry {
  const pid = positiveInteger(input.pid);
  const runtimeModel = nonEmptyString(input.runtimeModel);
  const cwd = nonEmptyString(input.cwd);
  const rssBytes = finiteNonNegative(input.rssBytes);
  const cpuPercent = finiteNonNegative(input.cpuPercent);
  const primaryCpuPercent = finiteNonNegative(input.primaryCpuPercent);
  const primaryRssBytes = finiteNonNegative(input.primaryRssBytes);
  const childCpuPercent = finiteNonNegative(input.childCpuPercent);
  const childRssBytes = finiteNonNegative(input.childRssBytes);
  const processCount = positiveInteger(input.processCount);
  const processCommand = nonEmptyString(input.processCommand);
  const paneId = nonEmptyString(input.paneId);
  const panePid = positiveInteger(input.panePid);
  const paneCurrentCommand = nonEmptyString(input.paneCurrentCommand);
  const runtimePid = positiveInteger(input.runtimePid);
  const runtimeSessionId = nonEmptyString(input.runtimeSessionId);
  const runtimeLeaseExpiresAt = nonEmptyString(input.runtimeLeaseExpiresAt);
  const runtimeLastSeenAt = nonEmptyString(input.runtimeLastSeenAt);
  const runtimeDiagnostic = nonEmptyString(input.runtimeDiagnostic);

  return {
    memberName: input.memberName,
    alive: input.alive,
    restartable: input.restartable,
    ...(input.backendType ? { backendType: input.backendType } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.providerBackendId ? { providerBackendId: input.providerBackendId } : {}),
    ...(input.laneId ? { laneId: input.laneId } : {}),
    ...(input.laneKind ? { laneKind: input.laneKind } : {}),
    ...(pid ? { pid } : {}),
    ...(runtimeModel ? { runtimeModel } : {}),
    ...(cwd ? { cwd } : {}),
    ...(rssBytes != null ? { rssBytes } : {}),
    ...(cpuPercent != null ? { cpuPercent } : {}),
    ...(primaryCpuPercent != null ? { primaryCpuPercent } : {}),
    ...(primaryRssBytes != null ? { primaryRssBytes } : {}),
    ...(childCpuPercent != null ? { childCpuPercent } : {}),
    ...(childRssBytes != null ? { childRssBytes } : {}),
    ...(processCount ? { processCount } : {}),
    ...(input.runtimeLoadScope ? { runtimeLoadScope: input.runtimeLoadScope } : {}),
    ...(input.runtimeLoadTruncated ? { runtimeLoadTruncated: true } : {}),
    ...(input.resourceHistory ? { resourceHistory: input.resourceHistory } : {}),
    ...(input.livenessKind ? { livenessKind: input.livenessKind } : {}),
    ...(input.pidSource ? { pidSource: input.pidSource } : {}),
    ...(processCommand ? { processCommand } : {}),
    ...(paneId ? { paneId } : {}),
    ...(panePid ? { panePid } : {}),
    ...(paneCurrentCommand ? { paneCurrentCommand } : {}),
    ...(runtimePid ? { runtimePid } : {}),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
    ...(runtimeLeaseExpiresAt ? { runtimeLeaseExpiresAt } : {}),
    ...(runtimeLastSeenAt ? { runtimeLastSeenAt } : {}),
    ...(input.historicalBootstrapConfirmed ? { historicalBootstrapConfirmed: true } : {}),
    ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
    ...(input.runtimeDiagnosticSeverity
      ? { runtimeDiagnosticSeverity: input.runtimeDiagnosticSeverity }
      : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    updatedAt: input.updatedAt,
  };
}

export function mapRuntimeProjectionSnapshot(
  input: RuntimeProjectionSnapshotDtoInput
): TeamAgentRuntimeSnapshot {
  return {
    teamName: input.teamName,
    updatedAt: input.updatedAt,
    runId: input.runId,
    ...(input.providerBackendId ? { providerBackendId: input.providerBackendId } : {}),
    ...(input.fastMode ? { fastMode: input.fastMode } : {}),
    members: input.members,
  };
}
