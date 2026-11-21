import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';
import type { AdmittedLegacySourceWrite } from '@agent-teams/legacy-agent-host/lifecycle';
import type { MemberWorkSyncStorageGateway } from '@features/internal-storage/main';

export type { PendingPrimaryPurgeMarker } from './memberWorkSyncPurgeMarker';
export { parseDurablePathIdentity as parseMemberWorkSyncDurablePathIdentity } from './memberWorkSyncPurgeMarker';

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

