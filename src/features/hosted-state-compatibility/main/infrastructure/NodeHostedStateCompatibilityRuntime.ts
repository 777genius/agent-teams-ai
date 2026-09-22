import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type {
  HostedOfflineRestoreRotationRequest,
  HostedRestoredSqliteFamilyEntry,
  HostedRuntimeMountAdmissionReceipt,
  HostedRuntimeMountAdmissionSettlement,
  HostedStateCompatibilityRuntime,
} from '../application';

const MAX_REPLAY_OUTPUT_BYTES = 64 * 1024;
const MAX_REPLAY_STDERR_BYTES = 32 * 1024;
const REPLAY_TIMEOUT_MS = 30_000;
const REPLAY_HEAP_MB = 192;
const MAX_REPLAY_SQLITE_MEMBER_BYTES = 128 * 1024 * 1024;
const SQLITE_PATHS = new Set([
  'data/storage/app.db',
  'data/storage/app.db-wal',
  'data/storage/app.db-shm',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The archive authority is intentionally outside state/journal storage.  A
 * deployment's archive catalog or mount service owns this lookup and binds a
 * restore scope to an archive directory before the admission layer can ask
 * for replay.  Returning a pathname is safe only because this runtime opens
 * and holds the directory descriptor before starting the replay child.
 */
export interface ImmutableRestoreArchiveAuthority {
  resolveArchive(request: HostedOfflineRestoreRotationRequest): Promise<{
    readonly archiveDirectory: string;
    readonly sourceManifestHash: string;
    readonly restoreGeneration: number;
    /** Opaque sealed material from the same authority that selected archiveDirectory. */
    readonly replayAuthorityPlan: unknown;
  }>;
}

export interface NodeHostedStateCompatibilityRuntimeOptions {
  readonly immutableRestoreArchiveAuthority: ImmutableRestoreArchiveAuthority;
  readonly verifyAndSettleRuntimeMountAdmission: (
    receipt: HostedRuntimeMountAdmissionReceipt,
    request: HostedOfflineRestoreRotationRequest
  ) => Promise<HostedRuntimeMountAdmissionSettlement>;
  /** Override only for a test-owned replay worker. */
  readonly replayWorkerPath?: string;
  /** Override only in focused tests; production defaults are deliberately finite. */
  readonly replayTimeoutMs?: number;
}

/**
 * Production Node implementation of the narrow hosted-state runtime port.
 * It is the sole adapter that turns an independently-owned archive selection
 * into a replayed SQLite authority family; the mutable restore journal never
 * provides an archive path or expected digest to this class.
 */
export class NodeHostedStateCompatibilityRuntime implements HostedStateCompatibilityRuntime {
  private readonly options: NodeHostedStateCompatibilityRuntimeOptions;
  private readonly replayWorkerPath: string;
  private readonly replayTimeoutMs: number;

  constructor(options: NodeHostedStateCompatibilityRuntimeOptions) {
    this.options = options;
    this.replayWorkerPath = options.replayWorkerPath ?? new URL(
      '../../../../../scripts/hosted-web/phase-10/state-compatibility/replay-immutable-restore-archive-sqlite-family.mjs',
      import.meta.url
    ).pathname;
    this.replayTimeoutMs = options.replayTimeoutMs ?? REPLAY_TIMEOUT_MS;
  }

  sha256(body: string | Uint8Array): string {
    return createHash('sha256').update(body).digest('hex');
  }

  async ensureDirectory(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  }

  async readDirectory(path: string): Promise<readonly string[]> {
    const directory = await openBoundDirectory(path);
    try {
      return await readdir(`/proc/self/fd/${directory.fd}`);
    } finally {
      await directory.close();
    }
  }

  async readRegularBoundedUtf8(path: string, maximumBytes: number): Promise<string> {
    return (await this.readRegularBounded(path, maximumBytes)).toString('utf8');
  }

  async readRegularBoundedBytes(path: string, maximumBytes: number): Promise<Uint8Array> {
    return await this.readRegularBounded(path, maximumBytes);
  }

  async readAndSyncRegularBoundedUtf8(path: string, maximumBytes: number): Promise<string> {
    const { body, handle, before } = await this.openAndReadRegular(path, maximumBytes);
    try {
      await handle.sync();
      await assertSameRegularDescriptor(path, handle, before);
      const directory = await openBoundDirectory(dirname(path));
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await assertSameRegularDescriptor(path, handle, before);
      return body.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async writeExclusiveDurable(path: string, body: string, mode: number): Promise<void> {
    const staging = `${path}.staging`;
    await this.writeStagingExclusiveDurable(staging, body, mode);
    try {
      // link(2) gives no-replace promotion. rename(2) would permit an
      // attacker to replace an already-published authority record.
      await link(staging, path);
      await unlink(staging);
      await syncParent(path);
    } catch (error) {
      await unlink(staging).catch(() => {});
      throw error;
    }
  }

  async writeStagingExclusiveDurable(path: string, body: string, mode: number): Promise<void> {
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      mode
    );
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncParent(path);
  }

  async promoteStagingExclusive(stagingPath: string, finalPath: string): Promise<void> {
    await link(stagingPath, finalPath);
    await unlink(stagingPath);
    await syncParent(finalPath);
  }

  async removeFileDurable(path: string): Promise<void> {
    await unlink(path);
    await syncParent(path);
  }

  async replayImmutableRestoreArchiveSqliteFamily(
    request: HostedOfflineRestoreRotationRequest
  ): Promise<readonly HostedRestoredSqliteFamilyEntry[]> {
    const selection = await this.options.immutableRestoreArchiveAuthority.resolveArchive(request);
    if (
      !selection || selection.sourceManifestHash !== request.sourceManifestHash ||
      selection.restoreGeneration !== request.restoreGeneration ||
      typeof selection.archiveDirectory !== 'string' || !isAbsolute(selection.archiveDirectory) ||
      resolve(selection.archiveDirectory) === '/' ||
      !replayPlanMatchesRequest(selection.replayAuthorityPlan, request)
    ) {
      throw new Error('hosted_restore_archive_scope_binding_invalid');
    }
    const archive = await openBoundDirectory(selection.archiveDirectory);
    const archiveBefore = await archive.stat();
    let scratch: ReplayScratch | undefined;
    let result: unknown;
    let primaryError: unknown;
    try {
      scratch = await createReplayScratch();
      await writePrivateReplayPlan(descriptorChildPath(scratch.handle, 'sealed-replay-plan.json'), selection.replayAuthorityPlan);
      await mkdir(descriptorChildPath(scratch.handle, 'state'), { mode: 0o700 });
      const requestNonce = randomBytes(32).toString('hex');
      result = await this.runReplayWorker(archive.fd, scratch.handle.fd, request, requestNonce);
      const archiveAfter = await archive.stat();
      // The child receives a duplicate of this exact descriptor. A named path
      // replacement cannot redirect it; a mutation of the held directory is
      // still a rejection, including a metadata-only identity change.
      if (!sameStat(archiveBefore, archiveAfter)) {
        throw new Error('hosted_restore_archive_identity_changed');
      }
      await assertNamedDirectoryMatchesDescriptor(selection.archiveDirectory, archiveBefore);
      assertReplayResult(result, requestNonce);
      // stdout is only a nonce-bound completion signal. The authority family
      // is read again by this parent from the retained scratch descriptor, so
      // a worker cannot inject a family through stdout or inherited state.
      return await captureReplayFamily(scratch.handle);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try { await archive.close(); } catch (error) { cleanupErrors.push(error); }
      if (scratch) {
        try { await removeReplayScratch(scratch); } catch (error) { cleanupErrors.push(error); }
      }
      if (cleanupErrors.length > 0 && !primaryError) {
        throw new AggregateError(cleanupErrors, 'hosted_restore_replay_cleanup_failed');
      }
      if (cleanupErrors.length > 0 && primaryError) {
        throw new AggregateError([primaryError, ...cleanupErrors], 'hosted_restore_replay_cleanup_failed');
      }
    }
  }

  async verifyAndSettleRuntimeMountAdmission(
    receipt: HostedRuntimeMountAdmissionReceipt,
    request: HostedOfflineRestoreRotationRequest
  ): Promise<HostedRuntimeMountAdmissionSettlement> {
    return await this.options.verifyAndSettleRuntimeMountAdmission(receipt, request);
  }

  private async readRegularBounded(path: string, maximumBytes: number): Promise<Buffer> {
    const { body, handle } = await this.openAndReadRegular(path, maximumBytes);
    try {
      return body;
    } finally {
      await handle.close();
    }
  }

  private async openAndReadRegular(path: string, maximumBytes: number): Promise<{
    readonly body: Buffer;
    readonly handle: Awaited<ReturnType<typeof open>>;
    readonly before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>;
  }> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new Error('hosted_state_metadata_bound_invalid');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size < 0 || before.size > maximumBytes) {
        throw new Error('hosted_state_metadata_file_invalid');
      }
      const body = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < body.byteLength) {
        const { bytesRead } = await handle.read(body, offset, body.byteLength - offset, offset);
        if (bytesRead === 0) throw new Error('hosted_state_metadata_file_truncated');
        offset += bytesRead;
      }
      await assertSameRegularDescriptor(path, handle, before);
      return { body, handle, before };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  private async runReplayWorker(
    archiveFd: number,
    scratchFd: number,
    request: HostedOfflineRestoreRotationRequest,
    requestNonce: string
  ): Promise<unknown> {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${REPLAY_HEAP_MB}`,
      this.replayWorkerPath,
      '/proc/self/fd/4/state',
      request.deploymentId,
      String(request.restoreGeneration),
      request.sourceManifestHash,
      '/proc/self/fd/4/sealed-replay-plan.json',
      requestNonce,
    ], {
      // Never inherit loader hooks, NODE_OPTIONS, NODE_PATH, or arbitrary
      // authority material. The worker needs no inherited configuration.
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', archiveFd, scratchFd],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stopWorkerGroup = () => {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* already gone */ }
      }
      child.kill('SIGKILL');
    };
    const overLimit = () => stopWorkerGroup();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_REPLAY_OUTPUT_BYTES) return overLimit();
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_REPLAY_STDERR_BYTES) return overLimit();
    });
    const timeout = setTimeout(stopWorkerGroup, this.replayTimeoutMs);
    let closeObserved = false;
    const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolveClose) => {
      child.once('close', (code, signal) => {
        closeObserved = true;
        resolveClose({ code, signal });
      });
    });
    const childError = new Promise<never>((_, reject) => child.once('error', reject));
    try {
      const exit = await Promise.race([closed, childError]);
      if (exit.code !== 0 || exit.signal || stdoutBytes > MAX_REPLAY_OUTPUT_BYTES || stderrBytes > MAX_REPLAY_STDERR_BYTES) {
        throw new Error(`hosted_restore_archive_replay_failed:${exit.code ?? exit.signal ?? 'unknown'}`);
      }
      const output = Buffer.concat(stdout).toString('utf8');
      const lines = output.trim().split('\n');
      if (lines.length !== 1 || lines[0].length === 0) throw new Error('hosted_restore_archive_replay_output_invalid');
      return JSON.parse(lines[0]) as unknown;
    } finally {
      clearTimeout(timeout);
      if (!closeObserved) {
        stopWorkerGroup();
        // A timeout/error is not cleanup proof until the owned process group
        // has actually closed. Do not leave scratch reclamation to worker
        // finally handlers that may never run after SIGKILL.
        await closed;
      }
    }
  }
}

function assertReplayResult(value: unknown, requestNonce: string): void {
  if (!isRecord(value) || value.format !== 'hosted-immutable-restore-archive-sqlite-family/v2' ||
    value.requestNonce !== requestNonce || Object.keys(value).length !== 2) {
    throw new Error('hosted_restore_archive_replay_output_invalid');
  }
}

async function captureReplayFamily(scratchHandle: Awaited<ReturnType<typeof open>>): Promise<readonly HostedRestoredSqliteFamilyEntry[]> {
  const state = await openChildDirectory(scratchHandle, 'state');
  let data: Awaited<ReturnType<typeof open>> | undefined;
  let storage: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      data = await openChildDirectory(state, 'data');
      storage = await openChildDirectory(data, 'storage');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw error;
    }
    const family: HostedRestoredSqliteFamilyEntry[] = [];
    for (const path of SQLITE_PATHS) {
      const name = basename(path);
      try {
        const member = await hashBoundRegularMember(storage, name);
        family.push(Object.freeze({ path: path as HostedRestoredSqliteFamilyEntry['path'], ...member }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return validateReplayFamily({ format: 'hosted-immutable-restore-archive-sqlite-family/v1', family });
  } finally {
    await storage?.close();
    await data?.close();
    await state.close();
  }
}

function validateReplayFamily(value: unknown): readonly HostedRestoredSqliteFamilyEntry[] {
  if (!isRecord(value) || value.format !== 'hosted-immutable-restore-archive-sqlite-family/v1' ||
    !Array.isArray(value.family) || Object.keys(value).length !== 2) {
    throw new Error('hosted_restore_archive_replay_output_invalid');
  }
  const seen = new Set<string>();
  const family: HostedRestoredSqliteFamilyEntry[] = [];
  for (const member of value.family) {
    if (!isRecord(member) || typeof member.path !== 'string' || !SQLITE_PATHS.has(member.path) || seen.has(member.path) ||
      !Number.isSafeInteger(member.byteLength) || member.byteLength < 0 ||
      !Number.isSafeInteger(member.mode) || member.mode < 0 || member.mode > 0o777 ||
      typeof member.sha256 !== 'string' || !SHA256_PATTERN.test(member.sha256)) {
      throw new Error('hosted_restore_archive_replay_output_invalid');
    }
    seen.add(member.path);
    family.push(Object.freeze({
      path: member.path as HostedRestoredSqliteFamilyEntry['path'],
      byteLength: member.byteLength,
      mode: member.mode,
      sha256: member.sha256,
    }));
  }
  if (family.length > 0 && !seen.has('data/storage/app.db')) {
    throw new Error('hosted_restore_archive_replay_output_invalid');
  }
  return Object.freeze(family.sort((left, right) => left.path.localeCompare(right.path)));
}

async function hashBoundRegularMember(parent: Awaited<ReturnType<typeof open>>, name: string): Promise<{
  readonly byteLength: number;
  readonly mode: number;
  readonly sha256: string;
}> {
  const path = descriptorChildPath(parent, name);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 0 || before.size > MAX_REPLAY_SQLITE_MEMBER_BYTES) {
      throw new Error('hosted_restore_archive_replay_member_invalid');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - offset), offset);
      if (bytesRead === 0) throw new Error('hosted_restore_archive_replay_member_truncated');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(path);
    if (!sameStat(before, after) || !named.isFile() || named.nlink !== 1 || !sameStat(before, named)) {
      throw new Error('hosted_restore_archive_replay_member_changed');
    }
    return { byteLength: before.size, mode: before.mode & 0o777, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function openBoundDirectory(path: string) {
  const absolute = resolve(path);
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of absolute.split('/').filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      await directory.close();
      directory = next;
    }
    if (!(await directory.stat()).isDirectory()) throw new Error('hosted_restore_archive_directory_invalid');
    return directory;
  } catch (error) {
    await directory.close().catch(() => {});
    throw error;
  }
}

async function assertNamedDirectoryMatchesDescriptor(path: string, expected: Awaited<ReturnType<typeof stat>>): Promise<void> {
  const named = await lstat(path);
  if (!named.isDirectory() || named.isSymbolicLink() || !sameStat(named, expected)) {
    throw new Error('hosted_restore_archive_identity_changed');
  }
}

async function assertSameRegularDescriptor(
  path: string,
  handle: Awaited<ReturnType<typeof open>>,
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>
): Promise<void> {
  const after = await handle.stat();
  const named = await lstat(path);
  if (!after.isFile() || after.nlink !== 1 || named.isSymbolicLink() || !named.isFile() ||
    named.nlink !== 1 || !sameStat(before, after) || !sameStat(before, named)) {
    throw new Error('hosted_state_metadata_file_changed_during_read');
  }
}

function sameStat(left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function syncParent(path: string): Promise<void> {
  const directory = await openBoundDirectory(dirname(path));
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writePrivateReplayPlan(path: string, plan: unknown): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(JSON.stringify(plan), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface ReplayScratch {
  readonly parent: Awaited<ReturnType<typeof open>>;
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly name: string;
  readonly identity: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>;
}

async function createReplayScratch(): Promise<ReplayScratch> {
  // Keep both the parent and scratch descriptors. The string returned by
  // mkdtemp is used once to obtain the child descriptor; all later writes and
  // removal are rooted at those descriptors, never at that string.
  const parent = await openBoundDirectory(tmpdir());
  try {
    const created = await mkdtemp(`${descriptorPath(parent)}/hosted-immutable-restore-replay-`);
    const name = basename(created);
    const handle = await openChildDirectory(parent, name);
    const identity = await handle.stat();
    const named = await lstat(descriptorChildPath(parent, name));
    if (!identity.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || !sameInode(identity, named)) {
      await handle.close();
      throw new Error('hosted_restore_replay_scratch_identity_invalid');
    }
    return { parent, handle, name, identity };
  } catch (error) {
    await parent.close().catch(() => {});
    throw error;
  }
}

async function removeReplayScratch(scratch: ReplayScratch): Promise<void> {
  try {
    const current = await scratch.handle.stat();
    const named = await lstat(descriptorChildPath(scratch.parent, scratch.name));
    if (!sameInode(current, scratch.identity) || !named.isDirectory() || named.isSymbolicLink() || !sameInode(named, scratch.identity)) {
      throw new Error('hosted_restore_replay_scratch_identity_changed');
    }
    await removeBoundDirectoryContents(scratch.handle, 0);
    await scratch.handle.sync();
    const finalNamed = await lstat(descriptorChildPath(scratch.parent, scratch.name));
    if (!finalNamed.isDirectory() || finalNamed.isSymbolicLink() || !sameInode(finalNamed, scratch.identity)) {
      throw new Error('hosted_restore_replay_scratch_identity_changed');
    }
    await scratch.handle.close();
    await rmdir(descriptorChildPath(scratch.parent, scratch.name));
    await scratch.parent.sync();
  } finally {
    await scratch.handle.close().catch(() => {});
    await scratch.parent.close().catch(() => {});
  }
}

async function removeBoundDirectoryContents(parent: Awaited<ReturnType<typeof open>>, depth: number): Promise<void> {
  if (depth > 8) throw new Error('hosted_restore_replay_scratch_depth_invalid');
  const directory = await opendir(descriptorPath(parent));
  const names: string[] = [];
  try {
    for await (const entry of directory) {
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(entry.name) || names.length >= 64) {
        throw new Error('hosted_restore_replay_scratch_inventory_invalid');
      }
      names.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => {});
  }
  for (const name of names) {
    const path = descriptorChildPath(parent, name);
    let child: Awaited<ReturnType<typeof open>> | undefined;
    try {
      child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
    }
    if (child) {
      try {
        const identity = await child.stat();
        await removeBoundDirectoryContents(child, depth + 1);
        await child.sync();
        const named = await lstat(path);
        if (!named.isDirectory() || named.isSymbolicLink() || !sameInode(identity, named)) {
          throw new Error('hosted_restore_replay_scratch_identity_changed');
        }
      } finally {
        await child.close();
      }
      await rmdir(path);
    } else {
      // A non-directory is removed only through the retained parent FD. There
      // is deliberately no recursive pathname removal anywhere in this flow.
      await unlink(path);
    }
  }
}

function descriptorPath(handle: Awaited<ReturnType<typeof open>>): string {
  return `/proc/self/fd/${handle.fd}`;
}

function sameInode(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function descriptorChildPath(handle: Awaited<ReturnType<typeof open>>, name: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name)) throw new Error('hosted_restore_replay_component_invalid');
  return `${descriptorPath(handle)}/${name}`;
}

async function openChildDirectory(parent: Awaited<ReturnType<typeof open>>, name: string) {
  return await open(
    descriptorChildPath(parent, name),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function replayPlanMatchesRequest(
  value: unknown,
  request: HostedOfflineRestoreRotationRequest
): value is Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.rotation) || !isRecord(value.secretPlan) || !isRecord(value.secretPlan.keyring)) {
    return false;
  }
  const rotation = value.rotation;
  const keyring = value.secretPlan.keyring;
  return rotation.format === request.format && rotation.schemaVersion === request.schemaVersion &&
    rotation.deploymentId === request.deploymentId && rotation.sourceManifestHash === request.sourceManifestHash &&
    rotation.restoreGeneration === request.restoreGeneration && rotation.bootId === request.bootId &&
    rotation.eventEpoch === request.eventEpoch && rotation.browserAuthorityRotated === true &&
    rotation.runtimeAuthorityRotationRequired === true && rotation.freshMountBindingsRequired === true &&
    typeof value.secretPlan.identityKey === 'string' && value.secretPlan.identityKey.length >= 32 &&
    keyring.format === 'hosted-access-keyring/v1' && isRecord(keyring.binding) &&
    keyring.binding.deploymentId === request.deploymentId &&
    keyring.binding.restoreGeneration === request.restoreGeneration && keyring.createdAt === 0 &&
    typeof keyring.keyringId === 'string' && /^akr_x[A-Za-z0-9_-]{18,}$/u.test(keyring.keyringId) &&
    typeof keyring.csrfKey === 'string' && keyring.csrfKey.length >= 32 &&
    typeof keyring.hashKey === 'string' && keyring.hashKey.length >= 32;
}
