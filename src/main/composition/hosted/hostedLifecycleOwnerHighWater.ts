import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, opendir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// eslint-disable-next-line no-restricted-imports -- Public strict lifecycle wire parser.
import { parseStrictOrchestratorJsonFrame } from '@features/team-lifecycle/main/hosted';
import { withIdentityStableDirectoryPathAsync } from '@main/utils/durablePathOperations';
import { lock } from 'proper-lockfile';

import {
  publishAtomicNoReplaceMarker,
  recoverAtomicNoReplaceMarker,
} from './atomicNoReplaceMarker';
import {
  assertBinding,
  assertMarkerPayload,
  type HostedLifecycleOwnerHighWaterBinding,
  markerPayload,
  ownerAuthorityPayload,
  parseOwnerAuthorityMarker,
} from './hostedLifecycleOwnerHighWaterBinding';
import { recoverHostedLifecycleOwnerPendingMarkers } from './hostedLifecycleOwnerPendingRecovery';

const OWNER_AUTHORITY_MARKER_NAME = '.owner-authority';
const ROOT_ADMISSION_LOCK_NAME = '.authority-admission-lock';
const AUTHORITY_ADMISSION_LOCK_NAME = '.admission-lock';
const MAXIMUM_AUTHORITY_MARKER_BYTES = 256;
const MAXIMUM_BINDING_MARKER_BYTES = 512;
const ADMISSION_LOCK_STALE_MS = 5_000;
const ADMISSION_LOCK_UPDATE_MS = 1_000;

export interface HostedLifecycleOwnerHighWaterTestHooks {
  readonly afterRootOpened?: () => Promise<void> | void;
  readonly afterAuthorityParentSynced?: (authorityPath: string) => Promise<void> | void;
  readonly afterAuthorityOpened?: (authorityPath: string) => Promise<void> | void;
  readonly afterExistingMarkerOpened?: (markerPath: string) => Promise<void> | void;
  readonly afterSessionMarkerParentSynced?: (markerPath: string) => Promise<void> | void;
  readonly afterNewMarkerSynced?: (markerPath: string) => Promise<void> | void;
  readonly afterMarkerParentSynced?: (markerPath: string) => Promise<void> | void;
  readonly beforeFinalValidation?: () => Promise<void> | void;
}

export interface HostedLifecycleOwnerHighWaterOptions {
  readonly rootPath: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly testHooks?: HostedLifecycleOwnerHighWaterTestHooks;
}

export type { HostedLifecycleOwnerHighWaterBinding } from './hostedLifecycleOwnerHighWaterBinding';

export class HostedLifecycleOwnerBindingConsumedError extends Error {
  constructor() {
    super('hosted-lifecycle-orchestrator-owner-binding-consumed');
    this.name = 'HostedLifecycleOwnerBindingConsumedError';
  }
}

/**
 * Advances one durable owner-generation marker through already-open directory and file
 * descriptors. The root must be a separately provisioned private mount; this code never creates
 * an untrusted ancestor. Every newly created directory/file is parent-fsynced before success.
 */
export async function advanceHostedLifecycleOwnerHighWater(
  options: HostedLifecycleOwnerHighWaterOptions,
  binding: HostedLifecycleOwnerHighWaterBinding
): Promise<void> {
  assertBinding(binding);
  const access = await withIdentityStableDirectoryPathAsync(
    options.rootPath,
    async (stableRoot, rootHandle) => {
      assertPrivateDirectory(
        await rootHandle.stat({ bigint: true }),
        options,
        'hosted-lifecycle-orchestrator-high-water-root-invalid'
      );
      await options.testHooks?.afterRootOpened?.();
      await assertMembership(
        rootHandle,
        options.rootPath,
        'hosted-lifecycle-orchestrator-high-water-root-substituted'
      );
      await withAdmissionLock(
        stableRoot,
        rootHandle,
        ROOT_ADMISSION_LOCK_NAME,
        options,
        'hosted-lifecycle-orchestrator-high-water-root-admission-lock-invalid',
        'hosted-lifecycle-orchestrator-high-water-root-admission-lock-substituted',
        async () => {
          await withPinnedOwnerAuthority(stableRoot, rootHandle, options, binding, async () => {
            const authorityPath = join(stableRoot, binding.ownerAuthority);
            try {
              await mkdir(authorityPath, { mode: 0o700 });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            // The parent must also be synced on EEXIST. That case can be recovery from a crash
            // after mkdir reached the filesystem but before its directory entry was durable.
            await rootHandle.sync();
            await options.testHooks?.afterAuthorityParentSynced?.(authorityPath);
            const authorityAccess = await withIdentityStableDirectoryPathAsync(
              authorityPath,
              async (stableAuthority, authorityHandle) => {
                assertPrivateDirectory(
                  await authorityHandle.stat({ bigint: true }),
                  options,
                  'hosted-lifecycle-orchestrator-high-water-authority-root-invalid'
                );
                await options.testHooks?.afterAuthorityOpened?.(stableAuthority);
                await assertMembership(
                  authorityHandle,
                  authorityPath,
                  'hosted-lifecycle-orchestrator-high-water-authority-root-substituted'
                );
                await withAuthorityAdmissionLock(
                  stableAuthority,
                  authorityHandle,
                  options,
                  async () => {
                    const recoveredMarkers = await recoverHostedLifecycleOwnerPendingMarkers({
                      stableAuthority,
                      authorityHandle,
                      expectedUid: options.expectedUid,
                      expectedGid: options.expectedGid,
                      ownerAuthority: binding.ownerAuthority,
                      currentBinding: binding,
                    });
                    const highWater = await readHighWater(stableAuthority, options);
                    if (
                      highWater.generationMarkerOwnerSessions.get(binding.ownerGeneration) ===
                        binding.ownerSessionId &&
                      highWater.sessionMarkerGenerations.get(binding.ownerSessionId) ===
                        binding.ownerGeneration
                    ) {
                      throw new HostedLifecycleOwnerBindingConsumedError();
                    }
                    const recovery = classifyBindingMarkerRecovery(
                      highWater,
                      binding,
                      recoveredMarkers
                    );
                    if (recovery === 'none') {
                      if (
                        binding.ownerGeneration <= highWater.maximumGeneration ||
                        highWater.ownerSessionIds.has(binding.ownerSessionId)
                      ) {
                        throw new Error('hosted-lifecycle-orchestrator-session-replayed');
                      }
                      await publishBindingMarkers(
                        stableAuthority,
                        authorityHandle,
                        options,
                        binding
                      );
                    } else if (recovery === 'session-claim') {
                      await publishGenerationMarker(
                        stableAuthority,
                        authorityHandle,
                        options,
                        binding
                      );
                    }
                    await options.testHooks?.beforeFinalValidation?.();
                    await assertMembership(
                      authorityHandle,
                      authorityPath,
                      'hosted-lifecycle-orchestrator-high-water-authority-root-substituted'
                    );
                  }
                );
              },
              { errorPath: authorityPath }
            );
            if (authorityAccess.state !== 'opened') {
              throw new Error('hosted-lifecycle-orchestrator-high-water-authority-root-invalid');
            }
          });
        }
      );
      await assertMembership(
        rootHandle,
        options.rootPath,
        'hosted-lifecycle-orchestrator-high-water-root-substituted'
      );
    },
    { errorPath: options.rootPath }
  );
  if (access.state !== 'opened') {
    throw new Error('hosted-lifecycle-orchestrator-high-water-root-invalid');
  }
}

async function withAuthorityAdmissionLock<Value>(
  stableAuthority: string,
  authorityHandle: FileHandle,
  options: HostedLifecycleOwnerHighWaterOptions,
  task: () => Promise<Value>
): Promise<Value> {
  return withAdmissionLock(
    stableAuthority,
    authorityHandle,
    AUTHORITY_ADMISSION_LOCK_NAME,
    options,
    'hosted-lifecycle-orchestrator-high-water-admission-lock-invalid',
    'hosted-lifecycle-orchestrator-high-water-admission-lock-substituted',
    task
  );
}

async function withAdmissionLock<Value>(
  stableParent: string,
  parentHandle: FileHandle,
  lockName: string,
  options: HostedLifecycleOwnerHighWaterOptions,
  invalidError: string,
  substitutedError: string,
  task: () => Promise<Value>
): Promise<Value> {
  const lockPath = join(stableParent, lockName);
  let compromisedError: Error | null = null;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(stableParent, {
      lockfilePath: lockPath,
      realpath: false,
      stale: ADMISSION_LOCK_STALE_MS,
      update: ADMISSION_LOCK_UPDATE_MS,
      retries: {
        retries: 40,
        factor: 1.2,
        minTimeout: 25,
        maxTimeout: 250,
        randomize: true,
      },
      onCompromised(error) {
        compromisedError = error;
      },
    });
  } catch (error) {
    await parentHandle.sync();
    throw error;
  }
  await parentHandle.sync();
  try {
    const access = await withIdentityStableDirectoryPathAsync(
      lockPath,
      async (stableLock, lockHandle) => {
        await lockHandle.chmod(0o700);
        await lockHandle.sync();
        await assertAdmissionLock(
          lockHandle,
          stableLock,
          lockPath,
          options,
          invalidError,
          substitutedError
        );
        if (compromisedError !== null) throw compromisedError;
        const value = await task();
        if (compromisedError !== null) throw compromisedError;
        await assertAdmissionLock(
          lockHandle,
          stableLock,
          lockPath,
          options,
          invalidError,
          substitutedError
        );
        return value;
      },
      { errorPath: lockPath }
    );
    if (access.state !== 'opened') {
      throw new Error(invalidError);
    }
    return access.value;
  } finally {
    try {
      await release();
    } finally {
      await parentHandle.sync();
    }
  }
}

async function assertAdmissionLock(
  lockHandle: FileHandle,
  stableLock: string,
  lockPath: string,
  options: HostedLifecycleOwnerHighWaterOptions,
  invalidError: string,
  substitutedError: string
): Promise<void> {
  const stat = await lockHandle.stat({ bigint: true });
  assertPrivateDirectory(stat, options, invalidError);
  // proper-lockfile uses an empty directory as the lock. A link count of two proves that it has no
  // child directories; the explicit enumeration also rejects files that do not affect nlink.
  if (stat.nlink !== 2n || (await readdir(stableLock)).length !== 0) {
    throw new Error(invalidError);
  }
  await assertMembership(lockHandle, lockPath, substitutedError);
}

async function withPinnedOwnerAuthority<Value>(
  stableRoot: string,
  rootHandle: FileHandle,
  options: HostedLifecycleOwnerHighWaterOptions,
  binding: HostedLifecycleOwnerHighWaterBinding,
  task: () => Promise<Value>
): Promise<Value> {
  const markerPath = join(stableRoot, OWNER_AUTHORITY_MARKER_NAME);
  const markerOptions = {
    parentPath: stableRoot,
    parentHandle: rootHandle,
    finalName: OWNER_AUTHORITY_MARKER_NAME,
    payload: ownerAuthorityPayload(binding.ownerAuthority),
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
    existing: 'accept-identical',
  } as const;
  const pendingMarkerName = atomicPendingMarkerName(markerOptions.finalName, markerOptions.payload);
  // Prove the authority namespace before recovery touches a pending marker or a fresh publication
  // can make an irreversible pin visible in an invalid layout.
  const preRecoveryLayout = await inspectAuthorityRootLayout(
    stableRoot,
    binding.ownerAuthority,
    pendingMarkerName
  );
  if (preRecoveryLayout.authorityFound) {
    await assertExistingAuthorityRoot(stableRoot, options, binding.ownerAuthority);
    if (!preRecoveryLayout.markerFound) {
      throw new Error('hosted-lifecycle-orchestrator-owner-authority-pin-missing');
    }
  }
  await recoverAtomicNoReplaceMarker(markerOptions);
  const initialLayout = await inspectAuthorityRootLayout(stableRoot, binding.ownerAuthority);
  if (!initialLayout.markerFound) {
    if (initialLayout.authorityFound) {
      // Once an authority namespace exists, the pin is the only durable evidence that names its
      // owner. Reconstructing it from the next claimant would turn deletion/corruption into an
      // authority-rotation primitive. Operators must replace the poisoned volume out of band.
      throw new Error('hosted-lifecycle-orchestrator-owner-authority-pin-missing');
    }
    await publishAtomicNoReplaceMarker(markerOptions);
  }
  const markerHandle = await open(
    markerPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    await assertPinnedOwnerAuthority(markerHandle, markerPath, options, binding.ownerAuthority);
    await assertAuthorityRootLayout(stableRoot, binding.ownerAuthority, false);
    const value = await task();
    await assertPinnedOwnerAuthority(markerHandle, markerPath, options, binding.ownerAuthority);
    await assertAuthorityRootLayout(stableRoot, binding.ownerAuthority, true);
    return value;
  } finally {
    await markerHandle.close();
  }
}

async function assertExistingAuthorityRoot(
  stableRoot: string,
  options: HostedLifecycleOwnerHighWaterOptions,
  ownerAuthority: string
): Promise<void> {
  const authorityPath = join(stableRoot, ownerAuthority);
  const access = await withIdentityStableDirectoryPathAsync(
    authorityPath,
    async (_stableAuthority, authorityHandle) => {
      assertPrivateDirectory(
        await authorityHandle.stat({ bigint: true }),
        options,
        'hosted-lifecycle-orchestrator-high-water-authority-root-invalid'
      );
      await assertMembership(
        authorityHandle,
        authorityPath,
        'hosted-lifecycle-orchestrator-high-water-authority-root-substituted'
      );
    },
    { errorPath: authorityPath }
  );
  if (access.state !== 'opened') {
    throw new Error('hosted-lifecycle-orchestrator-high-water-authority-root-invalid');
  }
}

async function assertAuthorityRootLayout(
  stableRoot: string,
  expectedAuthority: string,
  requireAuthorityDirectory: boolean
): Promise<void> {
  const layout = await inspectAuthorityRootLayout(stableRoot, expectedAuthority);
  if (!layout.markerFound || (requireAuthorityDirectory && !layout.authorityFound)) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
}

async function inspectAuthorityRootLayout(
  stableRoot: string,
  expectedAuthority: string,
  expectedPendingMarker: string | null = null
): Promise<Readonly<{ markerFound: boolean; authorityFound: boolean }>> {
  let markerFound = false;
  let lockFound = false;
  let authorityFound = false;
  let entryCount = 0;
  const directory = await opendir(stableRoot);
  try {
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > (expectedPendingMarker === null ? 3 : 4)) {
        throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
      }
      if (entry.name === OWNER_AUTHORITY_MARKER_NAME && entry.isFile()) {
        markerFound = true;
      } else if (entry.name === ROOT_ADMISSION_LOCK_NAME && entry.isDirectory()) {
        lockFound = true;
      } else if (entry.name === expectedAuthority && entry.isDirectory()) {
        authorityFound = true;
      } else if (entry.name === expectedPendingMarker && entry.isFile()) {
        // The exact deterministic pending name is allowed only during pre-recovery validation.
      } else {
        throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  if (!lockFound) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  return Object.freeze({ markerFound, authorityFound });
}

function atomicPendingMarkerName(finalName: string, payload: string): string {
  return `.pending-${createHash('sha256')
    .update(`${finalName}\u0000${payload}`, 'utf8')
    .digest('hex')}`;
}

async function assertPinnedOwnerAuthority(
  markerHandle: FileHandle,
  markerPath: string,
  options: HostedLifecycleOwnerHighWaterOptions,
  expectedAuthority: string
): Promise<void> {
  const authority = parseOwnerAuthorityMarker(
    parseStrictOrchestratorJsonFrame(
      await readBoundedMarker(markerHandle, markerPath, options, MAXIMUM_AUTHORITY_MARKER_BYTES)
    )
  );
  if (authority !== expectedAuthority) {
    throw new Error('hosted-lifecycle-orchestrator-owner-authority-changed');
  }
}

async function readHighWater(
  stableAuthority: string,
  options: HostedLifecycleOwnerHighWaterOptions
): Promise<
  Readonly<{
    maximumGeneration: number;
    ownerSessionIds: ReadonlySet<string>;
    generationOwnerSessions: ReadonlyMap<number, string>;
    generationMarkerOwnerSessions: ReadonlyMap<number, string>;
    sessionMarkerGenerations: ReadonlyMap<string, number>;
  }>
> {
  const entries = await readdir(stableAuthority, { withFileTypes: true });
  let maximumGeneration = 0;
  const sessionGenerations = new Map<string, number>();
  const generationOwnerSessions = new Map<number, string>();
  const generationMarkerOwnerSessions = new Map<number, string>();
  const sessionMarkerGenerations = new Map<string, number>();
  for (const entry of entries) {
    if (entry.name === '.admission-lock' && entry.isDirectory()) continue;
    const isGenerationMarker = /^[1-9][0-9]{0,15}$/.test(entry.name);
    const sessionClaim = /^session-([0-9a-f]{64})$/.exec(entry.name);
    if (!entry.isFile() || (!isGenerationMarker && sessionClaim === null)) {
      throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
    }
    const markerPath = join(stableAuthority, entry.name);
    const markerHandle = await open(
      markerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    let markerGeneration = 0;
    try {
      await options.testHooks?.afterExistingMarkerOpened?.(markerPath);
      const marker = assertMarkerPayload(
        parseStrictOrchestratorJsonFrame(
          await readBoundedMarker(markerHandle, markerPath, options, MAXIMUM_BINDING_MARKER_BYTES)
        ),
        isGenerationMarker ? Number(entry.name) : null
      );
      if (
        sessionClaim !== null &&
        createHash('sha256').update(marker.ownerSessionId, 'utf8').digest('hex') !== sessionClaim[1]
      ) {
        throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
      }
      const priorGeneration = sessionGenerations.get(marker.ownerSessionId);
      if (priorGeneration !== undefined && priorGeneration !== marker.generation) {
        throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
      }
      sessionGenerations.set(marker.ownerSessionId, marker.generation);
      const priorOwnerSession = generationOwnerSessions.get(marker.generation);
      if (priorOwnerSession !== undefined && priorOwnerSession !== marker.ownerSessionId) {
        throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
      }
      generationOwnerSessions.set(marker.generation, marker.ownerSessionId);
      if (isGenerationMarker) {
        generationMarkerOwnerSessions.set(marker.generation, marker.ownerSessionId);
      } else if (sessionClaim !== null) {
        sessionMarkerGenerations.set(marker.ownerSessionId, marker.generation);
      }
      markerGeneration = marker.generation;
    } finally {
      await markerHandle.close();
    }
    maximumGeneration = Math.max(maximumGeneration, markerGeneration);
  }
  for (const [generation, ownerSessionId] of generationMarkerOwnerSessions) {
    if (sessionMarkerGenerations.get(ownerSessionId) !== generation) {
      throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
    }
  }
  return Object.freeze({
    maximumGeneration,
    ownerSessionIds: new Set(sessionGenerations.keys()),
    generationOwnerSessions,
    generationMarkerOwnerSessions,
    sessionMarkerGenerations,
  });
}

function generationMarkerOptions(
  stableAuthority: string,
  authorityHandle: FileHandle,
  options: HostedLifecycleOwnerHighWaterOptions,
  binding: HostedLifecycleOwnerHighWaterBinding
): Parameters<typeof publishAtomicNoReplaceMarker>[0] {
  return {
    parentPath: stableAuthority,
    parentHandle: authorityHandle,
    finalName: String(binding.ownerGeneration),
    payload: markerPayload(binding),
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
    existing: 'reject',
    hooks: {
      afterTemporarySynced: options.testHooks?.afterNewMarkerSynced,
      afterParentSynced: options.testHooks?.afterMarkerParentSynced,
    },
  };
}

function sessionMarkerOptions(
  stableAuthority: string,
  authorityHandle: FileHandle,
  options: HostedLifecycleOwnerHighWaterOptions,
  binding: HostedLifecycleOwnerHighWaterBinding
): Parameters<typeof publishAtomicNoReplaceMarker>[0] {
  const sessionDigest = createHash('sha256').update(binding.ownerSessionId, 'utf8').digest('hex');
  return {
    parentPath: stableAuthority,
    parentHandle: authorityHandle,
    finalName: `session-${sessionDigest}`,
    payload: markerPayload(binding),
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
    existing: 'reject',
    hooks: {
      afterParentSynced: options.testHooks?.afterSessionMarkerParentSynced,
    },
  };
}

function classifyBindingMarkerRecovery(
  highWater: Awaited<ReturnType<typeof readHighWater>>,
  binding: HostedLifecycleOwnerHighWaterBinding,
  recovered: Awaited<ReturnType<typeof recoverHostedLifecycleOwnerPendingMarkers>>
): 'none' | 'session-claim' | 'generation-claim' {
  if (recovered.session === 'absent' && recovered.generation === 'absent') return 'none';
  if (recovered.session === 'published' && recovered.generation === 'published') {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  const sessionGeneration = highWater.sessionMarkerGenerations.get(binding.ownerSessionId);
  const generationOwnerSession = highWater.generationMarkerOwnerSessions.get(
    binding.ownerGeneration
  );
  if (
    sessionGeneration !== binding.ownerGeneration ||
    hasCompetingGenerationAtOrAbove(highWater, binding)
  ) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  if (recovered.session === 'published') {
    if (generationOwnerSession !== undefined) {
      throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
    }
    return 'session-claim';
  }
  if (generationOwnerSession !== binding.ownerSessionId) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  return 'generation-claim';
}

function hasCompetingGenerationAtOrAbove(
  highWater: Awaited<ReturnType<typeof readHighWater>>,
  binding: HostedLifecycleOwnerHighWaterBinding
): boolean {
  for (const [generation, ownerSessionId] of highWater.generationOwnerSessions) {
    if (
      generation >= binding.ownerGeneration &&
      (generation !== binding.ownerGeneration || ownerSessionId !== binding.ownerSessionId)
    ) {
      return true;
    }
  }
  return false;
}

async function publishGenerationMarker(
  stableAuthority: string,
  authorityHandle: FileHandle,
  options: HostedLifecycleOwnerHighWaterOptions,
  binding: HostedLifecycleOwnerHighWaterBinding
): Promise<void> {
  try {
    await publishAtomicNoReplaceMarker(
      generationMarkerOptions(stableAuthority, authorityHandle, options, binding)
    );
  } catch (error) {
    if ((error as Error).message === 'hosted-atomic-marker-exists') {
      throw new Error('hosted-lifecycle-orchestrator-session-replayed');
    }
    throw error;
  }
}

async function publishBindingMarkers(
  stableAuthority: string,
  authorityHandle: FileHandle,
  options: HostedLifecycleOwnerHighWaterOptions,
  binding: HostedLifecycleOwnerHighWaterBinding
): Promise<void> {
  try {
    await publishAtomicNoReplaceMarker(
      sessionMarkerOptions(stableAuthority, authorityHandle, options, binding)
    );
    await publishAtomicNoReplaceMarker(
      generationMarkerOptions(stableAuthority, authorityHandle, options, binding)
    );
  } catch (error) {
    if ((error as Error).message === 'hosted-atomic-marker-exists') {
      throw new Error('hosted-lifecycle-orchestrator-session-replayed');
    }
    throw error;
  }
}

function assertPrivateDirectory(
  stat: BigIntStats,
  options: Pick<HostedLifecycleOwnerHighWaterOptions, 'expectedUid' | 'expectedGid'>,
  error: string
): void {
  if (
    !stat.isDirectory() ||
    stat.uid !== BigInt(options.expectedUid) ||
    stat.gid !== BigInt(options.expectedGid) ||
    Number(stat.mode & 0o777n) !== 0o700
  ) {
    throw new Error(error);
  }
}

function assertMarkerFile(
  stat: BigIntStats,
  options: Pick<HostedLifecycleOwnerHighWaterOptions, 'expectedUid' | 'expectedGid'>,
  maximumBytes: number,
  allowEmpty = false
): void {
  if (
    !stat.isFile() ||
    stat.uid !== BigInt(options.expectedUid) ||
    stat.gid !== BigInt(options.expectedGid) ||
    Number(stat.mode & 0o777n) !== 0o600 ||
    stat.nlink !== 1n ||
    stat.size > BigInt(maximumBytes) ||
    (!allowEmpty && stat.size < 1n)
  ) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
}

async function readBoundedMarker(
  markerHandle: FileHandle,
  markerPath: string,
  options: Pick<HostedLifecycleOwnerHighWaterOptions, 'expectedUid' | 'expectedGid'>,
  maximumBytes: number
): Promise<string> {
  const before = await markerHandle.stat({ bigint: true });
  assertMarkerFile(before, options, maximumBytes);
  const buffer = Buffer.alloc(maximumBytes + 1);
  const { bytesRead } = await markerHandle.read(buffer, 0, buffer.byteLength, 0);
  if (bytesRead < 1 || bytesRead > maximumBytes) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  const after = await markerHandle.stat({ bigint: true });
  assertMarkerFile(after, options, maximumBytes);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    after.size !== BigInt(bytesRead)
  ) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  await assertMembership(
    markerHandle,
    markerPath,
    'hosted-lifecycle-orchestrator-high-water-marker-substituted'
  );
  return buffer.toString('utf8', 0, bytesRead);
}

async function assertMembership(handle: FileHandle, path: string, error: string): Promise<void> {
  const [descriptorStat, pathStat] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  if (
    pathStat.isSymbolicLink() ||
    descriptorStat.dev !== pathStat.dev ||
    descriptorStat.ino !== pathStat.ino
  ) {
    throw new Error(error);
  }
}
