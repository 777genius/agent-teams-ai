import type { MemberSpawnStatusEntry } from '@shared/types';

export interface LegacyPartialLaunchStateFile {
  version?: unknown;
  state?: unknown;
  updatedAt?: unknown;
  leadSessionId?: unknown;
  expectedMembers?: unknown;
  confirmedMembers?: unknown;
  missingMembers?: unknown;
}

export type RuntimeMemberSpawnState = Pick<
  MemberSpawnStatusEntry,
  | 'launchState'
  | 'status'
  | 'error'
  | 'hardFailureReason'
  | 'livenessSource'
  | 'agentToolAccepted'
  | 'runtimeAlive'
  | 'bootstrapConfirmed'
  | 'hardFailure'
  | 'skippedForLaunch'
  | 'skipReason'
  | 'skippedAt'
  | 'pendingPermissionRequestIds'
  | 'livenessKind'
  | 'runtimeDiagnostic'
  | 'runtimeDiagnosticSeverity'
  | 'bootstrapStalled'
  | 'livenessLastCheckedAt'
  | 'firstSpawnAcceptedAt'
  | 'lastHeartbeatAt'
  | 'runtimeModel'
  | 'updatedAt'
>;
