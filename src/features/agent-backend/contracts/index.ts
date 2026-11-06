/** Safe transport status; native paths, payloads and credentials stay main-owned. */
export type HostClientFailureCode =
  | 'invalid-profile'
  | 'profile-mismatch'
  | 'protocol-error'
  | 'transport-closed'
  | 'request-timeout'
  | 'capacity-exceeded'
  | 'shutting-down'
  | 'remote-error'
  | 'remote-rejected';

export type HostRequestOutcome = 'not-dispatched' | 'unknown' | 'rejected';

export interface HostClientFailure {
  code: HostClientFailureCode;
  outcome: HostRequestOutcome;
}

/** Opaque owner-qualified lookup key. No filesystem, provider or native identity. */
export interface BackendHandle {
  readonly handleId: string;
}

export * from './attachments';
export * from './connections';
export * from './creation';
export type * from './launch';
export * from './operations';
export type * from './review';
export * from './reviewWatch';
export type * from './roster';
export * from './stoppedImport';
export { HostTaskSubmissionRefusal, HostTeamOperationError } from './taskSubmission';
export { hostTeamRunId, isHostTeamRunId, parseHostTeamRunId } from './teamRunSelection';
export {
  hostTeamSelectionKey,
  isHostTeamSelectionKey,
  parseHostTeamSelectionKey,
} from './teamSelection';
export type * from './teamSnapshot';
