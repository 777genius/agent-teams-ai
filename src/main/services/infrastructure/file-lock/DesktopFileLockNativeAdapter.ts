import { createRequire } from 'node:module';

import type { FileLockNativeAcquireResult, FileLockNativePort } from './FileLockNativePort';

const NATIVE_PACKAGE = '@claude-teams/desktop-file-lock-native';

interface NativeExports {
  captureScope(authorityRoot: string): bigint;
  tryAcquire(scopeId: bigint, relativeTarget: string, activeMarker: string): unknown;
  assertOwned(leaseId: bigint): void;
  publishRelease(leaseId: bigint, record: string): void;
  release(leaseId: bigint): void;
  abandon(leaseId: bigint): void;
  closeScope(scopeId: bigint): void;
}

function assertAcquireResult(value: unknown): FileLockNativeAcquireResult {
  if (value === 'contended' || value === 'uncertain' || value === 'unsupported') {
    return { status: value };
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Desktop file-lock native addon returned an invalid acquisition result');
  }
  const result = value as Record<string, unknown>;
  const status = result.status ?? result.kind;
  if (
    (status === 'acquired' || status === undefined) &&
    typeof result.leaseId === 'bigint' &&
    typeof result.ownerKey === 'string' &&
    result.ownerKey.length > 0
  ) {
    return { status: 'acquired', leaseId: result.leaseId, ownerKey: result.ownerKey };
  }
  if (status === 'contended' || status === 'uncertain' || status === 'unsupported') {
    return { status };
  }
  throw new Error('Desktop file-lock native addon returned an invalid acquisition result');
}

function loadNativeExports(): NativeExports {
  const require = createRequire(import.meta.url);
  let loaded: unknown;
  try {
    loaded = require(NATIVE_PACKAGE) as unknown;
  } catch (error) {
    throw new Error('Desktop file-lock native addon is unavailable; mutation denied', {
      cause: error,
    });
  }
  if (!loaded || typeof loaded !== 'object') {
    throw new Error('Desktop file-lock native addon has no usable capabilities');
  }
  const candidate = loaded as Record<string, unknown>;
  for (const name of [
    'captureScope',
    'tryAcquire',
    'assertOwned',
    'publishRelease',
    'release',
    'abandon',
    'closeScope',
  ]) {
    if (typeof candidate[name] !== 'function') {
      throw new Error(`Desktop file-lock native addon is missing capability: ${name}`);
    }
  }
  return candidate as unknown as NativeExports;
}

export class DesktopFileLockNativeAdapter implements FileLockNativePort {
  private exports: NativeExports | undefined;

  private get native(): NativeExports {
    return (this.exports ??= loadNativeExports());
  }

  captureScope(authorityRoot: string): bigint {
    return this.native.captureScope(authorityRoot);
  }

  tryAcquire(
    scopeId: bigint,
    relativeTarget: string,
    activeMarker: string
  ): FileLockNativeAcquireResult {
    return assertAcquireResult(this.native.tryAcquire(scopeId, relativeTarget, activeMarker));
  }

  assertOwned(leaseId: bigint): void {
    this.native.assertOwned(leaseId);
  }

  publishRelease(leaseId: bigint, record: string): void {
    this.native.publishRelease(leaseId, record);
  }

  release(leaseId: bigint): void {
    this.native.release(leaseId);
  }

  abandon(leaseId: bigint): void {
    this.native.abandon(leaseId);
  }

  closeScope(scopeId: bigint): void {
    this.native.closeScope(scopeId);
  }
}
