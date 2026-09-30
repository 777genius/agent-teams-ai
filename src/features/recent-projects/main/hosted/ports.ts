import type { BootId, DeploymentId, WorkspaceId } from '@shared/contracts/hosted';

export type HostedRecentProvider = 'anthropic' | 'codex';

/**
 * The producer supplies a live, immutable authority/grant/registry/mount snapshot.
 * The fingerprint must bind principal, session and deployment. `current()` must fail
 * when grant storage cannot be read, even when no metadata fact has been found.
 */
export interface HostedRecentAuthoritySnapshot {
  readonly authorityFingerprint: string;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly registrationRevision: number;
  readonly mountGeneration: number;
  readonly grantRevision: number;
}

export interface HostedRecentWorkspaceOwner {
  readonly runtimeWorkspaceId: WorkspaceId;
  readonly registrationRevision: number;
  readonly mountGeneration: number;
  readonly mountAvailable: boolean;
}

/**
 * Integration must validate the COMPLETE signed root map, including disabled/denied roots,
 * before returning this boundary. `attribute` canonicalizes cwd via realpath and picks the
 * deepest registered root. A denied/unavailable child must never resolve to its parent.
 */
export interface HostedRecentRootBoundary {
  /** Stable digest of the complete signed root/registration/binding/mount map. */
  readonly rootFingerprint: string;
  attribute(cwd: string): Promise<HostedRecentWorkspaceOwner | null>;
}

export interface HostedRecentRootAttributionPort {
  resolve(snapshot: HostedRecentAuthoritySnapshot): Promise<HostedRecentRootBoundary | null>;
}

/** Throws on grant storage errors; null means a proven absent grant. */
export interface HostedRecentGrantPort {
  projectGrantedWorkspace(
    snapshot: HostedRecentAuthoritySnapshot,
    runtimeWorkspaceId: WorkspaceId
  ): Promise<{ readonly workspaceId: WorkspaceId; readonly label: string } | null>;
}

export interface HostedRecentAuthorityPort {
  current(): Promise<HostedRecentAuthoritySnapshot | null>;
}

export interface HostedRecentMetadataFact {
  readonly cwd: string;
  readonly observedAt: number;
}

export interface HostedRecentMetadataRead {
  readonly status: 'complete' | 'partial' | 'unavailable';
}

/** Calls admission before retaining a fact; no source may cache unadmitted cwd. */
export interface HostedRecentMetadataSource {
  readonly provider: HostedRecentProvider;
  read(admit: (fact: HostedRecentMetadataFact) => Promise<void>): Promise<HostedRecentMetadataRead>;
}
