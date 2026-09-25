export interface HostedOfflineRestoreRotationRequest {
  readonly format: 'hosted-restored-authority-rotation/v1';
  readonly schemaVersion: 1;
  readonly deploymentId: string;
  readonly restoreGeneration: number;
  readonly bootId: string;
  readonly eventEpoch: string;
  readonly browserAuthorityRotated: true;
  readonly runtimeAuthorityRotationRequired: true;
  readonly freshMountBindingsRequired: true;
}

export interface HostedOfflineRestoreRotationProof {
  readonly deploymentId: string;
  readonly restoreGeneration: number;
  readonly bootId: string;
  readonly eventEpoch: string;
  readonly browserSessionsRevoked: true;
  readonly runtimeAuthorityRotated: true;
  readonly mountBindingsRotated: true;
}

/** Supplied only by an operations composition that independently verifies owner evidence. */
export interface HostedOfflineRestoreRotationProofVerifier {
  verify(
    request: HostedOfflineRestoreRotationRequest,
    proof: HostedOfflineRestoreRotationProof
  ): Promise<boolean>;
}

/** Narrow host seam implemented by the operations composition lane. */
export interface HostedStateCompatibilityRuntime {
  sha256(body: string): string;
  ensureDirectory(path: string, mode: number): Promise<void>;
  readDirectory(path: string): Promise<readonly string[]>;
  /** True only for a real (no-follow) directory owned by this process, mode 0700 or tighter, with no entries. */
  isEmptyPrivateDirectory(path: string): Promise<boolean>;
  /** Read-only migration authority for a pre-header deployment; null means unproven. */
  inspectExistingStateBinding(
    path: string
  ): Promise<{ readonly deploymentId: string; readonly restoreGeneration: number } | null>;
  /** Open with no-follow semantics, verify a regular descriptor, bound the read, then recheck it. */
  readRegularBoundedUtf8(path: string, maximumBytes: number): Promise<string>;
  writeExclusiveDurable(path: string, body: string, mode: number): Promise<void>;
  createExclusiveDurable(path: string, body: string, mode: number): Promise<void>;
  removeFile(path: string): Promise<void>;
}
