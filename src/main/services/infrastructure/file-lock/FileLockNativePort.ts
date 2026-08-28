export type FileLockNativeAcquireResult =
  | { status: 'acquired'; leaseId: bigint; ownerKey: string }
  | { status: 'contended' | 'uncertain' | 'unsupported' };

/** Main-process-only capability boundary for the desktop file-lock native addon. */
export interface FileLockNativePort {
  captureScope(authorityRoot: string): bigint;
  tryAcquire(
    scopeId: bigint,
    relativeTarget: string,
    activeMarker: string
  ): FileLockNativeAcquireResult;
  assertOwned(leaseId: bigint): void;
  publishRelease(leaseId: bigint, record: string): void;
  release(leaseId: bigint): void;
  abandon(leaseId: bigint): void;
  closeScope(scopeId: bigint): void;
}
