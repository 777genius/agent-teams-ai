import type {
  TeamAgentRuntimeBackendType,
  TeamAgentRuntimeLivenessKind,
  TeamProviderId,
} from '@shared/types';

export const STALE_PROCESS_RUNTIME_METADATA_DIAGNOSTIC = 'persisted runtime pid is not alive';

const STALE_PROCESS_RUNTIME_METADATA_FIELDS = [
  'runtimePid',
  'bootstrapExpectedAfter',
  'bootstrapProofToken',
  'bootstrapRunId',
  'bootstrapProofMode',
  'bootstrapContextHash',
  'bootstrapBriefingHash',
  'bootstrapRuntimeEventsPath',
] as const;

export interface StaleProcessRuntimeMetadataCleanupCandidate {
  memberName: string;
  runtimePid: number;
  processPaneId: string;
  agentId?: string;
}

export interface StaleProcessRuntimeMetadataCleanupInput {
  memberName: string;
  providerId?: TeamProviderId | string;
  backendType?: TeamAgentRuntimeBackendType | string;
  agentId?: string;
  tmuxPaneId?: string;
  runtimePid?: number;
  runtimeSessionId?: string;
  runtimeRunId?: string;
  laneId?: string;
  laneKind?: string;
  laneOwnerProviderId?: string;
  livenessKind?: TeamAgentRuntimeLivenessKind | string;
  runtimeDiagnostic?: string;
  processTableAvailable: boolean;
  isLead: boolean;
  isRemoved: boolean;
}

export interface StaleProcessRuntimeMetadataCleanupResult {
  member: Record<string, unknown>;
  changed: boolean;
}

export interface StaleProcessRuntimeMetadataRuntimeGuard {
  hasTrackedRun?: boolean;
  hasRuntimeAdapterRun?: boolean;
  hasSecondaryRuntimeRun?: boolean;
  isStoppingSecondaryRuntimeTeam?: boolean;
  hasLaunchStateStoreOperation?: boolean;
  hasTeamOperationLock?: boolean;
  hasActiveLaunchState?: boolean;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isOpenCodeProvider(providerId: unknown): boolean {
  return normalizeString(providerId).toLowerCase() === 'opencode';
}

function hasRuntimeSessionId(value: unknown): boolean {
  return normalizeString(value).length > 0;
}

function hasLaneRuntimeMetadata(value: {
  laneId?: unknown;
  laneKind?: unknown;
  laneOwnerProviderId?: unknown;
}): boolean {
  return (
    normalizeString(value.laneId).length > 0 ||
    normalizeString(value.laneKind).length > 0 ||
    normalizeString(value.laneOwnerProviderId).length > 0
  );
}

function isDirectProcessRuntimeMetadata(params: {
  backendType?: unknown;
  tmuxPaneId?: unknown;
  runtimePid: number;
}): boolean {
  const backendType = normalizeString(params.backendType).toLowerCase();
  const tmuxPaneId = normalizeString(params.tmuxPaneId);
  const processPaneId = `process:${params.runtimePid}`;
  if (tmuxPaneId && tmuxPaneId !== processPaneId) {
    return false;
  }
  return backendType === 'process' || tmuxPaneId === processPaneId;
}

export function hasDirectProcessRuntimeMetadataForStaleCleanup(params: {
  backendType?: unknown;
  tmuxPaneId?: unknown;
  runtimePid?: unknown;
}): boolean {
  const runtimePid = normalizePositiveInteger(params.runtimePid);
  return runtimePid != null
    ? isDirectProcessRuntimeMetadata({
        backendType: params.backendType,
        tmuxPaneId: params.tmuxPaneId,
        runtimePid,
      })
    : false;
}

export function shouldSkipStaleProcessRuntimeMetadataCleanupForRuntimeGuard(
  input: StaleProcessRuntimeMetadataRuntimeGuard
): boolean {
  return Boolean(
    input.hasTrackedRun ||
    input.hasRuntimeAdapterRun ||
    input.hasSecondaryRuntimeRun ||
    input.isStoppingSecondaryRuntimeTeam ||
    input.hasLaunchStateStoreOperation ||
    input.hasTeamOperationLock ||
    input.hasActiveLaunchState
  );
}

export function collectStaleProcessRuntimeMetadataCleanupCandidate(
  input: StaleProcessRuntimeMetadataCleanupInput
): StaleProcessRuntimeMetadataCleanupCandidate | null {
  const memberName = input.memberName.trim();
  const runtimePid = normalizePositiveInteger(input.runtimePid);
  if (!memberName || runtimePid == null) {
    return null;
  }
  if (input.isLead || input.isRemoved) {
    return null;
  }
  if (input.livenessKind !== 'stale_metadata') {
    return null;
  }
  if (input.runtimeDiagnostic !== STALE_PROCESS_RUNTIME_METADATA_DIAGNOSTIC) {
    return null;
  }
  if (!input.processTableAvailable) {
    return null;
  }
  if (
    isOpenCodeProvider(input.providerId) ||
    hasRuntimeSessionId(input.runtimeSessionId) ||
    hasLaneRuntimeMetadata(input)
  ) {
    return null;
  }
  if (
    !isDirectProcessRuntimeMetadata({
      backendType: input.backendType,
      tmuxPaneId: input.tmuxPaneId,
      runtimePid,
    })
  ) {
    return null;
  }

  return {
    memberName,
    runtimePid,
    processPaneId: `process:${runtimePid}`,
    ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
  };
}

export function clearStaleProcessRuntimeMetadataFromMember(
  member: Record<string, unknown>,
  candidate: StaleProcessRuntimeMetadataCleanupCandidate
): StaleProcessRuntimeMetadataCleanupResult {
  const runtimePid = normalizePositiveInteger(member.runtimePid);
  if (runtimePid == null || runtimePid !== candidate.runtimePid) {
    return { member: { ...member }, changed: false };
  }
  if (isOpenCodeProvider(member.providerId ?? member.provider)) {
    return { member: { ...member }, changed: false };
  }
  if (hasRuntimeSessionId(member.runtimeSessionId) || hasLaneRuntimeMetadata(member)) {
    return { member: { ...member }, changed: false };
  }
  if (
    !isDirectProcessRuntimeMetadata({
      backendType: member.backendType,
      tmuxPaneId: member.tmuxPaneId,
      runtimePid,
    })
  ) {
    return { member: { ...member }, changed: false };
  }

  const next = { ...member };
  for (const field of STALE_PROCESS_RUNTIME_METADATA_FIELDS) {
    delete next[field];
  }
  if (normalizeString(member.tmuxPaneId) === candidate.processPaneId) {
    delete next.tmuxPaneId;
  }

  return { member: next, changed: true };
}
