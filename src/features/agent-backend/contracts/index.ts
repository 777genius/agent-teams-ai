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

export * from './operations';
