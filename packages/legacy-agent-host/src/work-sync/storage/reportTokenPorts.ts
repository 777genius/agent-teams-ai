export interface MemberWorkSyncTokenPaths {
  getReportTokenSecretPath(teamName: string): string;
  getTeamDir(teamName: string): string;
}
export type WorkSyncIdentityObservation =
  | { status: 'identified'; identityId: string }
  | { status: 'absent' | 'deleting' | 'unavailable' }
  | { status: 'unidentified'; reason: 'invalid_config' | 'missing_marker' | 'identity_lost' };
export type WorkSyncIdentityResult<T> =
  | { current: true; value: T }
  | { current: false; identity: WorkSyncIdentityObservation };
/** Existing legacy storage may adopt; Host supplies only fixed-owner publication. */
export interface MemberWorkSyncTokenIdentity {
  readCurrent(teamName: string): Promise<WorkSyncIdentityObservation>;
  adoptLegacy?(teamName: string): Promise<WorkSyncIdentityObservation>;
  withCurrent?<T>(
    teamName: string,
    identityId: string,
    operation: () => Promise<T>
  ): Promise<WorkSyncIdentityResult<T>>;
  withCurrentPublication?<T>(
    teamName: string,
    identityId: string,
    operation: (assertCurrent: () => void) => Promise<T>
  ): Promise<WorkSyncIdentityResult<T>>;
}
