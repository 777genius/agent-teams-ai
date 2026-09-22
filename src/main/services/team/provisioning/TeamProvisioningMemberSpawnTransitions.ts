import { deriveMemberLaunchState } from './TeamProvisioningLaunchFailurePolicy';
import { isMemberSpawnHeartbeatTimestampNewer } from './TeamProvisioningMemberSpawnCursor';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';

import type {
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
} from '@shared/types';

export interface PendingMemberSpawnRestart {
  requestedAt?: string;
}

export interface MemberSpawnStatusTransitionInput {
  previous: MemberSpawnStatusEntry;
  requestedStatus: MemberSpawnStatus;
  updatedAt: string;
  error?: string;
  livenessSource?: MemberSpawnLivenessSource;
  heartbeatAt?: string;
  pendingRestart?: PendingMemberSpawnRestart;
}

export interface MemberSpawnStatusTransitionResult {
  status: MemberSpawnStatus;
  next: MemberSpawnStatusEntry;
  changed: boolean;
  runtimeTransitionAt: string;
  shouldClearPendingRestart: boolean;
  diagnosticText?: string;
}

export interface MemberSpawnTranscriptConfirmationInput {
  previous: MemberSpawnStatusEntry;
  updatedAt: string;
  observedAt: string;
  source: 'transcript' | 'runtime-proof';
}

export interface MemberSpawnTranscriptConfirmationResult {
  next: MemberSpawnStatusEntry;
  changed: boolean;
  runtimeTransitionAt: string;
  diagnosticText: string;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function resolveRequestedTransitionInput(
  input: MemberSpawnStatusTransitionInput
): MemberSpawnStatusTransitionInput {
  if (
    input.requestedStatus === 'waiting' &&
    !input.previous.hardFailure &&
    (input.previous.bootstrapConfirmed || input.previous.runtimeAlive)
  ) {
    return {
      ...input,
      requestedStatus: 'online',
      error: undefined,
      livenessSource: input.previous.livenessSource,
      heartbeatAt: input.previous.lastHeartbeatAt,
    };
  }
  return input;
}

function hasMemberSpawnStatusTransitionChanged(
  previous: MemberSpawnStatusEntry,
  next: MemberSpawnStatusEntry
): boolean {
  return !(
    previous.status === next.status &&
    previous.launchState === next.launchState &&
    previous.error === next.error &&
    previous.hardFailureReason === next.hardFailureReason &&
    (previous.skippedForLaunch === true) === (next.skippedForLaunch === true) &&
    previous.skipReason === next.skipReason &&
    previous.skippedAt === next.skippedAt &&
    previous.livenessSource === next.livenessSource &&
    previous.agentToolAccepted === next.agentToolAccepted &&
    previous.runtimeAlive === next.runtimeAlive &&
    previous.bootstrapConfirmed === next.bootstrapConfirmed &&
    previous.hardFailure === next.hardFailure &&
    previous.livenessKind === next.livenessKind &&
    previous.runtimeDiagnostic === next.runtimeDiagnostic &&
    previous.runtimeDiagnosticSeverity === next.runtimeDiagnosticSeverity &&
    previous.bootstrapStalled === next.bootstrapStalled &&
    previous.firstSpawnAcceptedAt === next.firstSpawnAcceptedAt &&
    previous.lastHeartbeatAt === next.lastHeartbeatAt
  );
}

function hasMemberSpawnTranscriptConfirmationChanged(
  previous: MemberSpawnStatusEntry,
  next: MemberSpawnStatusEntry
): boolean {
  return !(
    previous.status === next.status &&
    previous.launchState === next.launchState &&
    previous.error === next.error &&
    previous.hardFailureReason === next.hardFailureReason &&
    previous.livenessSource === next.livenessSource &&
    previous.agentToolAccepted === next.agentToolAccepted &&
    previous.runtimeAlive === next.runtimeAlive &&
    previous.bootstrapConfirmed === next.bootstrapConfirmed &&
    previous.hardFailure === next.hardFailure &&
    previous.bootstrapStalled === next.bootstrapStalled &&
    previous.firstSpawnAcceptedAt === next.firstSpawnAcceptedAt &&
    previous.lastHeartbeatAt === next.lastHeartbeatAt
  );
}

function getMemberSpawnStatusDiagnosticText(params: {
  status: MemberSpawnStatus;
  livenessSource?: MemberSpawnLivenessSource;
  previous: MemberSpawnStatusEntry;
  error?: string;
}): string | undefined {
  const { status, livenessSource, previous, error } = params;
  if (status === 'spawning') {
    return 'Agent tool invoked';
  }
  if (status === 'waiting') {
    return 'spawn accepted, waiting for teammate check-in';
  }
  if (status === 'online' && livenessSource === 'heartbeat' && !previous.bootstrapConfirmed) {
    return 'bootstrap confirmed via first heartbeat';
  }
  if (status === 'online' && livenessSource === 'process') {
    return 'runtime process is alive, teammate check-in not yet received';
  }
  if (status === 'error') {
    return error?.trim().length ? error.trim() : 'bootstrap failed';
  }
  if (status === 'skipped') {
    return error?.trim().length
      ? `skipped for this launch: ${error.trim()}`
      : 'skipped for this launch';
  }
  return undefined;
}

export function buildMemberSpawnFailureMessage(params: {
  memberName: string;
  resultPreview?: string;
  pendingRestart?: PendingMemberSpawnRestart;
}): string {
  const { memberName, resultPreview, pendingRestart } = params;
  const reason =
    (typeof resultPreview === 'string' && resultPreview.trim().length > 0
      ? resultPreview.trim()
      : 'Teammate spawn failed immediately after launch.') || 'Teammate spawn failed.';
  return pendingRestart
    ? `Failed to restart teammate "${memberName}": ${reason}`
    : `Teammate "${memberName}" failed to start: ${reason}`;
}

export function buildMemberSpawnStatusTransition(
  rawInput: MemberSpawnStatusTransitionInput
): MemberSpawnStatusTransitionResult {
  const input = resolveRequestedTransitionInput(rawInput);
  const { previous, requestedStatus: status, updatedAt, error, livenessSource, heartbeatAt } = input;
  const next: MemberSpawnStatusEntry = {
    ...previous,
    status,
    updatedAt,
  };

  if (status === 'spawning') {
    const pendingRestart = input.pendingRestart;
    next.skippedForLaunch = false;
    next.skipReason = undefined;
    next.skippedAt = undefined;
    next.agentToolAccepted = false;
    next.runtimeAlive = false;
    next.bootstrapConfirmed = false;
    next.hardFailure = false;
    next.bootstrapStalled = undefined;
    next.error = undefined;
    next.hardFailureReason = undefined;
    next.livenessSource = undefined;
    next.livenessKind = undefined;
    next.runtimeDiagnostic = undefined;
    next.runtimeDiagnosticSeverity = undefined;
    next.livenessLastCheckedAt = undefined;
    next.firstSpawnAcceptedAt = pendingRestart?.requestedAt;
    next.lastHeartbeatAt = undefined;
    if (pendingRestart) {
      next.runtimeDiagnostic =
        'Manual restart is already in progress; waiting for teammate bootstrap.';
      next.runtimeDiagnosticSeverity = 'info';
    }
    next.launchState = 'starting';
  } else if (status === 'waiting') {
    next.skippedForLaunch = false;
    next.skipReason = undefined;
    next.skippedAt = undefined;
    next.agentToolAccepted = true;
    next.runtimeAlive = false;
    next.bootstrapConfirmed = false;
    next.hardFailure = false;
    next.bootstrapStalled = undefined;
    next.error = undefined;
    next.hardFailureReason = undefined;
    next.livenessSource = undefined;
    next.livenessKind = undefined;
    next.runtimeDiagnostic = undefined;
    next.runtimeDiagnosticSeverity = undefined;
    next.livenessLastCheckedAt = undefined;
    next.firstSpawnAcceptedAt = previous.firstSpawnAcceptedAt ?? updatedAt;
    next.lastHeartbeatAt = undefined;
    next.launchState = 'runtime_pending_bootstrap';
  } else if (status === 'online') {
    next.skippedForLaunch = false;
    next.skipReason = undefined;
    next.skippedAt = undefined;
    next.agentToolAccepted = true;
    next.runtimeAlive = true;
    next.livenessSource = livenessSource;
    next.firstSpawnAcceptedAt = previous.firstSpawnAcceptedAt ?? updatedAt;
    if (livenessSource === 'heartbeat') {
      const incomingHeartbeatAt = heartbeatAt?.trim() || updatedAt;
      next.bootstrapConfirmed = true;
      next.lastHeartbeatAt = isMemberSpawnHeartbeatTimestampNewer(
        previous.lastHeartbeatAt,
        incomingHeartbeatAt
      )
        ? incomingHeartbeatAt
        : previous.lastHeartbeatAt;
    }
    next.hardFailure = false;
    next.bootstrapStalled = undefined;
    next.error = undefined;
    next.hardFailureReason = undefined;
    next.launchState = deriveMemberLaunchState(next);
  } else if (status === 'error') {
    next.skippedForLaunch = false;
    next.skipReason = undefined;
    next.skippedAt = undefined;
    next.error = error;
    next.hardFailure = true;
    next.bootstrapStalled = undefined;
    next.hardFailureReason = error;
    next.launchState = 'failed_to_start';
  } else if (status === 'skipped') {
    next.skippedForLaunch = true;
    next.skipReason =
      error?.trim() || previous.hardFailureReason || previous.error || 'Skipped for this launch';
    next.skippedAt = updatedAt;
    next.agentToolAccepted = false;
    next.runtimeAlive = false;
    next.bootstrapConfirmed = false;
    next.hardFailure = false;
    next.bootstrapStalled = undefined;
    next.error = undefined;
    next.hardFailureReason = undefined;
    next.livenessSource = undefined;
    next.livenessKind = undefined;
    next.runtimeDiagnostic = undefined;
    next.runtimeDiagnosticSeverity = undefined;
    next.livenessLastCheckedAt = undefined;
    next.firstSpawnAcceptedAt = undefined;
    next.lastHeartbeatAt = undefined;
    next.launchState = 'skipped_for_launch';
  } else if (status === 'offline') {
    Object.assign(next, createInitialMemberSpawnStatusEntry(), { updatedAt });
    next.error = undefined;
    next.hardFailureReason = undefined;
    next.skippedForLaunch = false;
    next.skipReason = undefined;
    next.skippedAt = undefined;
    next.livenessSource = undefined;
    next.livenessKind = undefined;
    next.runtimeDiagnostic = undefined;
    next.runtimeDiagnosticSeverity = undefined;
    next.livenessLastCheckedAt = undefined;
    next.firstSpawnAcceptedAt = undefined;
    next.lastHeartbeatAt = undefined;
  }

  next.launchState = deriveMemberLaunchState(next);
  const runtimeTransitionAt =
    status === 'online' && livenessSource === 'heartbeat'
      ? (normalizeIsoTimestamp(heartbeatAt) ?? updatedAt)
      : updatedAt;

  return {
    status,
    next,
    changed: hasMemberSpawnStatusTransitionChanged(previous, next),
    runtimeTransitionAt,
    shouldClearPendingRestart:
      (status === 'online' && (next.bootstrapConfirmed || livenessSource === 'process')) ||
      status === 'offline' ||
      status === 'error' ||
      status === 'skipped',
    diagnosticText: getMemberSpawnStatusDiagnosticText({
      status,
      livenessSource,
      previous,
      error,
    }),
  };
}

export function buildMemberSpawnTranscriptConfirmationTransition(
  input: MemberSpawnTranscriptConfirmationInput
): MemberSpawnTranscriptConfirmationResult {
  const { previous, updatedAt, observedAt, source } = input;
  const next: MemberSpawnStatusEntry = {
    ...previous,
    status: 'online',
    updatedAt,
    agentToolAccepted: true,
    runtimeAlive: source === 'runtime-proof' ? true : previous.runtimeAlive,
    bootstrapConfirmed: true,
    hardFailure: false,
    bootstrapStalled: undefined,
    error: undefined,
    hardFailureReason: undefined,
    livenessSource:
      source === 'runtime-proof' ? (previous.livenessSource ?? 'process') : previous.livenessSource,
    firstSpawnAcceptedAt: previous.firstSpawnAcceptedAt ?? observedAt,
    lastHeartbeatAt: isMemberSpawnHeartbeatTimestampNewer(previous.lastHeartbeatAt, observedAt)
      ? observedAt
      : previous.lastHeartbeatAt,
  };
  next.launchState = deriveMemberLaunchState(next);

  return {
    next,
    changed: hasMemberSpawnTranscriptConfirmationChanged(previous, next),
    runtimeTransitionAt: source === 'runtime-proof' ? observedAt : updatedAt,
    diagnosticText:
      source === 'runtime-proof'
        ? 'bootstrap confirmed via runtime proof'
        : 'bootstrap confirmed via transcript',
  };
}
