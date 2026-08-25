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

/** Narrow host seam implemented by the operations composition lane. */
export interface HostedStateCompatibilityRuntime {
  sha256(body: string): string;
  ensureDirectory(path: string, mode: number): Promise<void>;
  readDirectory(path: string): Promise<readonly string[]>;
  /** Open with no-follow semantics, verify a regular descriptor, bound the read, then recheck it. */
  readRegularBoundedUtf8(path: string, maximumBytes: number): Promise<string>;
  writeExclusiveDurable(path: string, body: string, mode: number): Promise<void>;
  removeFile(path: string): Promise<void>;
}
