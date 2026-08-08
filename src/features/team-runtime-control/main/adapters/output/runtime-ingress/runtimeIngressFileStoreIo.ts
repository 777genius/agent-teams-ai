import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, win32 as windowsPath } from 'node:path';

import { isNodeError } from './runtimeIngressDurableState';

// prettier-ignore
export interface RuntimeIngressFileStoreLimits { readonly lockAcquireTimeoutMs: number; readonly lockRetryDelayMs: number }

export interface RuntimeIngressStorePaths {
  readonly configuredParent: string;
  readonly parent: string;
  readonly parentDevice: number;
  readonly parentInode: number;
  readonly snapshot: string;
  readonly lock: string;
  readonly lockGuard: string;
}

// prettier-ignore
export interface RuntimeIngressStoreLock { assertOwned(): Promise<void>; publishTemporaryFile(temporaryPath: string, snapshotPath: string): Promise<void>; release(): Promise<void> }

// prettier-ignore
export interface RuntimeIngressProcessIdentityProbe { readonly currentPid: number; isProcessAlive(pid: number): boolean; readProcessInstanceId(pid: number): Promise<string | null> }

// prettier-ignore
export interface RuntimeIngressLockFaultInjector { beforeSnapshotRename(loseHelperAuthority: () => Promise<void>): Promise<void> }

interface StoreLockRecord {
  readonly lockVersion: 2;
  readonly ownerPid: number;
  readonly ownerInstanceId: string;
  readonly token: string;
}

interface StoreLockObservation {
  readonly record: StoreLockRecord | null;
  readonly device: number;
  readonly inode: number;
}

// prettier-ignore
interface WindowsLockHelperTemp { readonly path: string; readonly token: string; readonly device: number; readonly inode: number }

// prettier-ignore
interface RuntimeIngressOsLock { assertHeld(): Promise<void>; publishTemporaryFile(temporaryPath: string, snapshotPath: string): Promise<void>; release(): Promise<void> }

export async function resolveStorePaths(snapshotPath: string): Promise<RuntimeIngressStorePaths> {
  const configuredParent = dirname(snapshotPath);
  await mkdir(configuredParent, { recursive: true, mode: 0o700 });
  const parent = await realpath(configuredParent);
  const identity = await lstat(configuredParent);
  if (!identity.isDirectory() || identity.isSymbolicLink() || (await realpath(parent)) !== parent) {
    throw new Error('runtime-ingress-snapshot-parent-invalid');
  }
  return {
    configuredParent,
    parent,
    parentDevice: identity.dev,
    parentInode: identity.ino,
    snapshot: join(parent, basename(snapshotPath)),
    lock: join(parent, `.${basename(snapshotPath)}.lock`),
    lockGuard: join(parent, `.${basename(snapshotPath)}.lock.guard`),
  };
}

export async function assertStoreParentIdentity(paths: RuntimeIngressStorePaths): Promise<void> {
  const identity = await lstat(paths.configuredParent);
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.dev !== paths.parentDevice ||
    identity.ino !== paths.parentInode ||
    (await realpath(paths.configuredParent)) !== paths.parent
  ) {
    throw new Error('runtime-ingress-snapshot-parent-substituted');
  }
}

export async function acquireStoreLock(
  paths: RuntimeIngressStorePaths,
  limits: RuntimeIngressFileStoreLimits,
  processIdentity: RuntimeIngressProcessIdentityProbe = SYSTEM_PROCESS_IDENTITY,
  faultInjector?: RuntimeIngressLockFaultInjector
): Promise<RuntimeIngressStoreLock> {
  const startedAt = Date.now();
  const ownerInstanceId = await processIdentity.readProcessInstanceId(processIdentity.currentPid);
  if (!ownerInstanceId || !PROCESS_INSTANCE_ID_PATTERN.test(ownerInstanceId)) {
    throw new Error('runtime-ingress-store-process-identity-unavailable');
  }
  const record = Object.freeze({
    lockVersion: 2,
    ownerPid: processIdentity.currentPid,
    ownerInstanceId,
    token: randomUUID(),
  }) satisfies StoreLockRecord;
  const candidatePath = join(paths.parent, `.${basename(paths.lock)}.${record.token}.candidate`);
  await writeLockCandidate(candidatePath, record);
  try {
    for (;;) {
      await assertStoreParentIdentity(paths);
      const osLock = await tryAcquireRuntimeIngressOsLock(paths, record.token);
      if (osLock) {
        let retained = false;
        try {
          const owner = await readOptionalLockObservation(paths.lock);
          if (
            (owner?.record === null ||
              owner?.record === undefined ||
              !(await isCurrentLockOwner(owner.record, processIdentity))) &&
            (await publishLockCandidate(paths, candidatePath, owner, processIdentity))
          ) {
            retained = true;
            return createStoreLock(paths, record, osLock, faultInjector);
          }
        } finally {
          if (!retained) await osLock.release();
        }
      }
      if (Date.now() - startedAt >= limits.lockAcquireTimeoutMs) {
        throw new Error('runtime-ingress-store-lock-timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, limits.lockRetryDelayMs));
    }
  } finally {
    try {
      await unlink(candidatePath);
    } catch {
      // A complete private candidate is not lock authority.
    }
  }
}

export async function readBoundedSnapshotFile(
  paths: RuntimeIngressStorePaths,
  maximumBytes: number
): Promise<Uint8Array | null> {
  await assertStoreParentIdentity(paths);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(paths.snapshot, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    assertPrivateFile(before, 1, maximumBytes);
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      offset > maximumBytes
    ) {
      throw new Error('runtime-ingress-snapshot-read-raced');
    }
    const finalComponent = await lstat(paths.snapshot);
    if (
      finalComponent.isSymbolicLink() ||
      finalComponent.dev !== before.dev ||
      finalComponent.ino !== before.ino
    ) {
      throw new Error('runtime-ingress-snapshot-final-component-substituted');
    }
    await assertStoreParentIdentity(paths);
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function publishSnapshotFile(
  paths: RuntimeIngressStorePaths,
  serialized: string,
  lock: RuntimeIngressStoreLock
): Promise<void> {
  await assertStoreParentIdentity(paths);
  const temporaryPath = join(paths.parent, `.${basename(paths.snapshot)}.${randomUUID()}.tmp`);
  let renamed = false;
  let temporaryIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      temporaryIdentity = await handle.stat();
      assertPrivateFile(temporaryIdentity, 1, Buffer.byteLength(serialized, 'utf8'));
    } finally {
      await handle.close();
    }
    await lock.publishTemporaryFile(temporaryPath, paths.snapshot);
    renamed = true;
    await assertStoreParentIdentity(paths);
    const published = await lstat(paths.snapshot);
    assertPrivateFile(published, 1, Buffer.byteLength(serialized, 'utf8'));
    if (published.dev !== temporaryIdentity?.dev || published.ino !== temporaryIdentity?.ino) {
      throw new Error('runtime-ingress-snapshot-publication-substituted');
    }
  } finally {
    if (!renamed) {
      try {
        await unlink(temporaryPath);
      } catch {
        // An unpublished same-directory mode-0600 temporary is not authority.
      }
    }
  }
}

function createStoreLock(
  paths: RuntimeIngressStorePaths,
  record: StoreLockRecord,
  osLock: RuntimeIngressOsLock,
  faultInjector?: RuntimeIngressLockFaultInjector
): RuntimeIngressStoreLock {
  const assertOwned = async (): Promise<void> => {
    await osLock.assertHeld();
    await assertStoreParentIdentity(paths);
    const current = await readLockRecord(paths.lock);
    if (
      current.ownerPid !== record.ownerPid ||
      current.ownerInstanceId !== record.ownerInstanceId ||
      current.token !== record.token ||
      current.lockVersion !== record.lockVersion
    ) {
      throw new Error('runtime-ingress-store-lock-ownership-lost');
    }
  };
  let released = false;
  return {
    assertOwned,
    publishTemporaryFile: async (temporaryPath, snapshotPath) => {
      if (
        dirname(temporaryPath) !== paths.parent ||
        ![paths.snapshot, `${paths.snapshot}.recovery`].includes(snapshotPath)
      ) {
        throw new Error('runtime-ingress-snapshot-publication-path-invalid');
      }
      await assertOwned();
      await faultInjector?.beforeSnapshotRename(async () => osLock.release());
      await osLock.publishTemporaryFile(temporaryPath, snapshotPath);
      await assertOwned();
    },
    release: async () => {
      if (released) throw new Error('runtime-ingress-store-lock-already-released');
      released = true;
      let failure: Error | undefined;
      try {
        await assertOwned();
        await unlink(paths.lock);
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new Error('runtime-ingress-store-lock-release-failed', { cause: error });
      } finally {
        await osLock.release();
      }
      if (failure) throw failure;
    },
  };
}

async function readLockRecord(path: string): Promise<StoreLockRecord> {
  const observation = await readLockObservation(path);
  if (!observation.record) throw new Error('runtime-ingress-store-lock-invalid');
  return observation.record;
}

async function readLockObservation(path: string): Promise<StoreLockObservation> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    assertPrivateFile(identity, 0, 512, true);
    const bytes = Buffer.alloc(identity.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const finalComponent = await lstat(path);
    if (
      offset !== identity.size ||
      after.size !== identity.size ||
      after.dev !== identity.dev ||
      after.ino !== identity.ino ||
      finalComponent.isSymbolicLink() ||
      finalComponent.dev !== identity.dev ||
      finalComponent.ino !== identity.ino
    ) {
      throw new Error('runtime-ingress-store-lock-read-raced');
    }
    return {
      record: parseLockRecord(bytes.subarray(0, offset).toString('utf8')),
      device: identity.dev,
      inode: identity.ino,
    };
  } finally {
    await handle.close();
  }
}

async function writeLockCandidate(path: string, record: StoreLockRecord): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
    assertPrivateFile(await handle.stat(), 1, 512);
  } finally {
    await handle.close();
  }
}

async function readOptionalLockObservation(path: string): Promise<StoreLockObservation | null> {
  try {
    return await readLockObservation(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function publishLockCandidate(
  paths: RuntimeIngressStorePaths,
  candidatePath: string,
  expected: StoreLockObservation | null,
  processIdentity: RuntimeIngressProcessIdentityProbe
): Promise<boolean> {
  await assertStoreParentIdentity(paths);
  const current = await readOptionalLockObservation(paths.lock);
  if (expected === null) {
    if (current !== null) return false;
    try {
      await link(candidatePath, paths.lock);
      return true;
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) return false;
      throw error;
    }
  }
  if (
    current?.device !== expected.device ||
    current?.inode !== expected.inode ||
    (current.record !== null && (await isCurrentLockOwner(current.record, processIdentity)))
  ) {
    return false;
  }
  if (process.platform === 'win32' && current.record) {
    await cleanupStaleWindowsLockHelperTemp(paths, current.record.token);
  }
  // The OS lock excludes every conforming replacement. This rename is one atomic
  // orphan-to-owner transition: authority is never published as vacant.
  await rename(candidatePath, paths.lock);
  return true;
}

function parseLockRecord(serialized: string): StoreLockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  return isRecord(value) &&
    value.lockVersion === 2 &&
    Number.isSafeInteger(value.ownerPid) &&
    (value.ownerPid as number) >= 1 &&
    typeof value.ownerInstanceId === 'string' &&
    PROCESS_INSTANCE_ID_PATTERN.test(value.ownerInstanceId) &&
    typeof value.token === 'string' &&
    /^[a-f0-9-]{36}$/.test(value.token)
    ? (value as unknown as StoreLockRecord)
    : null;
}

function assertPrivateFile(
  identity: Awaited<ReturnType<typeof stat>>,
  minimumBytes: number,
  maximumBytes: number,
  allowCandidateLink = false
): void {
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    (identity.nlink !== 1 && !(allowCandidateLink && identity.nlink === 2)) ||
    identity.size < minimumBytes ||
    identity.size > maximumBytes ||
    (Number(identity.mode) & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && identity.uid !== process.getuid())
  ) {
    throw new Error('runtime-ingress-private-file-invalid');
  }
}

// prettier-ignore
export function runtimeIngressWindowsLockHelperEnvironment(paths: RuntimeIngressStorePaths, helperTempPath: string, token: string, systemRoot: string): NodeJS.ProcessEnv {
  const windows = trustedWindowsSystemPaths(systemRoot);
  if (!windows || !/^[a-f0-9-]{36}$/.test(token) || !isAbsolute(helperTempPath) || dirname(helperTempPath) !== paths.parent ||
      basename(helperTempPath) !== `.${basename(paths.lockGuard)}.${token}.helper`)
    throw new Error('runtime-ingress-store-os-lock-helper-temp-unsafe');
  return Object.freeze({ ...windows.environment, TEMP: helperTempPath, TMP: helperTempPath, USERPROFILE: helperTempPath });
}

// prettier-ignore
async function createWindowsLockHelperTemp(paths: RuntimeIngressStorePaths, token: string): Promise<WindowsLockHelperTemp> {
  await assertStoreParentIdentity(paths);
  const path = join(paths.parent, `.${basename(paths.lockGuard)}.${token}.helper`);
  runtimeIngressWindowsLockHelperEnvironment(paths, path, token, process.env.SystemRoot ?? '');
  await mkdir(path, { mode: 0o700 });
  const identity = await lstat(path);
  const helperTemp = { path, token, device: identity.dev, inode: identity.ino };
  try {
    await assertWindowsLockHelperTemp(paths, helperTemp);
    return helperTemp;
  } catch (error) {
    try { await rmdir(path); } catch { /* Never recursively clean an unverified path. */ }
    throw error;
  }
}

// prettier-ignore
async function assertWindowsLockHelperTemp(paths: RuntimeIngressStorePaths, helperTemp: WindowsLockHelperTemp): Promise<void> {
  runtimeIngressWindowsLockHelperEnvironment(paths, helperTemp.path, helperTemp.token, process.env.SystemRoot ?? '');
  await assertStoreParentIdentity(paths);
  const identity = await lstat(helperTemp.path);
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.dev !== helperTemp.device ||
      identity.ino !== helperTemp.inode ||
      (typeof process.getuid === 'function' && (Number(identity.mode) & 0o077) !== 0) ||
      (await realpath(helperTemp.path)) !== helperTemp.path) {
    throw new Error('runtime-ingress-store-os-lock-helper-temp-unsafe');
  }
}

// prettier-ignore
async function cleanupWindowsLockHelperTemp(paths: RuntimeIngressStorePaths, helperTemp: WindowsLockHelperTemp): Promise<void> {
  try {
    await assertWindowsLockHelperTemp(paths, helperTemp);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  await rm(helperTemp.path, { recursive: true, maxRetries: 3, retryDelay: 10 });
}

// prettier-ignore
async function cleanupStaleWindowsLockHelperTemp(paths: RuntimeIngressStorePaths, token: string): Promise<void> {
  const path = join(paths.parent, `.${basename(paths.lockGuard)}.${token}.helper`);
  let identity: Awaited<ReturnType<typeof lstat>>;
  try {
    identity = await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  await cleanupWindowsLockHelperTemp(paths, { path, token, device: identity.dev, inode: identity.ino });
}

// prettier-ignore
async function tryAcquireRuntimeIngressOsLock(paths: RuntimeIngressStorePaths, token: string): Promise<RuntimeIngressOsLock | null> {
  await assertStoreParentIdentity(paths);
  const guardHandle = await open(paths.lockGuard,
    fsConstants.O_CREAT | fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW, 0o600);
  let child: ChildProcess | undefined;
  let helperTemp: WindowsLockHelperTemp | undefined;
  try {
    const guardIdentity = await guardHandle.stat();
    assertPrivateFile(guardIdentity, 0, 0);
    if (process.platform === 'win32') {
      const windows = trustedWindowsSystemPaths();
      if (!windows) throw new Error('runtime-ingress-store-os-lock-helper-unavailable');
      helperTemp = await createWindowsLockHelperTemp(paths, token);
      await guardHandle.close();
      child = spawn(windows.powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_LOCK_HELPER, paths.lockGuard],
        {
          cwd: windows.system32,
          env: runtimeIngressWindowsLockHelperEnvironment(paths, helperTemp.path, token, windows.root),
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
    } else {
      child = spawn('/usr/bin/perl', ['-e', POSIX_LOCK_HELPER], {
        cwd: paths.parent, env: TRUSTED_POSIX_PROBE_ENVIRONMENT, shell: false,
        stdio: ['pipe', 'pipe', 'pipe', guardHandle.fd]
      });
    }
    child.stderr?.resume();
    const acquired = await readLockHelperOutcome(child, 1_000, ['LOCKED', 'BUSY']);
    if (!acquired) {
      await stopLockHelper(child);
      if (helperTemp) await cleanupWindowsLockHelperTemp(paths, helperTemp);
      if (process.platform !== 'win32') await guardHandle.close();
      return null;
    }
    if (process.platform !== 'win32') await guardHandle.close();
    const finalComponent = await lstat(paths.lockGuard);
    assertPrivateFile(finalComponent, 0, 0);
    if (finalComponent.dev !== guardIdentity.dev || finalComponent.ino !== guardIdentity.ino) {
      await stopLockHelper(child);
      throw new Error('runtime-ingress-store-lock-guard-substituted');
    }
    return createRuntimeIngressOsLock(paths, guardIdentity, child, helperTemp);
  } catch (error) {
    if (child) await stopLockHelper(child);
    if (helperTemp) await cleanupWindowsLockHelperTemp(paths, helperTemp);
    try { await guardHandle.close(); }
    catch { /* The handle was already closed after transfer to the helper. */ }
    throw error;
  }
}

// prettier-ignore
function createRuntimeIngressOsLock(paths: RuntimeIngressStorePaths, identity: Awaited<ReturnType<typeof stat>>,
  child: ChildProcess, helperTemp?: WindowsLockHelperTemp): RuntimeIngressOsLock {
  let active = child.exitCode === null && child.signalCode === null;
  let released = false;
  let cleanup: Promise<void> | undefined;
  const cleanupHelperTemp = (): Promise<void> =>
    (cleanup ??= helperTemp ? cleanupWindowsLockHelperTemp(paths, helperTemp) : Promise.resolve());
  child.once('exit', () => {
    active = false;
    void cleanupHelperTemp().catch(() => undefined);
  });
  return {
    assertHeld: async () => {
      if (!active || released) {
        await cleanupHelperTemp();
        throw new Error('runtime-ingress-store-os-lock-lost');
      }
      const current = await lstat(paths.lockGuard);
      assertPrivateFile(current, 0, 0);
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('runtime-ingress-store-lock-guard-substituted');
      }
    },
    publishTemporaryFile: async (temporaryPath, snapshotPath) => {
      if (!active || released || !child.stdin) throw new Error('runtime-ingress-store-os-lock-lost');
      const outcome = readLockHelperOutcome(child, 1_000, ['PUBLISHED']);
      const write = new Promise<void>((resolve, reject) => {
        child.stdin?.write(`${JSON.stringify({
          operation: 'publish', temporaryPath, snapshotPath, parentPath: paths.parent
        })}\n`, (error) => (error ? reject(error) : resolve()));
      });
      await Promise.all([outcome, write]);
    },
    release: async () => {
      if (released) return;
      released = true;
      await stopLockHelper(child);
      await cleanupHelperTemp();
    },
  };
}

// prettier-ignore
async function readLockHelperOutcome(child: ChildProcess, timeoutMs: number,
  expected: readonly string[]): Promise<boolean> {
  const stdout = child.stdout;
  if (!stdout) throw new Error('runtime-ingress-store-os-lock-helper-invalid');
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const onError = (error: Error): void => finish(error);
    const onExit = (): void => finish(new Error('runtime-ingress-store-os-lock-helper-exited'));
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > 32) { finish(new Error('runtime-ingress-store-os-lock-helper-invalid')); return; }
      const line = /^(.*)\r?\n$/.exec(output)?.[1];
      if (line === undefined) return;
      const index = expected.indexOf(line);
      finish(index < 0 ? new Error('runtime-ingress-store-os-lock-helper-invalid')
        : expected[index] !== 'BUSY');
    };
    const finish = (result: boolean | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() =>
      finish(new Error('runtime-ingress-store-os-lock-helper-timeout')), timeoutMs);
    stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

// prettier-ignore
async function stopLockHelper(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.once('error', () => undefined);
  await new Promise<void>((resolve) => {
    let giveUp: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => { child.kill('SIGKILL'); giveUp = setTimeout(resolve, 1_000); }, 1_000);
    child.once('exit', () => {
      clearTimeout(timer);
      if (giveUp) clearTimeout(giveUp);
      resolve();
    });
    child.stdin?.end();
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

async function isCurrentLockOwner(
  record: StoreLockRecord,
  processIdentity: RuntimeIngressProcessIdentityProbe
): Promise<boolean> {
  if (!processIdentity.isProcessAlive(record.ownerPid)) return false;
  try {
    const currentInstanceId = await processIdentity.readProcessInstanceId(record.ownerPid);
    return currentInstanceId === null || currentInstanceId === record.ownerInstanceId;
  } catch {
    return true;
  }
}

export async function readRuntimeIngressProcessInstanceId(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const identity =
    platform === 'linux'
      ? await readLinuxProcessInstanceIdentity(pid)
      : await readPortableProcessInstanceIdentity(pid, platform);
  return identity === null ? null : hashProcessInstanceIdentity(platform, identity);
}

export function deriveRuntimeIngressPortableProcessInstanceId(
  platform: 'darwin' | 'win32',
  stdout: string
): string | null {
  const identity =
    platform === 'win32'
      ? parseWindowsProcessCreationTicks(stdout)
      : parseMacOsProcessCreationDate(stdout);
  return identity ? hashProcessInstanceIdentity(platform, identity) : null;
}

// prettier-ignore
async function readLinuxProcessInstanceIdentity(pid: number): Promise<string | null> {
  try {
    const [processStat, bootId] = await Promise.all(
      [readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
    const commandEnd = processStat.lastIndexOf(')');
    const fields = commandEnd < 0 ? [] : processStat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTimeTicks = fields[19];
    const normalizedBootId = bootId.trim();
    return startTimeTicks && /^\d+$/.test(startTimeTicks) && /^[a-f0-9-]{36}$/.test(normalizedBootId)
      ? `${normalizedBootId}:${startTimeTicks}`
      : null;
  } catch {
    return null;
  }
}

// prettier-ignore
async function readPortableProcessInstanceIdentity(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  const probe = trustedPortableProcessInstanceProbe(pid, platform);
  if (!probe) return null;
  return new Promise((resolve) => {
    execFile(probe.executable, probe.args, {
      cwd: probe.workingDirectory, encoding: 'utf8', shell: false, timeout: 1_000,
      windowsHide: true, env: probe.environment
    }, (error, stdout) => resolve((error ? '' : probe.parse(stdout)) || null));
  });
}

// prettier-ignore
function trustedPortableProcessInstanceProbe(pid: number, platform: NodeJS.Platform): PortableProcessInstanceProbe | null {
  if (platform === 'darwin') {
    return {
      executable: '/bin/ps', args: ['-o', 'lstart=', '-p', String(pid)], workingDirectory: '/',
      environment: TRUSTED_POSIX_PROBE_ENVIRONMENT, parse: parseMacOsProcessCreationDate
    };
  }
  if (platform === 'win32') {
    const windows = trustedWindowsSystemPaths();
    if (!windows) return null;
    return {
      executable: windows.powershell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        WINDOWS_PROCESS_IDENTITY_PROBE, String(pid)],
      workingDirectory: windows.system32, environment: windows.environment,
      parse: parseWindowsProcessCreationTicks
    };
  }
  return null;
}

function parseWindowsProcessCreationTicks(stdout: string): string {
  if (!/^[1-9]\d{17,18}$/.test(stdout)) return '';
  const ticks = BigInt(stdout);
  return ticks >= WINDOWS_1601_TICKS && ticks <= WINDOWS_MAX_TICKS ? ticks.toString() : '';
}

// prettier-ignore
function parseMacOsProcessCreationDate(stdout: string): string {
  const match = /^(\w{3}) (\w{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(stdout.trim());
  if (!match) return '';
  const month = MAC_OS_MONTHS.indexOf(match[2]);
  const parts = match.slice(3, 7).map(Number);
  const instant = Date.UTC(Number(match[7]), month, parts[0], parts[1], parts[2], parts[3]);
  const canonical = new Date(instant);
  if (month < 0 || canonical.getUTCFullYear() !== Number(match[7]) ||
      canonical.getUTCMonth() !== month || canonical.getUTCDate() !== parts[0] ||
      MAC_OS_WEEKDAYS[canonical.getUTCDay()] !== match[1]) return '';
  return canonical.toISOString();
}

function hashProcessInstanceIdentity(platform: NodeJS.Platform, identity: string): string {
  return `sha256:${createHash('sha256').update(platform).update('\0').update(identity).digest('hex')}`;
}

// prettier-ignore
interface PortableProcessInstanceProbe { readonly executable: string; readonly args: readonly string[]; readonly workingDirectory: string; readonly environment: NodeJS.ProcessEnv; readonly parse: (stdout: string) => string }

// prettier-ignore
interface TrustedWindowsSystemPaths { readonly root: string; readonly powershell: string; readonly system32: string; readonly environment: NodeJS.ProcessEnv }

// prettier-ignore
function trustedWindowsSystemPaths(root = process.env.SystemRoot): TrustedWindowsSystemPaths | null {
  if (!root || !/^[a-z]:\\/i.test(root) || windowsPath.normalize(root) !== root) return null;
  const system32 = windowsPath.join(root, 'System32');
  return { root, powershell: windowsPath.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    system32, environment: Object.freeze({ SystemRoot: root, WINDIR: root, PATH: '' }) };
}

const PROCESS_INSTANCE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TRUSTED_POSIX_PROBE_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  LC_ALL: 'C',
  PATH: '',
  TZ: 'UTC0',
});
const WINDOWS_1601_TICKS = 504_911_232_000_000_000n;
const WINDOWS_MAX_TICKS = 3_155_378_975_999_999_999n;
const MAC_OS_MONTHS = Object.freeze('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' '));
const MAC_OS_WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const POSIX_LOCK_HELPER =
  'use Fcntl qw(:flock O_RDONLY); use IO::Handle; use JSON::PP; open(my $h, "<&=3") or exit 70; ' +
  'if (!flock($h, LOCK_EX|LOCK_NB)) { print "BUSY\\n"; exit 75; } ' +
  'STDOUT->autoflush(1); print "LOCKED\\n"; while (defined(my $line=<STDIN>)) { ' +
  'my $m=eval { decode_json($line) }; exit 71 unless ref($m) eq "HASH" && $m->{operation} eq "publish"; ' +
  'rename($m->{temporaryPath},$m->{snapshotPath}) or exit 72; ' +
  'sysopen(my $d,$m->{parentPath},O_RDONLY) or exit 73; $d->sync() or exit 74; print "PUBLISHED\\n"; }';
// prettier-ignore
const WINDOWS_LOCK_HELPER = `$ErrorActionPreference="Stop"; try { $h=[IO.FileStream]::new($args[0],[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read) } catch { [Console]::Out.WriteLine("BUSY"); exit 75 }; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class RILock { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool MoveFileEx(string a,string b,int f); }'; [Console]::Out.WriteLine("LOCKED"); [Console]::Out.Flush(); while (($line=[Console]::In.ReadLine()) -ne $null) { $m=$line|ConvertFrom-Json; if ($m.operation -ne "publish" -or -not [RILock]::MoveFileEx($m.temporaryPath,$m.snapshotPath,9)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }; [Console]::Out.WriteLine("PUBLISHED"); [Console]::Out.Flush() }; $h.Dispose()`;
const WINDOWS_PROCESS_IDENTITY_PROBE =
  '$ErrorActionPreference="Stop"; $p=Get-Process -Id ([int]$args[0]); ' +
  '[Console]::Out.Write(([Int64]$p.StartTime.ToUniversalTime().Ticks).ToString(' +
  '[Globalization.CultureInfo]::InvariantCulture))';
const SYSTEM_PROCESS_IDENTITY: RuntimeIngressProcessIdentityProbe = Object.freeze({
  currentPid: process.pid,
  isProcessAlive,
  readProcessInstanceId: readRuntimeIngressProcessInstanceId,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
