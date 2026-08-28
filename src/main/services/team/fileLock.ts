import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  getSqliteTransactionLockDatabasePath,
  type RetainedSqliteTransactionLock,
  tryRetainSqliteTransactionLock,
} from '@main/services/infrastructure/SqliteTransactionLock';

const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;
const LEGACY_SAFE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
const LEGACY_AUTHORITATIVE_MAGIC = 'agent-teams-legacy-authoritative-v1';
const AUTHORITATIVE_MAGIC = 'agent-teams-legacy-authoritative-v2';
const MAX_LOCK_BYTES = 256;
const RANDOM_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EPERM', 'EISDIR', 'EBADF']);

/** Reserved cutover marker; publication requires proof that every old-protocol process is gone. */
export const FILE_LOCK_RETIREMENT_MARKER = '0\n9007199254740991\nagent-teams-sqlite-cutover-v1\n';

export interface FileLockOptions {
  acquireTimeoutMs?: number;
  /** Retained for caller compatibility. Active locks are never reclaimed by age. */
  staleTimeoutMs?: number;
  retryIntervalMs?: number;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface ObservedFile {
  content: string;
  identity: FileIdentity;
}

interface OwnedLock {
  authority: RetainedSqliteTransactionLock;
  canonicalParent: string;
  content: string;
  descriptor: number;
  identity: FileIdentity;
  lockPath: string;
  ownerKey: string;
  parentIdentity: FileIdentity;
  requestedParent: string;
  token: symbol;
}

interface LockTarget {
  canonicalParent: string;
  logicalTarget: string;
  lockPath: string;
  ownerKey: string;
  requestedParent: string;
}

type AcquisitionResult = OwnedLock | 'contended' | 'retry';

type Failure = { error: unknown; status: 'failure' };
type Outcome<T> = { status: 'success'; value: T } | Failure;

const sameProcessOwners = new Map<string, symbol>();
const asyncOwnership = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();

function identity(stats: fs.BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function syncDirectory(directoryPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      code === undefined ||
      !WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(code)
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function resolveLockTarget(filePath: string): LockTarget {
  const requestedLockPath = path.resolve(`${filePath}.lock`);
  const requestedParent = path.dirname(requestedLockPath);
  fs.mkdirSync(requestedParent, { recursive: true, mode: 0o700 });
  const canonicalParent = fs.realpathSync.native(requestedParent);
  const stats = fs.lstatSync(canonicalParent);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe file lock directory: ${requestedParent}`);
  }
  const lockPath = path.join(canonicalParent, path.basename(requestedLockPath));
  return {
    canonicalParent,
    logicalTarget: lockPath.slice(0, -'.lock'.length),
    lockPath,
    ownerKey: lockPath,
    requestedParent,
  };
}

function assertOwned(lock: OwnedLock, ownershipLostMessage: string): void {
  try {
    lock.authority.assertOwned();
    const descriptorStats = fs.fstatSync(lock.descriptor, { bigint: true });
    const parentStats = fs.lstatSync(lock.canonicalParent, { bigint: true });
    const pathStats = fs.lstatSync(lock.lockPath, { bigint: true });
    if (
      fs.realpathSync.native(lock.requestedParent) === lock.canonicalParent &&
      !parentStats.isSymbolicLink() &&
      parentStats.isDirectory() &&
      descriptorStats.isFile() &&
      !pathStats.isSymbolicLink() &&
      pathStats.isFile() &&
      sameIdentity(lock.identity, identity(descriptorStats)) &&
      sameIdentity(lock.identity, identity(pathStats)) &&
      sameIdentity(lock.parentIdentity, identity(parentStats)) &&
      fs.readFileSync(lock.lockPath, 'utf8') === lock.content
    ) {
      return;
    }
  } catch {
    // Missing, replaced, or unreadable paths cannot prove ownership.
  }
  throw new Error(ownershipLostMessage);
}

function uncertain(filePath: string): Error {
  return new Error(`Legacy file lock ownership is uncertain: ${filePath}`);
}

function assertNotOwnedByThisProcess(filePath: string, ownerKey: string): void {
  if (sameProcessOwners.has(ownerKey)) {
    throw new Error(`File lock is already held by this process: ${filePath}`);
  }
}

function assertNotOwnedByAsyncLineage(filePath: string, ownerKey: string): void {
  const inheritedToken = asyncOwnership.getStore()?.get(ownerKey);
  if (inheritedToken !== undefined && sameProcessOwners.get(ownerKey) === inheritedToken) {
    throw new Error(`File lock is already held by this process: ${filePath}`);
  }
}

function inspectBoundedFile(lockPath: string): ObservedFile | 'retry' {
  let descriptor: number | undefined;
  try {
    const pathStatsBefore = fs.lstatSync(lockPath, { bigint: true });
    if (pathStatsBefore.isSymbolicLink() || !pathStatsBefore.isFile()) {
      throw new Error('Lock path is not a regular file');
    }
    descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | NO_FOLLOW);
    const descriptorStatsBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !descriptorStatsBefore.isFile() ||
      !sameIdentity(identity(pathStatsBefore), identity(descriptorStatsBefore)) ||
      descriptorStatsBefore.size > BigInt(MAX_LOCK_BYTES)
    ) {
      throw new Error('Lock identity is ambiguous');
    }

    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    const descriptorStatsAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathStatsAfter = fs.lstatSync(lockPath, { bigint: true });
    if (
      bytesRead > MAX_LOCK_BYTES ||
      descriptorStatsAfter.size !== BigInt(bytesRead) ||
      !descriptorStatsAfter.isFile() ||
      pathStatsAfter.isSymbolicLink() ||
      !pathStatsAfter.isFile() ||
      !sameIdentity(identity(descriptorStatsBefore), identity(descriptorStatsAfter)) ||
      !sameIdentity(identity(descriptorStatsBefore), identity(pathStatsAfter))
    ) {
      throw new Error('Lock changed while it was being read');
    }
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      identity: identity(descriptorStatsBefore),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'retry';
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readBoundedLock(lockPath: string): string | 'retry' {
  const observed = inspectBoundedFile(lockPath);
  return observed === 'retry' ? observed : observed.content;
}

function isActiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

function classifyExistingLock(
  filePath: string,
  lockPath: string
): 'contended' | 'recoverable' | 'retry' {
  try {
    const observed = readBoundedLock(lockPath);
    if (observed === 'retry') return 'retry';
    const lines = observed.split('\n');
    if (
      lines.length !== 5 ||
      lines[4] !== '' ||
      !/^[1-9]\d*$/.test(lines[0]) ||
      lines[1] !== String(LEGACY_SAFE_TIMESTAMP) ||
      (lines[2] !== AUTHORITATIVE_MAGIC && lines[2] !== LEGACY_AUTHORITATIVE_MAGIC) ||
      !RANDOM_UUID_V4.test(lines[3])
    ) {
      throw uncertain(filePath);
    }
    if (lines[2] === AUTHORITATIVE_MAGIC) return 'recoverable';
    const pid = Number(lines[0]);
    if (!Number.isSafeInteger(pid) || !isActiveProcess(pid)) throw uncertain(filePath);
    return 'contended';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'retry';
    throw uncertain(filePath);
  }
}

function preflightExistingLock(
  filePath: string,
  lockPath: string
): 'absent' | 'contended' | 'recoverable' | 'retry' {
  try {
    fs.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw uncertain(filePath);
  }
  return classifyExistingLock(filePath, lockPath);
}

function unlinkExactObserved(lockPath: string, expected: ObservedFile): void {
  let descriptor: number | undefined;
  try {
    const pathStats = fs.lstatSync(lockPath, { bigint: true });
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) throw new Error('Unsafe lock path');
    descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | NO_FOLLOW);
    const descriptorStats = fs.fstatSync(descriptor, { bigint: true });
    if (
      !descriptorStats.isFile() ||
      !sameIdentity(identity(pathStats), identity(descriptorStats)) ||
      !sameIdentity(expected.identity, identity(descriptorStats)) ||
      fs.readFileSync(descriptor, 'utf8') !== expected.content
    ) {
      throw new Error('Lock changed before cleanup');
    }
    fs.unlinkSync(lockPath);
    syncDirectory(path.dirname(lockPath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function unlinkExactContent(lockPath: string, expectedContent: string): void {
  const observed = inspectBoundedFile(lockPath);
  if (observed === 'retry' || observed.content !== expectedContent) {
    throw new Error('Lock changed before cleanup');
  }
  unlinkExactObserved(lockPath, observed);
}

function isRecoverablePublicationPrefix(content: string): boolean {
  let offset = 0;
  const acceptVariablePrefix = (pattern: RegExp): boolean | 'complete' => {
    const newline = content.indexOf('\n', offset);
    const value = newline === -1 ? content.slice(offset) : content.slice(offset, newline);
    if (newline === -1) return value === '' || pattern.test(value);
    if (!pattern.test(value)) return false;
    offset = newline + 1;
    return 'complete';
  };
  const acceptFixedPrefix = (expected: string): boolean | 'complete' => {
    const remaining = content.slice(offset);
    if (remaining.length <= expected.length) return expected.startsWith(remaining);
    if (!remaining.startsWith(`${expected}\n`)) return false;
    offset += expected.length + 1;
    return 'complete';
  };

  const pid = acceptVariablePrefix(/^[1-9]\d*$/);
  if (pid !== 'complete') return pid;
  const timestamp = acceptFixedPrefix(String(LEGACY_SAFE_TIMESTAMP));
  if (timestamp !== 'complete') return timestamp;
  const magic = acceptFixedPrefix(AUTHORITATIVE_MAGIC);
  if (magic !== 'complete') return magic;

  const remaining = content.slice(offset);
  const uuidPrefix = remaining.endsWith('\n') ? remaining.slice(0, -1) : remaining;
  if (remaining.includes('\n') && !remaining.endsWith('\n')) return false;
  if (uuidPrefix.length > 36) return false;
  const uuidTemplate = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  for (let index = 0; index < uuidPrefix.length; index += 1) {
    const character = uuidPrefix[index];
    const template = uuidTemplate[index];
    if (template === '-' || template === '4') {
      if (character !== template) return false;
    } else if (template === 'y') {
      if (!/[89ab]/.test(character)) return false;
    } else if (!/[0-9a-f]/.test(character)) {
      return false;
    }
  }
  return !remaining.endsWith('\n') || uuidPrefix.length === 36;
}

function cleanupPublicationTombstone(publicationPath: string): void {
  try {
    const observed = inspectBoundedFile(publicationPath);
    if (observed === 'retry') return;
    if (!isRecoverablePublicationPrefix(observed.content)) {
      throw new Error(`Unsafe file lock publication tombstone: ${publicationPath}`);
    }
    unlinkExactObserved(publicationPath, observed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function unlinkExactIdentity(lockPath: string, expectedIdentity: FileIdentity): void {
  let descriptor: number | undefined;
  try {
    const pathStats = fs.lstatSync(lockPath, { bigint: true });
    if (
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      !sameIdentity(expectedIdentity, identity(pathStats))
    ) {
      throw new Error('Lock changed before cleanup');
    }
    descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | NO_FOLLOW);
    const descriptorStats = fs.fstatSync(descriptor, { bigint: true });
    if (
      !descriptorStats.isFile() ||
      !sameIdentity(expectedIdentity, identity(descriptorStats)) ||
      !sameIdentity(identity(pathStats), identity(descriptorStats))
    ) {
      throw new Error('Lock changed before cleanup');
    }
    fs.unlinkSync(lockPath);
    syncDirectory(path.dirname(lockPath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function cleanupExactIdentity(lockPath: string, expectedIdentity: FileIdentity): void {
  try {
    unlinkExactIdentity(lockPath, expectedIdentity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function unlinkOwnedPublication(
  publicationPath: string,
  descriptor: number,
  expectedIdentity: FileIdentity
): void {
  const descriptorStats = fs.fstatSync(descriptor, { bigint: true });
  const pathStats = fs.lstatSync(publicationPath, { bigint: true });
  if (
    !descriptorStats.isFile() ||
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    !sameIdentity(expectedIdentity, identity(descriptorStats)) ||
    !sameIdentity(expectedIdentity, identity(pathStats))
  ) {
    throw new Error('Lock changed before cleanup');
  }
  fs.unlinkSync(publicationPath);
  syncDirectory(path.dirname(publicationPath));
}

function cleanupOwnedPublication(
  publicationPath: string,
  descriptor: number | undefined,
  expectedIdentity: FileIdentity
): void {
  try {
    if (descriptor === undefined) cleanupExactIdentity(publicationPath, expectedIdentity);
    else unlinkOwnedPublication(publicationPath, descriptor, expectedIdentity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

interface ContextualFailure {
  context: string;
  failure: Failure;
}

function captureCleanup(context: string, action: () => void): ContextualFailure | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return { context, failure: { error, status: 'failure' } };
  }
}

function throwContextualFailures(failures: ContextualFailure[], message: string): never | void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0].failure.error;
  const errors = failures.map(({ context, failure }) =>
    contextualizeUndefinedFailure(failure, context)
  );
  throw new AggregateError(errors, message, { cause: errors[0] });
}

function tryAcquire(
  filePath: string,
  target: LockTarget,
  sameProcessContention: 'reject' | 'wait'
): AcquisitionResult {
  const { lockPath, canonicalParent, logicalTarget, ownerKey, requestedParent } = target;
  if (sameProcessOwners.has(ownerKey)) {
    if (sameProcessContention === 'wait') return 'contended';
    assertNotOwnedByThisProcess(filePath, ownerKey);
  }
  const preflight = preflightExistingLock(filePath, lockPath);
  if (preflight === 'contended' || preflight === 'retry') return preflight;
  const ownershipLostMessage = `File lock ownership was lost: ${filePath}`;
  const authority = tryRetainSqliteTransactionLock(
    getSqliteTransactionLockDatabasePath(logicalTarget),
    ownershipLostMessage
  );
  if (!authority) return 'contended';
  const token = Symbol(lockPath);
  const content = `${process.pid}\n${LEGACY_SAFE_TIMESTAMP}\n${AUTHORITATIVE_MAGIC}\n${randomUUID()}\n`;
  const publicationPath = `${lockPath}.publishing`;
  let descriptor: number | undefined;
  let publicationIdentity: FileIdentity | undefined;
  let authoritySettled = false;
  try {
    cleanupPublicationTombstone(publicationPath);
    descriptor = fs.openSync(publicationPath, 'wx', 0o600);
    const openedStats = fs.fstatSync(descriptor, { bigint: true });
    if (!openedStats.isFile()) throw new Error(`Unsafe file lock: ${publicationPath}`);
    publicationIdentity = identity(openedStats);
  } catch (error) {
    const failures: ContextualFailure[] = [
      { context: 'File lock acquisition', failure: { error, status: 'failure' } },
    ];
    const closeFailure = captureCleanup('File lock descriptor close', () => {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
    });
    if (closeFailure) failures.push(closeFailure);
    const publicationFailure = captureCleanup('File lock publication cleanup', () => {
      if (publicationIdentity !== undefined) {
        cleanupOwnedPublication(publicationPath, descriptor, publicationIdentity);
      }
    });
    if (publicationFailure) failures.push(publicationFailure);
    const authorityFailure = captureCleanup('File lock authority release', () =>
      authority.release()
    );
    if (authorityFailure) failures.push(authorityFailure);
    throwContextualFailures(failures, 'File lock acquisition and cleanup failed');
    throw error;
  }
  const ownedDescriptor = descriptor as number;
  const ownedPublicationIdentity = publicationIdentity as FileIdentity;

  try {
    fs.writeFileSync(ownedDescriptor, content, 'utf8');
    fs.fsyncSync(ownedDescriptor);
    const stats = fs.fstatSync(ownedDescriptor, { bigint: true });
    if (!stats.isFile() || !sameIdentity(ownedPublicationIdentity, identity(stats))) {
      throw new Error(`Unsafe file lock: ${publicationPath}`);
    }
    try {
      fs.linkSync(publicationPath, lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EISDIR') throw error;
      const failures: ContextualFailure[] = [];
      const closeFailure = captureCleanup('File lock descriptor close', () => {
        fs.closeSync(ownedDescriptor);
        descriptor = undefined;
      });
      if (closeFailure) failures.push(closeFailure);
      const publicationFailure = captureCleanup('File lock publication cleanup', () =>
        cleanupOwnedPublication(publicationPath, descriptor, ownedPublicationIdentity)
      );
      if (publicationFailure) failures.push(publicationFailure);

      let classification: 'contended' | 'retry' = 'retry';
      const classificationFailure = captureCleanup('File lock contention recovery', () => {
        const observedClassification = classifyExistingLock(filePath, lockPath);
        if (observedClassification === 'recoverable') {
          const staleContent = readBoundedLock(lockPath);
          if (staleContent !== 'retry') unlinkExactContent(lockPath, staleContent);
          classification = 'retry';
        } else {
          classification = observedClassification;
        }
      });
      if (classificationFailure) failures.push(classificationFailure);
      const authorityFailure = captureCleanup('File lock authority release', () =>
        authority.release()
      );
      if (authorityFailure) failures.push(authorityFailure);
      authoritySettled = true;
      throwContextualFailures(failures, 'File lock contention cleanup failed');
      return classification;
    }
    unlinkOwnedPublication(publicationPath, ownedDescriptor, ownedPublicationIdentity);
    const lock: OwnedLock = {
      authority,
      canonicalParent,
      content,
      descriptor: ownedDescriptor,
      identity: identity(stats),
      lockPath,
      ownerKey,
      parentIdentity: identity(fs.lstatSync(canonicalParent, { bigint: true })),
      requestedParent,
      token,
    };
    assertOwned(lock, ownershipLostMessage);
    sameProcessOwners.set(ownerKey, token);
    return lock;
  } catch (error) {
    if (authoritySettled) throw error;
    const failures: ContextualFailure[] = [
      { context: 'File lock acquisition', failure: { error, status: 'failure' } },
    ];
    const closeFailure = captureCleanup('File lock descriptor close', () => {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
    });
    if (closeFailure) failures.push(closeFailure);
    const publicationFailure = captureCleanup('File lock publication cleanup', () => {
      if (publicationIdentity !== undefined) {
        cleanupOwnedPublication(publicationPath, descriptor, publicationIdentity);
      }
    });
    if (publicationFailure) failures.push(publicationFailure);
    const authorityFailure = captureCleanup('File lock authority release', () =>
      authority.release()
    );
    if (authorityFailure) failures.push(authorityFailure);
    throwContextualFailures(failures, 'File lock acquisition and cleanup failed');
    throw error;
  }
}

function release(lock: OwnedLock, ownershipLostMessage: string): void {
  let cleanupOutcome: Outcome<void>;
  try {
    assertOwned(lock, ownershipLostMessage);
    fs.unlinkSync(lock.lockPath);
    syncDirectory(path.dirname(lock.lockPath));
    cleanupOutcome = { status: 'success', value: undefined };
  } catch (error) {
    cleanupOutcome = { error, status: 'failure' };
  }

  let closeOutcome: Outcome<void>;
  try {
    fs.closeSync(lock.descriptor);
    closeOutcome = { status: 'success', value: undefined };
  } catch (error) {
    closeOutcome = { error, status: 'failure' };
  } finally {
    if (sameProcessOwners.get(lock.ownerKey) === lock.token) {
      sameProcessOwners.delete(lock.ownerKey);
    }
  }

  let authorityOutcome: Outcome<void>;
  try {
    lock.authority.release();
    authorityOutcome = { status: 'success', value: undefined };
  } catch (error) {
    authorityOutcome = { error, status: 'failure' };
  }

  if (cleanupOutcome.status === 'failure' && closeOutcome.status === 'failure') {
    if (authorityOutcome.status === 'failure') {
      const cleanupError = contextualizeUndefinedFailure(cleanupOutcome, 'File lock cleanup');
      const closeError = contextualizeUndefinedFailure(closeOutcome, 'File lock descriptor close');
      const authorityError = contextualizeUndefinedFailure(
        authorityOutcome,
        'File lock authority release'
      );
      throw new AggregateError(
        [cleanupError, closeError, authorityError],
        'File lock cleanup, descriptor close, and authority release all failed',
        { cause: cleanupError }
      );
    }
    combineFailures(
      cleanupOutcome,
      closeOutcome,
      'File lock cleanup and descriptor close both failed',
      'File lock cleanup',
      'File lock descriptor close'
    );
  }
  if (cleanupOutcome.status === 'failure' && authorityOutcome.status === 'failure') {
    combineFailures(
      cleanupOutcome,
      authorityOutcome,
      'File lock cleanup and authority release both failed',
      'File lock cleanup',
      'File lock authority release'
    );
  }
  if (closeOutcome.status === 'failure' && authorityOutcome.status === 'failure') {
    combineFailures(
      closeOutcome,
      authorityOutcome,
      'File lock descriptor close and authority release both failed',
      'File lock descriptor close',
      'File lock authority release'
    );
  }
  if (cleanupOutcome.status === 'failure') throw cleanupOutcome.error;
  if (closeOutcome.status === 'failure') throw closeOutcome.error;
  if (authorityOutcome.status === 'failure') throw authorityOutcome.error;
}

function contextualizeUndefinedFailure(failure: Failure, context: string): unknown {
  if (failure.error !== undefined) return failure.error;
  return new Error(`${context} failed by throwing undefined`, { cause: failure.error });
}

function combineFailures(
  firstFailure: Failure,
  secondFailure: Failure,
  message: string,
  firstContext: string,
  secondContext: string
): never {
  const firstError = contextualizeUndefinedFailure(firstFailure, firstContext);
  const secondError = contextualizeUndefinedFailure(secondFailure, secondContext);
  throw new AggregateError([firstError, secondError], message, { cause: firstError });
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // The wait is bounded. Same-process async ownership is rejected below.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeout(filePath: string): Error {
  return new Error(`File lock timeout: ${filePath}`);
}

export function withFileLockSync<T>(
  filePath: string,
  fn: () => T,
  options: FileLockOptions = {}
): T {
  const target = resolveLockTarget(filePath);
  assertNotOwnedByThisProcess(filePath, target.ownerKey);
  const deadline = Date.now() + (options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);
  let acquisition = tryAcquire(filePath, target, 'reject');
  while (acquisition === 'contended' || acquisition === 'retry') {
    if (acquisition === 'retry') {
      acquisition = tryAcquire(filePath, target, 'reject');
      if (acquisition === 'retry' && Date.now() >= deadline) throw timeout(filePath);
      continue;
    }
    if (Date.now() >= deadline) throw timeout(filePath);
    sleepSync(Math.min(options.retryIntervalMs ?? RETRY_INTERVAL_MS, deadline - Date.now()));
    acquisition = tryAcquire(filePath, target, 'reject');
  }
  const lock = acquisition;

  let operationOutcome: Outcome<T>;
  try {
    assertOwned(lock, `File lock ownership was lost: ${filePath}`);
    operationOutcome = { status: 'success', value: fn() };
  } catch (error) {
    operationOutcome = { error, status: 'failure' };
  }
  let releaseOutcome: Outcome<void>;
  try {
    release(lock, `File lock ownership was lost: ${filePath}`);
    releaseOutcome = { status: 'success', value: undefined };
  } catch (error) {
    releaseOutcome = { error, status: 'failure' };
  }
  if (operationOutcome.status === 'failure' && releaseOutcome.status === 'failure') {
    combineFailures(
      operationOutcome,
      releaseOutcome,
      'File lock operation and cleanup both failed',
      'File lock operation',
      'File lock cleanup'
    );
  }
  if (operationOutcome.status === 'failure') throw operationOutcome.error;
  if (releaseOutcome.status === 'failure') throw releaseOutcome.error;
  return operationOutcome.value;
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const target = resolveLockTarget(filePath);
  assertNotOwnedByAsyncLineage(filePath, target.ownerKey);
  const deadline = Date.now() + (options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);
  let acquisition = tryAcquire(filePath, target, 'wait');
  while (acquisition === 'contended' || acquisition === 'retry') {
    if (acquisition === 'retry') {
      acquisition = tryAcquire(filePath, target, 'wait');
      if (acquisition === 'retry' && Date.now() >= deadline) throw timeout(filePath);
      continue;
    }
    if (Date.now() >= deadline) throw timeout(filePath);
    await delay(Math.min(options.retryIntervalMs ?? RETRY_INTERVAL_MS, deadline - Date.now()));
    acquisition = tryAcquire(filePath, target, 'wait');
  }
  const lock = acquisition;

  let operationOutcome: Outcome<T>;
  try {
    const ownership = new Map(asyncOwnership.getStore());
    ownership.set(target.ownerKey, lock.token);
    operationOutcome = {
      status: 'success',
      value: await asyncOwnership.run(ownership, async () => {
        assertOwned(lock, `File lock ownership was lost: ${filePath}`);
        return await fn();
      }),
    };
  } catch (error) {
    operationOutcome = { error, status: 'failure' };
  }
  let releaseOutcome: Outcome<void>;
  try {
    release(lock, `File lock ownership was lost: ${filePath}`);
    releaseOutcome = { status: 'success', value: undefined };
  } catch (error) {
    releaseOutcome = { error, status: 'failure' };
  }
  if (operationOutcome.status === 'failure' && releaseOutcome.status === 'failure') {
    combineFailures(
      operationOutcome,
      releaseOutcome,
      'File lock operation and cleanup both failed',
      'File lock operation',
      'File lock cleanup'
    );
  }
  if (operationOutcome.status === 'failure') throw operationOutcome.error;
  if (releaseOutcome.status === 'failure') throw releaseOutcome.error;
  return operationOutcome.value;
}
