import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import {
  buildFileLockV3Record,
  DesktopFileLockNativeAdapter,
  type FileLockNativeAcquireResult,
  type FileLockNativePort,
} from '@main/services/infrastructure/file-lock';

const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;

export interface FileLockTarget {
  authorityRoot: string;
  targetPath: string;
}

export function fileLockTarget(authorityRoot: string, targetPath: string): FileLockTarget {
  return { authorityRoot, targetPath };
}

export interface FileLockOptions {
  acquireTimeoutMs?: number;
  /** Retained for caller compatibility. Native authority is never reclaimed by age. */
  staleTimeoutMs?: number;
  retryIntervalMs?: number;
}

interface ResolvedTarget {
  authorityRoot: string;
  displayPath: string;
  lineageKey: string;
  relativeTarget: string;
}

interface OwnedLease {
  leaseId: bigint;
  marker: string;
  ownerKey: string;
  scopeId: bigint;
  token: symbol;
}

type Failure = { context: string; error: unknown };
type OperationOutcome<T> = { status: 'success'; value: T } | { status: 'failure'; error: unknown };

const sameProcessOwners = new Map<string, symbol>();
const asyncOwnership = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();
const defaultNativePort = new DesktopFileLockNativeAdapter();

function resolveTarget(target: FileLockTarget): ResolvedTarget {
  if (
    !target ||
    typeof target.authorityRoot !== 'string' ||
    typeof target.targetPath !== 'string'
  ) {
    throw new TypeError('File lock requires an explicit authorityRoot and targetPath');
  }
  if (!path.isAbsolute(target.authorityRoot) || !path.isAbsolute(target.targetPath)) {
    throw new Error('File lock authorityRoot and targetPath must be absolute');
  }
  const authorityRoot = path.resolve(target.authorityRoot);
  const displayPath = path.resolve(target.targetPath);
  const relativeFromRoot = path.relative(authorityRoot, displayPath);
  if (
    relativeFromRoot === '..' ||
    relativeFromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error(`File lock target is outside its authority root: ${target.targetPath}`);
  }
  const relativeTarget = relativeFromRoot || '.';
  return {
    authorityRoot,
    displayPath,
    relativeTarget,
    lineageKey: `${authorityRoot}\0${relativeTarget}`,
  };
}

function validateDuration(value: number | undefined, fallback: number, name: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return duration;
}

function contextualize(error: unknown, context: string): unknown {
  return error === undefined
    ? new Error(`${context} failed by throwing undefined`, { cause: error })
    : error;
}

function throwFailures(failures: Failure[], message: string): void {
  if (failures.length === 0) return;
  const errors = failures.map(({ context, error }) => contextualize(error, context));
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message, { cause: errors[0] });
}

function captureFailure(failures: Failure[], context: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    failures.push({ context, error });
  }
}

function unsupported(target: ResolvedTarget, status: 'uncertain' | 'unsupported'): Error {
  return new Error(
    status === 'unsupported'
      ? `File lock native authority is unsupported; mutation denied: ${target.displayPath}`
      : `File lock ownership is uncertain; mutation denied: ${target.displayPath}`
  );
}

function timeout(target: ResolvedTarget): Error {
  return new Error(`File lock timeout: ${target.displayPath}`);
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Bounded synchronous compatibility wrapper.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function releaseOwner(lease: OwnedLease): void {
  if (sameProcessOwners.get(lease.ownerKey) === lease.token) {
    sameProcessOwners.delete(lease.ownerKey);
  }
}

function acquireOnce(
  port: FileLockNativePort,
  target: ResolvedTarget,
  scopeId: bigint,
  marker: string
): FileLockNativeAcquireResult {
  const result = port.tryAcquire(scopeId, target.relativeTarget, marker);
  if (result.status === 'uncertain' || result.status === 'unsupported') {
    throw unsupported(target, result.status);
  }
  return result;
}

function registerLease(
  port: FileLockNativePort,
  target: ResolvedTarget,
  scopeId: bigint,
  marker: string,
  result: Extract<FileLockNativeAcquireResult, { status: 'acquired' }>
): OwnedLease {
  const token = Symbol(result.ownerKey);
  if (sameProcessOwners.has(result.ownerKey)) {
    const failures: Failure[] = [
      {
        context: 'File lock acquisition',
        error: new Error(`File lock is already held by this process: ${target.displayPath}`),
      },
    ];
    captureFailure(failures, 'File lock abandon', () => port.abandon(result.leaseId));
    captureFailure(failures, 'File lock authority release', () => port.release(result.leaseId));
    captureFailure(failures, 'File lock scope close', () => port.closeScope(scopeId));
    throwFailures(failures, 'File lock duplicate acquisition and cleanup failed');
  }
  sameProcessOwners.set(result.ownerKey, token);
  return { leaseId: result.leaseId, marker, ownerKey: result.ownerKey, scopeId, token };
}

function settleLease<T>(
  port: FileLockNativePort,
  lease: OwnedLease,
  operation: OperationOutcome<T>
): T {
  const failures: Failure[] = [];
  if (operation.status === 'failure') {
    failures.push({ context: 'File lock operation', error: operation.error });
    captureFailure(failures, 'File lock abandon', () => port.abandon(lease.leaseId));
  } else {
    try {
      port.publishRelease(lease.leaseId, lease.marker);
    } catch (error) {
      failures.push({ context: 'File lock release record publication', error });
      captureFailure(failures, 'File lock abandon after publication failure', () =>
        port.abandon(lease.leaseId)
      );
    }
  }
  captureFailure(failures, 'File lock authority release', () => port.release(lease.leaseId));
  releaseOwner(lease);
  captureFailure(failures, 'File lock scope close', () => port.closeScope(lease.scopeId));
  throwFailures(failures, 'File lock operation or cleanup failed');
  return (operation as { status: 'success'; value: T }).value;
}

function closeUnacquiredScope(
  port: FileLockNativePort,
  scopeId: bigint,
  primaryError: unknown
): never {
  const failures: Failure[] = [{ context: 'File lock acquisition', error: primaryError }];
  captureFailure(failures, 'File lock scope close', () => port.closeScope(scopeId));
  throwFailures(failures, 'File lock acquisition or scope cleanup failed');
  throw new Error('File lock acquisition failed without an error');
}

export interface FileLockApi {
  withFileLockSync<T>(target: FileLockTarget, fn: () => T, options?: FileLockOptions): T;
  withFileLock<T>(
    target: FileLockTarget,
    fn: () => Promise<T>,
    options?: FileLockOptions
  ): Promise<T>;
}

export function createFileLockApi(port: FileLockNativePort): FileLockApi {
  return {
    withFileLockSync<T>(input: FileLockTarget, fn: () => T, options: FileLockOptions = {}): T {
      const target = resolveTarget(input);
      if (asyncOwnership.getStore()?.has(target.lineageKey)) {
        throw new Error(`File lock is already held by this async lineage: ${target.displayPath}`);
      }
      const timeoutMs = validateDuration(
        options.acquireTimeoutMs,
        ACQUIRE_TIMEOUT_MS,
        'acquireTimeoutMs'
      );
      const retryMs = validateDuration(
        options.retryIntervalMs,
        RETRY_INTERVAL_MS,
        'retryIntervalMs'
      );
      const scopeId = port.captureScope(target.authorityRoot);
      const marker = buildFileLockV3Record(process.pid, randomUUID());
      const deadline = Date.now() + timeoutMs;
      let result: FileLockNativeAcquireResult;
      try {
        result = acquireOnce(port, target, scopeId, marker);
        while (result.status === 'contended') {
          if (Date.now() >= deadline) throw timeout(target);
          sleepSync(Math.min(retryMs, Math.max(0, deadline - Date.now())));
          result = acquireOnce(port, target, scopeId, marker);
        }
      } catch (error) {
        closeUnacquiredScope(port, scopeId, error);
      }
      if (result.status !== 'acquired') {
        closeUnacquiredScope(port, scopeId, timeout(target));
      }
      const lease = registerLease(port, target, scopeId, marker, result);
      let operation: OperationOutcome<T>;
      try {
        port.assertOwned(lease.leaseId);
        operation = { status: 'success', value: fn() };
      } catch (error) {
        operation = { status: 'failure', error };
      }
      return settleLease(port, lease, operation);
    },

    async withFileLock<T>(
      input: FileLockTarget,
      fn: () => Promise<T>,
      options: FileLockOptions = {}
    ): Promise<T> {
      const target = resolveTarget(input);
      if (asyncOwnership.getStore()?.has(target.lineageKey)) {
        throw new Error(`File lock is already held by this async lineage: ${target.displayPath}`);
      }
      const timeoutMs = validateDuration(
        options.acquireTimeoutMs,
        ACQUIRE_TIMEOUT_MS,
        'acquireTimeoutMs'
      );
      const retryMs = validateDuration(
        options.retryIntervalMs,
        RETRY_INTERVAL_MS,
        'retryIntervalMs'
      );
      const scopeId = port.captureScope(target.authorityRoot);
      const marker = buildFileLockV3Record(process.pid, randomUUID());
      const deadline = Date.now() + timeoutMs;
      let result: FileLockNativeAcquireResult;
      try {
        result = acquireOnce(port, target, scopeId, marker);
        while (result.status === 'contended') {
          if (Date.now() >= deadline) throw timeout(target);
          await delay(Math.min(retryMs, Math.max(0, deadline - Date.now())));
          result = acquireOnce(port, target, scopeId, marker);
        }
      } catch (error) {
        closeUnacquiredScope(port, scopeId, error);
      }
      if (result.status !== 'acquired') {
        closeUnacquiredScope(port, scopeId, timeout(target));
      }
      const lease = registerLease(port, target, scopeId, marker, result);
      let operation: OperationOutcome<T>;
      try {
        const ownership = new Map(asyncOwnership.getStore());
        ownership.set(target.lineageKey, lease.token);
        operation = {
          status: 'success',
          value: await asyncOwnership.run(ownership, async () => {
            port.assertOwned(lease.leaseId);
            return await fn();
          }),
        };
      } catch (error) {
        operation = { status: 'failure', error };
      }
      return settleLease(port, lease, operation);
    },
  };
}

const defaultApi = createFileLockApi(defaultNativePort);

export function withFileLockSync<T>(
  target: FileLockTarget,
  fn: () => T,
  options?: FileLockOptions
): T {
  return defaultApi.withFileLockSync(target, fn, options);
}

export function withFileLock<T>(
  target: FileLockTarget,
  fn: () => Promise<T>,
  options?: FileLockOptions
): Promise<T> {
  return defaultApi.withFileLock(target, fn, options);
}
