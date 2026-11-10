import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';
import type { AdmittedLegacySourceWrite } from '@agent-teams/legacy-agent-host/lifecycle';
import type { MemberWorkSyncStorageGateway } from '@features/internal-storage/main';
import type { DurablePathIdentity } from '@main/utils/atomicWrite';

export interface PendingPrimaryPurgeMarker {
  schemaVersion: 2;
  teamName: string;
  deletionIdentityId: string | null;
  teamRootIdentity: DurablePathIdentity | null;
  activeJsonStateCleared: boolean;
  recoverySafe: boolean;
}

/** Internal storage restriction reader; privileged lifecycle ownership is composed privately. */
export interface MemberWorkSyncSourcePublication {
  current(teamName: string): AdmittedLegacySourceWrite | undefined;
}

export interface BackendSelectingMemberWorkSyncStoreOptions {
  sourceWriteAdmission?: MemberWorkSyncSourcePublication;
  gateway: MemberWorkSyncStorageGateway;
  paths: MemberWorkSyncStorePaths;
  fallbackRequiresReplica: boolean;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

/** Local storage work retains the original source admission; absent configured scope is an error. */
export function publishMemberWorkSyncLocal<T>(
  policy: MemberWorkSyncSourcePublication | undefined,
  teamName: string,
  operation: () => Promise<T>
): Promise<T> {
  const admission = policy?.current(teamName);
  return admission ? admission.publish(operation) : operation();
}

/** Exact finite filesystem identity used by the existing pending-purge owner. */
export function parseMemberWorkSyncDurablePathIdentity(value: unknown): DurablePathIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Partial<DurablePathIdentity>;
  return typeof identity.dev === 'number' &&
    Number.isFinite(identity.dev) &&
    typeof identity.ino === 'number' &&
    Number.isFinite(identity.ino) &&
    typeof identity.birthtimeMs === 'number' &&
    Number.isFinite(identity.birthtimeMs)
    ? { dev: identity.dev, ino: identity.ino, birthtimeMs: identity.birthtimeMs }
    : null;
}
