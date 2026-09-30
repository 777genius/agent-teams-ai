export const INSTANCE_LEASE_PROTOCOL_VERSION = 1 as const;
export const INSTANCE_LEASE_FD = 3 as const;
export const INSTANCE_LEASE_CONTROL_FD = 4 as const;
export const INSTANCE_LEASE_EVIDENCE_MAX_BYTES = 512 as const;

export interface InstanceLeaseAnchorEvidence {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly uid: number;
  readonly linkCount: number;
}

export interface InstanceLeaseLauncherEvidence {
  readonly protocolVersion: typeof INSTANCE_LEASE_PROTOCOL_VERSION;
  readonly launcherPid: number;
  readonly controllerPid: number;
  readonly anchor: InstanceLeaseAnchorEvidence;
}

/**
 * A process-specific adapter may expose this port only after validating the
 * inherited descriptors and launcher evidence. Core code never receives raw
 * descriptor numbers or filesystem paths.
 */
export interface VerifiedInstanceLeaseHandle {
  readonly evidence: InstanceLeaseLauncherEvidence;
  assertValid(): void;
  close(): void;
}

export type InstanceLeaseGuardState = 'held' | 'released';

/**
 * Safe, path-free evidence for admission checks. `invalid` deliberately does
 * not expose adapter errors because descriptor and launcher diagnostics can
 * carry process-local details that must not cross the composition boundary.
 */
export type InstanceLeaseAdmissionInspection =
  | {
      readonly status: 'held';
      readonly evidence: InstanceLeaseLauncherEvidence;
    }
  | {
      readonly status: 'invalid' | 'released';
    };
