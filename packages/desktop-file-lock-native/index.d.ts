export type AcquireResult =
  | { status: 'acquired'; leaseId: bigint; ownerKey: string }
  | { status: 'contended' | 'uncertain' | 'unsupported'; message: string };

export function captureScope(authorityRoot: string): bigint;
export function tryAcquire(
  scopeId: bigint,
  relativeTarget: string,
  activeMarker: string
): AcquireResult;
export function assertOwned(leaseId: bigint): void;
export function publishRelease(leaseId: bigint, releaseRecord: string): void;
export function release(leaseId: bigint): void;
export function abandon(leaseId: bigint): void;
export function closeScope(scopeId: bigint): void;
