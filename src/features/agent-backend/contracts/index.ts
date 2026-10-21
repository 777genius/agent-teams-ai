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
