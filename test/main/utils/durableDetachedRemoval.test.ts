import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getDetachedRemovalPublicReservationRecordPath,
  persistDetachedRemovalPublicReservationRecord,
  readDetachedRemovalPublicReservationRecord,
  removeDetachedRemovalPublicReservationRecord,
} from '@main/utils/durableDetachedRemoval';
import { getDurablePathIdentity } from '@main/utils/durablePathIdentity';
import {
  MAX_DURABLE_PATH_COMPONENT_BYTES,
  durablePathComponent,
  removePathWithIdentityFenceAsync,
} from '@main/utils/durablePathOperations';
import { removeDirectoryEntriesExceptAsync } from '@main/utils/durablePathOperationSupport';
import {
  reclaimDurableReservationRecordLockResidues,
  withDurableReservationRecordLock,
} from '@main/utils/durableReservationRecordLock';
import * as processStartTime from '@main/utils/processStartTime';

const cleanup: string[] = [];
const NONCE = '12345678-1234-4abc-8def-123456789abc';
const CLEANUP_CRASH_STAGES = [
  'after-cleanup-fence',
  'after-reservation-rmdir',
  'after-tombstone-unlink',
  'after-marker-unlink',
  'after-detached-removal',
] as const;

afterEach(async () => {
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function waitForCondition(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// Strict Linux cleanup deliberately routes mutations through the parent
// descriptor. Test injections must recognize that authority spelling as the
// same entry as its public absolute spelling.
function matchesPublicOrDescriptorPath(candidate: unknown, expected: string): boolean {
  const candidatePath = String(candidate);
  return (
    candidatePath === expected ||
    (/^\/proc\/self\/fd\/\d+\//.test(candidatePath) &&
      candidatePath.endsWith(`/${basename(expected)}`))
  );
}

function resumeOptions(detachedPath: string) {
  return {
    recursive: true,
    force: true,
    reservePublicDirectory: true,
    proofHooks: {
      detachedPath,
      onDetachedValidated: async () => undefined,
      onRemovalDurable: async () => undefined,
    },
  };
}

async function scene(options: { publicLink?: boolean; marker?: boolean; tombstone?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'detached-resume-'));
  cleanup.push(directory);
  const targetPath = join(directory, 'team-a');
  const detachedPath = join(directory, '.team-a.deleting.resume');
  const reservationPath = join(directory, `.team-a.replacement.${NONCE}`);
  const reservationMarkerPath = join(reservationPath, `.review-reservation.${NONCE}.owner`);
  const tombstonePath = join(directory, `.team-a.reservation-link.${NONCE}.tombstone`);
  await mkdir(detachedPath);
  await writeFile(join(detachedPath, 'state.json'), '{}\n', 'utf8');
  await mkdir(reservationPath);
  if (options.marker !== false) await writeFile(reservationMarkerPath, `${NONCE}\n`, 'utf8');
  if (options.publicLink !== false) await symlink(reservationPath, targetPath, 'junction');
  const reservationStats = await lstat(reservationPath);
  const publicLinkStats = options.publicLink === false ? undefined : await lstat(targetPath);
  const record = {
    version: 1 as const,
    detachedPath,
    targetPath,
    reservationPath,
    reservationNonce: NONCE,
    reservationMarkerPath,
    reservationState: options.marker === false ? ('intent' as const) : ('owned' as const),
    reservationIdentity: options.marker === false ? undefined : getDurablePathIdentity(reservationStats),
    ...(options.tombstone === false
      ? {}
      : { tombstonePath, tombstoneState: 'planned' as const }),
    publicLinkIdentity: publicLinkStats ? getDurablePathIdentity(publicLinkStats) : undefined,
    phase: 'open' as const,
  };
  await persistDetachedRemovalPublicReservationRecord({
    record,
    parentDirectory: directory,
    syncParentDirectory: async () => undefined,
  });
  return { directory, targetPath, detachedPath, reservationPath, reservationMarkerPath, tombstonePath };
}

async function prepareRepublishedCapturedReservation() {
  const prepared = await scene();
  const { directory, targetPath, detachedPath, reservationPath, tombstonePath } = prepared;
  const record = await readDetachedRemovalPublicReservationRecord({
    targetPath,
    detachedPath,
    parentDirectory: directory,
  });
  if (!record) throw new Error('missing reservation record');
  const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
  const capturePath = join(tombstonePath, 'captured');
  const capturedPath = join(capturePath, 'entry');
  await mkdir(tombstonePath);
  await writeFile(markerPath, `${NONCE}\n`, 'utf8');
  await mkdir(capturePath);
  await symlink(reservationPath, capturedPath, 'junction');
  const [tombstoneStats, captureStats, capturedStats] = await Promise.all([
    lstat(tombstonePath),
    lstat(capturePath),
    lstat(capturedPath),
  ]);
  const republishedRecord = {
    ...record,
    tombstoneMarkerPath: markerPath,
    tombstoneCapturePath: capturePath,
    tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
    tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
    tombstoneCapturedEntryIdentity: getDurablePathIdentity(capturedStats),
    tombstoneState: 'moved' as const,
    phase: 'republished' as const,
  };
  await persistDetachedRemovalPublicReservationRecord({
    record: republishedRecord,
    parentDirectory: directory,
    syncParentDirectory: async () => undefined,
    allowPhaseAdvance: true,
  });
  return { ...prepared, capturePath, capturedPath, record: republishedRecord };
}

async function writeStaleRecordLock(recordPath: string): Promise<void> {
  const lockPath = `${recordPath}.lock`;
  const tempPath = `${lockPath}.prepare.12345678-1234-4abc-8def-123456789abe`;
  const handle = await fs.promises.open(tempPath, 'wx', 0o600);
  try {
    const identity = getDurablePathIdentity(await handle.stat());
    const parentIdentity = getDurablePathIdentity(await lstat(dirname(lockPath)));
    await handle.writeFile(
      `${JSON.stringify({
        version: 1,
        nonce: '12345678-1234-4abc-8def-123456789abe',
        pid: 999_999,
        processStart: '0',
        incarnation: 'portable-start-time-v1',
        identity,
        fileName: basename(lockPath),
        parentIdentity,
      })}\n`,
      'utf8'
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.link(tempPath, lockPath);
  await fs.promises.unlink(tempPath);
}

describe('durable detached removal public reservations', () => {
  it('keeps a replacement at the reachable last-validation-to-rm boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'detached-last-boundary-'));
    cleanup.push(directory);
    const targetPath = join(directory, 'team-a');
    const detachedPath = join(directory, '.team-a.deleting.boundary');
    await mkdir(targetPath);
    await writeFile(join(targetPath, 'old.json'), '{"old":true}\n', 'utf8');
    let reached = false;

    await expect(removePathWithIdentityFenceAsync(targetPath, {
      recursive: true,
      force: true,
      proofHooks: {
        detachedPath,
        onDetachedValidated: async () => undefined,
        onBeforeDestructiveMutation: async (candidate) => {
          reached = true;
          await rm(candidate, { recursive: true, force: true });
          await mkdir(candidate);
          await writeFile(join(candidate, 'successor.json'), '{"successor":true}\n', 'utf8');
        },
        onRemovalDurable: async () => undefined,
      },
    })).resolves.toBe('changed');

    expect(reached).toBe(true);
    await expect(readFile(join(detachedPath, 'successor.json'), 'utf8')).resolves.toBe(
      '{"successor":true}\n'
    );
  });

  it.each(['open', 'fstat'] as const)(
    'closes retained descriptors when %s fails during retained registration',
    async (failure) => {
      if (process.platform !== 'linux') return;
      const directory = await mkdtemp(join(tmpdir(), 'durable-retained-handle-'));
      cleanup.push(directory);
      const first = join(directory, 'first');
      const second = join(directory, 'second');
      await Promise.all([writeFile(first, 'one\n', 'utf8'), writeFile(second, 'two\n', 'utf8')]);
      const realOpen = fs.promises.open.bind(fs.promises);
      const closed: string[] = [];
      const retainedPaths = new Set([first, second]);
      let retainedRegistration = 0;
      const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (candidate, ...rest) => {
        const candidatePath = String(candidate);
        const registration = retainedPaths.has(candidatePath) ? ++retainedRegistration : 0;
        if (failure === 'open' && registration === 2) {
          throw Object.assign(new Error('injected open failure'), { code: 'EIO' });
        }
        const handle = await realOpen(candidate, ...rest);
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'stat' && failure === 'fstat' && registration === 2) {
              return async () => { throw Object.assign(new Error('injected fstat failure'), { code: 'EIO' }); };
            }
            if (property === 'close') {
              return async () => {
                closed.push(candidatePath);
                return target.close();
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as fs.promises.FileHandle;
      });
      try {
        await expect(removeDirectoryEntriesExceptAsync(directory, new Set(['first', 'second']))).rejects.toThrow(
          'Retained directory entry is not a regular file'
        );
        expect(closed.filter((candidate) => retainedPaths.has(candidate))).toHaveLength(
          failure === 'fstat' ? 2 : 1
        );
      } finally {
        openSpy.mockRestore();
      }
    }
  );

  it('keeps generated durable components within the ENAMETOOLONG budget', () => {
    const component = durablePathComponent(`.${'x'.repeat(255)}`, `.deleting.${NONCE}`);
    expect(Buffer.byteLength(component)).toBeLessThanOrEqual(MAX_DURABLE_PATH_COMPONENT_BYTES);
    expect(component).toEndWith(`.deleting.${NONCE}`);
    expect(durablePathComponent(`.${'x'.repeat(254)}a`, `.deleting.${NONCE}`)).not.toBe(component);
  });

  it('reads a pre-hash bounded reservation record without adopting its name for new writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-record-legacy-name-'));
    cleanup.push(directory);
    const targetBasename = `team-${'x'.repeat(220)}`;
    const targetPath = join(directory, targetBasename);
    const detachedPath = join(directory, `.${targetBasename}.deleting.${NONCE}`);
    const reservationPath = join(
      directory,
      `.${targetBasename}`.slice(0, 255 - Buffer.byteLength(`.replacement.${NONCE}`)) +
        `.replacement.${NONCE}`
    );
    // Prior bounded records clipped the basename to the 127-byte lock-family
    // budget.  Recovery must still find that durable artifact.
    const legacyRecordPath = join(directory, `.${basename(detachedPath)}`.slice(0, 127));
    await writeFile(
      legacyRecordPath,
      `${JSON.stringify({
        version: 1,
        targetPath,
        detachedPath,
        reservationPath,
        reservationNonce: NONCE,
        phase: 'open',
      })}\n`,
      'utf8'
    );

    await expect(
      readDetachedRemovalPublicReservationRecord({ targetPath, detachedPath, parentDirectory: directory })
    ).resolves.toMatchObject({ reservationPath, reservationNonce: NONCE });
    expect(getDetachedRemovalPublicReservationRecordPath(detachedPath)).not.toBe(legacyRecordPath);
  });

  it('serializes multiple stale-lock reclaimers and releases only the claimed successor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-record-lock-'));
    cleanup.push(directory);
    const recordPath = join(directory, 'transaction.json');
    await writeStaleRecordLock(recordPath);
    const events: string[] = [];
    let allowFirstRelease!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      allowFirstRelease = resolve;
    });
    let firstEntered!: () => void;
    const firstEntry = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = withDurableReservationRecordLock(recordPath, async () => {
      events.push('first-entered');
      firstEntered();
      await firstRelease;
      events.push('first-released');
    });
    await firstEntry;
    const second = withDurableReservationRecordLock(recordPath, async () => {
      events.push('second-entered');
    });
    expect(events).toEqual(['first-entered']);

    allowFirstRelease();
    await Promise.all([first, second]);
    await withDurableReservationRecordLock(recordPath, async () => {
      events.push('successor-entered');
    });
    expect(events).toEqual([
      'first-entered',
      'first-released',
      'second-entered',
      'successor-entered',
    ]);
    await expect(lstat(`${recordPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.promises.readdir(directory)).some((entry) =>
      entry.startsWith('transaction.json.lock.transition.')
    )).toBe(false);
  });

  it('accepts the second durable step of a legacy finalization migration', async () => {
    const { directory, targetPath, detachedPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const capturePath = join(tombstonePath, 'captured');
    await mkdir(tombstonePath);
    await mkdir(capturePath);
    const [tombstoneStats, captureStats] = await Promise.all([lstat(tombstonePath), lstat(capturePath)]);
    const legacyFinalizationPath = join(
      capturePath,
      `entry.cleanup.${NONCE}.finalizing.${NONCE}`
    );
    const detachedFinalizationPath = join(tombstonePath, `captured.finalizing.${NONCE}`);
    const legacyRecord = {
      ...record,
      tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
      tombstoneCapturePath: capturePath,
      tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
      tombstoneCleanupFinalizationPath: legacyFinalizationPath,
      tombstoneCleanupPath: join(capturePath, `entry.cleanup.${NONCE}`),
      tombstoneCleanupDetachedPath: join(capturePath, `entry.cleanup.${NONCE}.deleting.${NONCE}`),
    };
    await persistDetachedRemovalPublicReservationRecord({
      record: legacyRecord,
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    const movedParent = { ...legacyRecord, tombstoneCleanupFinalizationPath: detachedFinalizationPath };
    await persistDetachedRemovalPublicReservationRecord({
      record: movedParent,
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await expect(persistDetachedRemovalPublicReservationRecord({
      record: {
        ...movedParent,
        tombstoneCleanupPath: join(detachedFinalizationPath, `entry.cleanup.${NONCE}`),
        tombstoneCleanupDetachedPath: join(
          detachedFinalizationPath,
          `entry.cleanup.${NONCE}.deleting.${NONCE}`
        ),
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    })).resolves.toBeUndefined();
  });

  it('resumes a persisted legacy nested finalization and drains both old identities', async () => {
    const { directory, targetPath, detachedPath, tombstonePath, capturePath, capturedPath, record } =
      await prepareRepublishedCapturedReservation();
    const legacyFinalizationPath = join(
      capturePath,
      `entry.cleanup.${NONCE}.finalizing.${NONCE}`
    );
    const legacyEntry = join(legacyFinalizationPath, 'entry');
    await mkdir(legacyFinalizationPath);
    await fs.promises.rename(capturedPath, legacyEntry);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneCleanupFinalizationPath: legacyFinalizationPath,
        tombstoneCleanupFinalizationIdentity: getDurablePathIdentity(
          await lstat(legacyFinalizationPath)
        ),
        tombstoneCleanupPath: join(capturePath, `entry.cleanup.${NONCE}`),
        tombstoneCleanupDetachedPath: join(
          capturePath,
          `entry.cleanup.${NONCE}.deleting.${NONCE}`
        ),
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    const outerFinalizationPath = join(tombstonePath, `captured.finalizing.${NONCE}`);
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe(
        'deleted'
      );
      expect(renameSpy.mock.calls.some(([source, destination]) =>
        String(source) === capturePath && String(destination) === outerFinalizationPath
      )).toBe(false);
      await expect(lstat(legacyFinalizationPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(capturePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('does not delete delayed B publication after C observed the old generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-record-delayed-publication-'));
    cleanup.push(directory);
    const recordPath = join(directory, 'transaction.json');
    const lockPath = `${recordPath}.lock`;
    await writeStaleRecordLock(recordPath);
    const realLink = fs.promises.link.bind(fs.promises);
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    let releaseC!: () => void;
    const cPaused = new Promise<void>((resolve) => { releaseC = resolve; });
    let releaseB!: () => void;
    const bPaused = new Promise<void>((resolve) => { releaseB = resolve; });
    let cBlocked = false;
    let bBlocked = false;
    let releaseHeld: (() => void) | undefined;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      if (!cBlocked && String(source) === lockPath && String(destination).includes('.takeover.') && String(destination).includes('.claim.')) {
        cBlocked = true;
        await cPaused;
      }
      if (!bBlocked && String(source).includes('.prepare.') && String(destination) === lockPath) {
        bBlocked = true;
        await bPaused;
      }
      return realLink(source, destination);
    });
    try {
      const c = withDurableReservationRecordLock(recordPath, async () => undefined);
      await waitForCondition(() => cBlocked, 'C claim pause');
      // G/A remove the observed stale generation and its takeover authority
      // while C is delayed. B now observes the pathname absent and pauses at
      // publication; when C resumes after B publishes, its old receipt cannot
      // authenticate B and it must not detach or delete B.
      await unlink(lockPath);
      for (const entry of await fs.promises.readdir(directory)) {
        if (entry.startsWith('transaction.json.lock.takeover.')) await unlink(join(directory, entry));
      }
      let bEntered!: () => void;
      const bEnteredPromise = new Promise<void>((resolve) => { bEntered = resolve; });
      const b = withDurableReservationRecordLock(recordPath, async () => {
        bEntered();
        await new Promise<void>((resolve) => { releaseHeld = resolve; });
      });
      await waitForCondition(() => bBlocked, 'B publication pause');
      // B must publish the successor before C is allowed to use its stale
      // claim. Releasing C first would only exercise a different race.
      releaseB();
      await bEnteredPromise;
      releaseC();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await lstat(lockPath)).isFile()).toBe(true);
      releaseHeld?.();
      await Promise.all([b, c]);
      // The retired implementation renamed the observed lock before it could
      // authenticate the hard-link claim. That mutation made a delayed B
      // publication temporarily disappear at the takeover boundary.
      expect(renameSpy.mock.calls.some(([source]) => String(source) === lockPath)).toBe(false);
    } finally {
      // A failed assertion or timeout must not strand a contender behind a
      // test-only barrier: that makes later assertions observe a fake lock
      // leak rather than the filesystem protocol under test.
      releaseB();
      releaseC();
      releaseHeld?.();
      linkSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('does not let unrelated siblings exhaust the lock residue scan budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-record-residue-cap-'));
    cleanup.push(directory);
    const recordPath = join(directory, 'transaction.json');
    await writeStaleRecordLock(recordPath);
    await Promise.all(Array.from({ length: 160 }, (_, index) =>
      writeFile(join(directory, `unrelated-${index}`), 'x\n', 'utf8')
    ));

    await withDurableReservationRecordLock(recordPath, async () => undefined);
    await expect(lstat(`${recordPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not adopt a hard-linked lock receipt under a different residue filename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-record-owner-prepare-'));
    cleanup.push(directory);
    const recordPath = join(directory, 'transaction.json.finalize');
    const lockPath = `${recordPath}.lock`;
    await writeStaleRecordLock(recordPath);
    const residuePath = `${lockPath}.prepare.${NONCE}`;
    await fs.promises.link(lockPath, residuePath);

    await reclaimDurableReservationRecordLockResidues(recordPath);

    // A receipt binds the published lock filename and containing directory.
    // This lookalike is the same inode but a different namespace entry.
    expect((await lstat(residuePath)).isFile()).toBe(true);
  });

  it('does not adopt a hard-linked takeover receipt under a different nonce suffix', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-record-takeover-alias-'));
    cleanup.push(directory);
    const recordPath = join(directory, 'transaction.json');
    const lockPath = `${recordPath}.lock`;
    const aliasPath = `${lockPath}.takeover.${NONCE}`;
    await writeStaleRecordLock(recordPath);
    const realLink = fs.promises.link.bind(fs.promises);
    let aliased = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      await realLink(source, destination);
      if (
        !aliased &&
        String(source).includes('.takeover.') &&
        String(source).includes('.prepare.') &&
        String(destination).startsWith(`${lockPath}.takeover.`)
      ) {
        aliased = true;
        await realLink(destination as string, aliasPath);
      }
    });
    try {
      await withDurableReservationRecordLock(recordPath, async () => undefined);
      expect(aliased).toBe(true);
      // The receipt self-identity alone is insufficient: its immutable
      // published filename also has to match the parsed takeover suffix.
      expect((await lstat(aliasPath)).isFile()).toBe(true);
      await reclaimDurableReservationRecordLockResidues(recordPath);
      expect((await lstat(aliasPath)).isFile()).toBe(true);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it('does not block on a FIFO disguised as a takeover residue', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'durable-record-fifo-'));
    cleanup.push(directory);
    const recordPath = join(directory, 'transaction.json');
    const fifoPath = `${recordPath}.lock.takeover.${NONCE}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('mkfifo', [fifoPath]);
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`)));
    });

    await expect(Promise.race([
      reclaimDurableReservationRecordLockResidues(recordPath),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('FIFO scan blocked')), 250)),
    ])).resolves.toBeUndefined();
    expect((await lstat(fifoPath)).isFIFO()).toBe(true);
  });

  it('does not reclaim a prepare lookalike whose filename nonce is not its receipt nonce', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-record-collision-'));
    cleanup.push(directory);
    const recordPath = join(directory, 'transaction.json');
    const lockPath = `${recordPath}.lock`;
    await writeStaleRecordLock(recordPath);
    const foreignPath = `${lockPath}.prepare.${NONCE}`;
    await fs.promises.link(lockPath, foreignPath);

    await reclaimDurableReservationRecordLockResidues(recordPath);

    expect((await lstat(foreignPath)).isFile()).toBe(true);
  });

  it('restores a foreign record at the same reservation pathname instead of unlinking it', async () => {
    const { directory, targetPath, detachedPath } = await scene();
    const recordPath = getDetachedRemovalPublicReservationRecordPath(detachedPath);
    const expected = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!expected) throw new Error('missing expected reservation record');
    const foreign = {
      ...expected,
      targetPath: join(directory, 'foreign-team'),
      detachedPath: join(directory, '.foreign-team.deleting.resume'),
    };
    const foreignPayload = `${JSON.stringify(foreign)}\n`;
    await writeFile(recordPath, foreignPayload, 'utf8');

    await removeDetachedRemovalPublicReservationRecord({
      detachedPath,
      record: expected,
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
    });

    await expect(readFile(recordPath, 'utf8')).resolves.toBe(foreignPayload);
  });

  it('leaves a nonregular record at its exact original pathname', async () => {
    if (process.platform === 'win32') return;
    const { directory, targetPath, detachedPath } = await scene();
    const recordPath = getDetachedRemovalPublicReservationRecordPath(detachedPath);
    const expected = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!expected) throw new Error('missing expected reservation record');
    await unlink(recordPath);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('mkfifo', [recordPath]);
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`)));
    });

    await removeDetachedRemovalPublicReservationRecord({
      detachedPath,
      record: expected,
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
    });

    expect((await lstat(recordPath)).isFIFO()).toBe(true);
  });

  it('removes an empty owned reservation and its deterministic transaction record', async () => {
    const { targetPath, detachedPath, reservationPath } = await scene();
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
    await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(getDetachedRemovalPublicReservationRecordPath(detachedPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('settles a crash after the durable initial reservation but before its public link', async () => {
    const { targetPath, detachedPath, reservationPath } = await scene({ publicLink: false });

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');

    await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(getDetachedRemovalPublicReservationRecordPath(detachedPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('settles a legacy planned tombstone left after its link move but before record advancement', async () => {
    const { targetPath, detachedPath, tombstonePath, reservationPath } = await scene();
    await fs.promises.link(targetPath, tombstonePath);
    await unlink(targetPath);

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');

    await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resumes a legacy crash after hard-link capture but before public unlink', async () => {
    const { targetPath, detachedPath, tombstonePath, reservationPath } = await scene();
    await fs.promises.link(targetPath, tombstonePath);

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');

    await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never unlinks a replacement that arrives during legacy hard-link recovery', async () => {
    const { targetPath, detachedPath, tombstonePath } = await scene();
    await fs.promises.link(targetPath, tombstonePath);
    const realRename = fs.promises.rename.bind(fs.promises);
    let replaced = false;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (!replaced && String(source) === targetPath && String(destination).includes('.legacy-final.')) {
        replaced = true;
        await unlink(targetPath);
        await symlink('foreign-successor.json', targetPath, 'file');
      }
      return realRename(source, destination);
    });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      expect(replaced).toBe(true);
      await expect(readlink(targetPath)).resolves.toBe('foreign-successor.json');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it.each(['file', 'directory'] as const)(
    'restores a foreign legacy final capture after a crash (%s)',
    async (successorType) => {
      const { targetPath, detachedPath, tombstonePath } = await scene();
      await fs.promises.link(targetPath, tombstonePath);
      const finalCapturePath = `${tombstonePath}.legacy-final.${NONCE}.capture`;
      await unlink(targetPath);
      if (successorType === 'file') {
        await writeFile(finalCapturePath, 'foreign legacy successor\n', 'utf8');
      } else {
        await mkdir(finalCapturePath);
        await writeFile(join(finalCapturePath, 'successor.json'), '{"foreign":true}\n', 'utf8');
      }

      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      if (successorType === 'file') {
        await expect(readFile(targetPath, 'utf8')).resolves.toBe('foreign legacy successor\n');
        await expect(lstat(finalCapturePath)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await expect(readFile(join(targetPath, 'successor.json'), 'utf8')).resolves.toBe('{"foreign":true}\n');
        expect((await lstat(finalCapturePath)).isDirectory()).toBe(true);
      }
    }
  );

  it.each(['file', 'directory'] as const)(
    'restores a planned legacy final capture before a late reservation can republish (%s)',
    async (successorType) => {
      const { targetPath, detachedPath, tombstonePath, reservationPath } = await scene();
      const finalCapturePath = `${tombstonePath}.legacy-final.${NONCE}.capture`;
      await fs.promises.link(targetPath, tombstonePath);
      await unlink(targetPath);
      await writeFile(join(reservationPath, 'late-reservation.json'), '{"late":true}\n', 'utf8');
      if (successorType === 'file') {
        await writeFile(finalCapturePath, 'foreign legacy successor\n', 'utf8');
      } else {
        await mkdir(finalCapturePath);
        await writeFile(join(finalCapturePath, 'successor.json'), '{"foreign":true}\n', 'utf8');
      }

      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      if (successorType === 'file') {
        await expect(readFile(targetPath, 'utf8')).resolves.toBe('foreign legacy successor\n');
      } else {
        await expect(readFile(join(targetPath, 'successor.json'), 'utf8')).resolves.toBe('{"foreign":true}\n');
      }
    }
  );

  it('leaves a dangling Windows link public when its creation type is not authoritative', async () => {
    const { targetPath, detachedPath } = await scene({ tombstone: false });
    await unlink(targetPath);
    await symlink('missing-relative-directory', targetPath, 'dir');
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink');
    const processStartSpy = vi.spyOn(processStartTime, 'readProcessStartTimeMs').mockResolvedValue(1);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      await expect(readlink(targetPath)).resolves.toBe('missing-relative-directory');
      expect(symlinkSpy.mock.calls.filter(([, destination]) => String(destination) === targetPath)).toHaveLength(0);
    } finally {
      symlinkSpy.mockRestore();
      processStartSpy.mockRestore();
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('reclaims interrupted capture-lock preparation before owned tombstone cleanup', async () => {
    const { directory, targetPath, detachedPath, tombstonePath, reservationPath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    const capturedPath = join(capturePath, 'entry');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    await fs.promises.link(targetPath, capturedPath);
    await unlink(targetPath);
    const [tombstoneStats, captureStats] = await Promise.all([lstat(tombstonePath), lstat(capturePath)]);
    const captureRecordPath = `${capturedPath}.capture`;
    const interruptedPreparePath = `${captureRecordPath}.lock.prepare.${NONCE}`;
    await writeStaleRecordLock(captureRecordPath);
    await fs.promises.link(`${captureRecordPath}.lock`, interruptedPreparePath);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneState: 'moved',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
    await expect(lstat(interruptedPreparePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    // A second recovery sees the absent capture parent as an ordinary cleanup
    // suffix rather than trying to reclaim beneath a removed directory.
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('missing');
  });

  it('continues tombstone cleanup when an owned capture directory is already absent', async () => {
    const { directory, targetPath, detachedPath, tombstonePath, reservationPath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    const [tombstoneStats, captureStats] = await Promise.all([lstat(tombstonePath), lstat(capturePath)]);
    await rm(capturePath, { recursive: true });
    await rm(targetPath);
    await rm(reservationPath, { recursive: true });
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneState: 'moved',
        phase: 'cleaning',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
    await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['darwin', 'win32'] as const)(
    'does not write through a %s replacement at the directory rollback publication boundary',
    async (platform) => {
      const directory = await mkdtemp(join(tmpdir(), 'detached-rollback-symlink-'));
      cleanup.push(directory);
      const targetPath = join(directory, 'team-a');
      const outsidePath = join(directory, 'outside');
      await mkdir(targetPath);
      await mkdir(outsidePath);
      await writeFile(join(targetPath, 'state.json'), '{"private":true}\n', 'utf8');
      const realSymlink = fs.promises.symlink.bind(fs.promises);
      let replaced = false;
      const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockImplementation(async (referent, candidate, type) => {
        if (!replaced && String(candidate) === targetPath) {
          replaced = true;
          await symlink(outsidePath, targetPath, 'dir');
        }
        return realSymlink(referent, candidate, type);
      });
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
      try {
        await expect(removePathWithIdentityFenceAsync(targetPath, {
          validateDetached: async () => false,
        })).resolves.toBe('changed');
        expect(replaced).toBe(true);
        await expect(readFile(join(outsidePath, 'state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        symlinkSpy.mockRestore();
        if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  );

  it.each(['darwin', 'win32'] as const)(
    'does not create a mutable private claim during %s directory rollback',
    async (platform) => {
      const directory = await mkdtemp(join(tmpdir(), 'detached-rollback-before-child-'));
      cleanup.push(directory);
      const targetPath = join(directory, 'team-a');
      const outsidePath = join(directory, 'outside');
      await mkdir(targetPath);
      await mkdir(outsidePath);
      await writeFile(join(targetPath, 'state.json'), '{"private":true}\n', 'utf8');
      const mkdirSpy = vi.spyOn(fs.promises, 'mkdir');
      const writeSpy = vi.spyOn(fs.promises, 'writeFile');
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
      try {
        await expect(removePathWithIdentityFenceAsync(targetPath, {
          validateDetached: async () => false,
        })).resolves.toBe('changed');
        expect(mkdirSpy.mock.calls.some(([candidate]) => String(candidate) === targetPath)).toBe(false);
        expect(writeSpy.mock.calls.some(([candidate]) => String(candidate).startsWith(outsidePath))).toBe(false);
        await expect(readFile(join(outsidePath, 'state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        mkdirSpy.mockRestore();
        writeSpy.mockRestore();
        if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  );

  it.each(['darwin', 'win32'] as const)(
    'rolls a detached directory back through the portable identity check on %s',
    async (platform) => {
      const directory = await mkdtemp(join(tmpdir(), 'detached-portable-rollback-'));
      cleanup.push(directory);
      const targetPath = join(directory, 'team-a');
      await mkdir(targetPath);
      await mkdir(join(targetPath, 'nested'));
      await writeFile(join(targetPath, 'nested', 'state.json'), '{"private":true}\n', 'utf8');
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
      try {
        await expect(removePathWithIdentityFenceAsync(targetPath, {
          validateDetached: async () => false,
        })).resolves.toBe('changed');
        await expect(readFile(join(targetPath, 'nested', 'state.json'), 'utf8')).resolves.toBe(
          '{"private":true}\n'
        );
      } finally {
        if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  );

  it('restores a captured Windows relative directory link with its recorded link type', async () => {
    const { directory, targetPath, detachedPath } = await scene({ tombstone: false });
    await unlink(targetPath);
    await mkdir(join(directory, 'relative-directory'));
    await symlink('relative-directory', targetPath, 'dir');
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink');
    const processStartSpy = vi.spyOn(processStartTime, 'readProcessStartTimeMs').mockResolvedValue(1);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      expect(symlinkSpy.mock.calls.some(([referent, destination, type]) =>
        String(referent) === 'relative-directory' &&
        String(destination) === targetPath &&
        type === 'dir'
      )).toBe(true);
      await expect(readlink(targetPath)).resolves.toBe('relative-directory');
    } finally {
      symlinkSpy.mockRestore();
      processStartSpy.mockRestore();
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('restores a dangling Windows relative directory link from its stored type evidence', async () => {
    const { directory, targetPath, detachedPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    const capturedPath = join(capturePath, 'entry');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    await symlink('missing-relative-directory', capturedPath, 'dir');
    const [tombstoneStats, captureStats, capturedStats] = await Promise.all([
      lstat(tombstonePath),
      lstat(capturePath),
      lstat(capturedPath),
    ]);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneCapturedEntryIdentity: getDurablePathIdentity(capturedStats),
        tombstoneCapturedEntryLinkReferent: 'missing-relative-directory',
        tombstoneCapturedEntryLinkType: 'dir',
        tombstoneState: 'prepared',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await unlink(targetPath);
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink');
    const processStartSpy = vi.spyOn(processStartTime, 'readProcessStartTimeMs').mockResolvedValue(1);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      expect(symlinkSpy.mock.calls.some(([referent, destination, type]) =>
        String(referent) === 'missing-relative-directory' &&
        String(destination) === targetPath &&
        type === 'dir'
      )).toBe(true);
      await expect(readlink(targetPath)).resolves.toBe('missing-relative-directory');
    } finally {
      symlinkSpy.mockRestore();
      processStartSpy.mockRestore();
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('recovers a Windows capture before its post-move receipt from exact pre-move authority', async () => {
    const { directory, targetPath, detachedPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    const capturedPath = join(capturePath, 'entry');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    await mkdir(join(directory, 'relative-directory'));
    await unlink(targetPath);
    await symlink('relative-directory', targetPath, 'dir');
    const sourceStats = await lstat(targetPath);
    await fs.promises.rename(targetPath, capturedPath);
    const [tombstoneStats, captureStats] = await Promise.all([lstat(tombstonePath), lstat(capturePath)]);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneCaptureLinkIdentity: getDurablePathIdentity(sourceStats),
        tombstoneCaptureLinkReferent: 'relative-directory',
        tombstoneCaptureLinkType: 'dir',
        tombstoneState: 'prepared',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const processStartSpy = vi.spyOn(processStartTime, 'readProcessStartTimeMs').mockResolvedValue(1);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      await expect(readlink(targetPath)).resolves.toBe('relative-directory');
    } finally {
      processStartSpy.mockRestore();
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('restores a captured relative symlink with its original referent bytes', async () => {
    const { directory, targetPath, detachedPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    const capturedPath = join(capturePath, 'entry');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    await writeFile(join(directory, 'relative-successor.json'), '{"successor":true}\n', 'utf8');
    await unlink(targetPath);
    await symlink('relative-successor.json', targetPath, 'junction');
    await fs.promises.rename(targetPath, capturedPath);
    const [tombstoneStats, captureStats] = await Promise.all([
      lstat(tombstonePath),
      lstat(capturePath),
    ]);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneCaptureLinkReferent: 'relative-successor.json',
        tombstoneState: 'prepared',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    await expect(fs.promises.readlink(targetPath)).resolves.toBe('relative-successor.json');
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('{"successor":true}\n');
  });

  it('does not apply a pre-swap Windows link type to an unbound captured replacement', async () => {
    const { directory, targetPath, detachedPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    const capturedPath = join(capturePath, 'entry');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    const [tombstoneStats, captureStats] = await Promise.all([lstat(tombstonePath), lstat(capturePath)]);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneState: 'prepared',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await unlink(targetPath);
    await writeFile(join(directory, 'before-swap.json'), '{"before":true}\n', 'utf8');
    await writeFile(join(directory, 'after-swap.json'), '{"after":true}\n', 'utf8');
    await symlink('before-swap.json', targetPath, 'file');
    const realRename = fs.promises.rename.bind(fs.promises);
    let swapped = false;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (!swapped && String(source) === targetPath && String(destination) === capturedPath) {
        swapped = true;
        await unlink(targetPath);
        await symlink('after-swap.json', targetPath, 'file');
      }
      return realRename(source, destination);
    });
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const processStartSpy = vi.spyOn(processStartTime, 'readProcessStartTimeMs').mockResolvedValue(1);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      expect(swapped).toBe(true);
      // The replacement was moved after the pre-move receipt was written.
      // Its raw bytes are retained privately rather than recreated with the
      // previous entry's Windows `file` hint.
      await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readlink(capturedPath)).resolves.toBe('after-swap.json');
    } finally {
      renameSpy.mockRestore();
      processStartSpy.mockRestore();
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('restores a captured regular file as a regular file', async () => {
    const { directory, targetPath, detachedPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    const [tombstoneStats, captureStats] = await Promise.all([lstat(tombstonePath), lstat(capturePath)]);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneState: 'prepared',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await unlink(targetPath);
    await writeFile(targetPath, 'captured-file\n', 'utf8');

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    expect((await lstat(targetPath)).isFile()).toBe(true);
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('captured-file\n');
  });

  it('serializes competing resumptions before the no-replace capture boundary', async () => {
    const { directory, targetPath, detachedPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    const capturedPath = join(capturePath, 'entry');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    const [tombstoneStats, captureStats] = await Promise.all([lstat(tombstonePath), lstat(capturePath)]);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneState: 'prepared',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });

    const captureLeasePath = `${capturedPath}.capture`;
    const captureLockPath = `${captureLeasePath}.lock`;
    const realLink = fs.promises.link.bind(fs.promises);
    let holderPublished = false;
    let contenderReached!: () => void;
    const contenderReachedPromise = new Promise<void>((resolve) => {
      contenderReached = resolve;
    });
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      if (String(destination) === captureLockPath) {
        if (holderPublished) contenderReached();
        else holderPublished = true;
      }
      return realLink(source, destination);
    });
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    let competingResume!: Promise<unknown>;
    try {
      await withDurableReservationRecordLock(captureLeasePath, async () => {
        competingResume = removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath));
        await contenderReachedPromise;
        // The first resumer owns this no-replace destination. The waiting
        // resumer must observe it after acquiring the capture lease, rather
        // than rename over it from a stale pre-lock observation.
        await writeFile(capturedPath, 'first-capture\n', 'utf8');
      });
      await expect(competingResume).resolves.toBe('changed');
      await expect(readFile(capturedPath, 'utf8')).resolves.toBe('first-capture\n');
      expect(renameSpy.mock.calls.some(([source, destination]) =>
        String(source) === targetPath && String(destination) === capturedPath
      )).toBe(false);
    } finally {
      linkSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it.each(CLEANUP_CRASH_STAGES)('resumes the cleanup crash window at %s', async (stage) => {
    const {
      directory,
      targetPath,
      detachedPath,
      reservationPath,
      reservationMarkerPath,
      tombstonePath,
    } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');

    // Cleanup was durably announced before rmdir/unlink can remove ownership
    // evidence. Exercise every following crash boundary, including the final
    // gap after detached removal but before reservation-record cleanup.
    await rm(targetPath);
    await symlink(reservationPath, tombstonePath, 'junction');
    await persistDetachedRemovalPublicReservationRecord({
      record: { ...record, tombstoneState: 'moved', phase: 'cleaning' },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    const stageIndex = CLEANUP_CRASH_STAGES.indexOf(stage);
    if (stageIndex >= 1) await rm(reservationPath, { recursive: true, force: true });
    if (stageIndex >= 2) await rm(tombstonePath, { force: true });
    if (stageIndex >= 3) await rm(reservationMarkerPath, { force: true });
    if (stageIndex >= 4) await rm(detachedPath, { recursive: true, force: true });

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
    await expect(lstat(detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(reservationMarkerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(getDetachedRemovalPublicReservationRecordPath(detachedPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('republishes nonempty reservations through an exclusively reserved final directory', async () => {
    const { targetPath, detachedPath, reservationPath } = await scene();
    await writeFile(join(reservationPath, 'written-via-junction.json'), '{"kept":true}\n', 'utf8');
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
    await expect(readFile(join(targetPath, 'written-via-junction.json'), 'utf8')).resolves.toBe('{"kept":true}\n');
    await expect(lstat(join(targetPath, `.review-republish.${NONCE}.owner`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('republishes data created after the public link is detached and rmdir loses with ENOTEMPTY', async () => {
    const { targetPath, detachedPath, reservationPath } = await scene();
    const realRmdir = fs.promises.rmdir.bind(fs.promises);
    let raced = false;
    const rmdirSpy = vi.spyOn(fs.promises, 'rmdir').mockImplementation(async (candidate, options) => {
      if (!raced && String(candidate) === reservationPath) {
        raced = true;
        await writeFile(join(reservationPath, 'late-reservation.json'), '{"kept":true}\n', 'utf8');
      }
      return realRmdir(candidate, options);
    });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
      expect(raced).toBe(true);
      await expect(readFile(join(targetPath, 'late-reservation.json'), 'utf8')).resolves.toBe('{"kept":true}\n');
      expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
    } finally {
      rmdirSpy.mockRestore();
    }
  });

  it('detaches then restores a concurrent foreign symlink successor before deletion', async () => {
    const { targetPath, detachedPath, reservationPath } = await scene();
    const foreignPath = `${reservationPath}.foreign`;
    await mkdir(foreignPath);
    await writeFile(join(foreignPath, 'successor.json'), '{"successor":true}\n', 'utf8');
    // This is the persisted-resume shape of the race: another process has
    // installed a successor before this transaction resumes its reservation.
    await unlink(targetPath);
    await symlink(foreignPath, targetPath, 'junction');
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    await expect(readFile(join(targetPath, 'successor.json'), 'utf8')).resolves.toBe('{"successor":true}\n');
  });

  it.each(['file', 'directory'] as const)(
    'atomically restores a concurrent foreign %s successor caught by the owned tombstone capture',
    async (successorType) => {
      const { directory, targetPath, detachedPath, tombstonePath } = await scene();
      const record = await readDetachedRemovalPublicReservationRecord({
        targetPath,
        detachedPath,
        parentDirectory: directory,
      });
      if (!record) throw new Error('missing reservation record');
      const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
      const capturePath = join(tombstonePath, 'captured');
      await mkdir(tombstonePath);
      await writeFile(markerPath, `${NONCE}\n`, 'utf8');
      await mkdir(capturePath);
      const [tombstoneStats, captureStats] = await Promise.all([
        lstat(tombstonePath),
        lstat(capturePath),
      ]);
      await persistDetachedRemovalPublicReservationRecord({
        record: {
          ...record,
          tombstoneMarkerPath: markerPath,
          tombstoneCapturePath: capturePath,
          tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
          tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
          tombstoneState: 'prepared',
        },
        parentDirectory: directory,
        syncParentDirectory: async () => undefined,
        allowPhaseAdvance: true,
      });
      await unlink(targetPath);
      if (successorType === 'directory') {
        await mkdir(targetPath);
        await writeFile(join(targetPath, 'successor.json'), '{"successor":true}\n', 'utf8');
      } else {
        await writeFile(targetPath, '{"successor":true}\n', 'utf8');
      }
      await fs.promises.rename(targetPath, join(capturePath, 'entry'));
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      const publicSuccessorPath =
        successorType === 'directory' ? join(targetPath, 'successor.json') : targetPath;
      const tombstoneSuccessorPath = successorType === 'directory'
        ? join(tombstonePath, 'captured', 'entry', 'successor.json')
        : join(tombstonePath, 'captured', 'entry');
      await expect(readFile(publicSuccessorPath, 'utf8')).resolves.toBe('{"successor":true}\n');
      await expect(readFile(tombstoneSuccessorPath, 'utf8')).resolves.toBe('{"successor":true}\n');
    }
  );

  it('preserves a last-mile successor while retaining the regular file caught at the tombstone', async () => {
    const { directory, targetPath, detachedPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    const [tombstoneStats, captureStats] = await Promise.all([
      lstat(tombstonePath),
      lstat(capturePath),
    ]);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneState: 'prepared',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await unlink(targetPath);
    await writeFile(targetPath, '{"captured":true}\n', 'utf8');
    await fs.promises.rename(targetPath, join(capturePath, 'entry'));
    await writeFile(targetPath, '{"newer":true}\n', 'utf8');
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('{"newer":true}\n');
    await expect(readFile(join(tombstonePath, 'captured', 'entry'), 'utf8')).resolves.toBe('{"captured":true}\n');
  });

  it('discovers a crash after moving the public link to its recorded tombstone and preserves a successor', async () => {
    const { directory, targetPath, detachedPath, reservationPath, tombstonePath } = await scene();
    await rm(targetPath);
    await symlink(reservationPath, tombstonePath, 'junction');
    const record = await readDetachedRemovalPublicReservationRecord({ targetPath, detachedPath, parentDirectory: directory });
    if (!record) throw new Error('missing reservation record');
    await persistDetachedRemovalPublicReservationRecord({
      record: { ...record, tombstoneState: 'moved' },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await mkdir(targetPath);
    await writeFile(join(targetPath, 'successor.json'), '{"successor":true}\n', 'utf8');
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    await expect(readFile(join(targetPath, 'successor.json'), 'utf8')).resolves.toBe('{"successor":true}\n');
    expect((await lstat(tombstonePath)).isSymbolicLink()).toBe(true);
  });

  it('never adopts an EEXIST reservation from an interrupted intent', async () => {
    const { targetPath, detachedPath, reservationPath, reservationMarkerPath } = await scene({ publicLink: false, marker: false });
    await writeFile(reservationMarkerPath, `${NONCE}\n`, 'utf8');
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    expect((await lstat(reservationPath)).isDirectory()).toBe(true);
    expect((await lstat(detachedPath)).isDirectory()).toBe(true);
  });

  it('treats an empty or partial exclusive marker as non-authoritative', async () => {
    const { targetPath, detachedPath, reservationPath, reservationMarkerPath } = await scene({
      publicLink: false,
      marker: false,
    });
    await writeFile(reservationMarkerPath, '', 'utf8');
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    expect((await lstat(reservationPath)).isDirectory()).toBe(true);
    await expect(readFile(reservationMarkerPath, 'utf8')).resolves.toBe('');
  });

  it('does not authorize a marker placed in a foreign replacement directory', async () => {
    const { targetPath, detachedPath, reservationPath, reservationMarkerPath } = await scene({
      publicLink: false,
      marker: false,
    });
    // A marker inside a directory does not prove that its mkdir belonged to
    // this transaction. Only the prepared owned record can do so.
    await rm(reservationPath);
    await mkdir(reservationPath);
    await writeFile(reservationMarkerPath, `${NONCE}\n`, 'utf8');
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    expect((await lstat(reservationPath)).isDirectory()).toBe(true);
    expect((await lstat(detachedPath)).isDirectory()).toBe(true);
  });

  it('does not claim an ordinary empty reservation without its durable owner marker', async () => {
    const { targetPath, detachedPath, reservationPath } = await scene({ publicLink: false, marker: false });
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    expect((await lstat(reservationPath)).isDirectory()).toBe(true);
    expect((await lstat(detachedPath)).isDirectory()).toBe(true);
  });

  it('fails closed when an EEXIST reservation is a foreign directory even if it has a plausible marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'detached-foreign-reservation-'));
    cleanup.push(directory);
    const targetPath = join(directory, 'team-a');
    const detachedPath = join(directory, '.team-a.deleting.foreign-reservation');
    await mkdir(targetPath);
    await writeFile(join(targetPath, 'state.json'), '{}\n', 'utf8');
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    let foreignReservation = '';
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (candidate, options) => {
      const candidatePath = String(candidate);
      if (!foreignReservation && candidatePath.startsWith(join(directory, '.team-a.replacement.'))) {
        foreignReservation = candidatePath;
        await realMkdir(candidatePath, options);
        await writeFile(join(candidatePath, '.review-reservation.foreign.owner'), 'foreign\n', 'utf8');
      }
      return realMkdir(candidate, options);
    });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      expect(foreignReservation).not.toBe('');
      await expect(readFile(join(foreignReservation, '.review-reservation.foreign.owner'), 'utf8')).resolves.toBe('foreign\n');
      await expect(readFile(join(targetPath, 'state.json'), 'utf8')).resolves.toBe('{}\n');
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it('never mkdirs an unmarked final directory: the prepared private generation is the publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'detached-no-final-mkdir-'));
    cleanup.push(directory);
    const targetPath = join(directory, 'team-a');
    const detachedPath = join(directory, '.team-a.deleting.no-final-mkdir');
    await mkdir(targetPath);
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (candidate, options) =>
      realMkdir(candidate, options)
    );
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
      expect(mkdirSpy.mock.calls.some(([candidate]) => String(candidate) === targetPath)).toBe(false);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it('resumes a persisted republishing phase without regressing to cleaning', async () => {
    const { directory, targetPath, detachedPath, reservationPath } = await scene();
    await writeFile(join(reservationPath, 'written-via-junction.json'), '{"kept":true}\n', 'utf8');
    const record = await readDetachedRemovalPublicReservationRecord({ targetPath, detachedPath, parentDirectory: directory });
    if (!record) throw new Error('missing reservation record');
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        phase: 'republishing',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
    await expect(readFile(join(targetPath, 'written-via-junction.json'), 'utf8')).resolves.toBe('{"kept":true}\n');
    const resumed = await readDetachedRemovalPublicReservationRecord({ targetPath, detachedPath, parentDirectory: directory });
    expect(resumed?.phase).toBe('republished');
  });

  it('completes captured-link tombstone cleanup after a republished crash, idempotently', async () => {
    const { directory, targetPath, detachedPath, reservationPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    const capturedPath = join(capturePath, 'entry');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    await symlink(reservationPath, capturedPath, 'junction');
    const [tombstoneStats, captureStats, capturedStats] = await Promise.all([
      lstat(tombstonePath),
      lstat(capturePath),
      lstat(capturedPath),
    ]);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneCapturedEntryIdentity: getDurablePathIdentity(capturedStats),
        tombstoneState: 'moved',
        phase: 'republished',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
    await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('deleted');
    await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['symlink', 'file'] as const)(
    'does not unlink a replacement %s captured entry during republished cleanup',
    async (replacementType) => {
      const { directory, targetPath, detachedPath, reservationPath, tombstonePath } = await scene();
      const record = await readDetachedRemovalPublicReservationRecord({
        targetPath,
        detachedPath,
        parentDirectory: directory,
      });
      if (!record) throw new Error('missing reservation record');
      const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
      const capturePath = join(tombstonePath, 'captured');
      const capturedPath = join(capturePath, 'entry');
      await mkdir(tombstonePath);
      await writeFile(markerPath, `${NONCE}\n`, 'utf8');
      await mkdir(capturePath);
      await symlink(reservationPath, capturedPath, 'junction');
      const [tombstoneStats, captureStats, capturedStats] = await Promise.all([
        lstat(tombstonePath),
        lstat(capturePath),
        lstat(capturedPath),
      ]);
      await persistDetachedRemovalPublicReservationRecord({
        record: {
          ...record,
          tombstoneMarkerPath: markerPath,
          tombstoneCapturePath: capturePath,
          tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
          tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
          tombstoneCapturedEntryIdentity: getDurablePathIdentity(capturedStats),
          tombstoneState: 'moved',
          phase: 'republished',
        },
        parentDirectory: directory,
        syncParentDirectory: async () => undefined,
        allowPhaseAdvance: true,
      });
      const realLink = fs.promises.link.bind(fs.promises);
      let replaced = false;
      const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
        if (!replaced && String(source).endsWith('/entry') && String(destination).includes('.cleanup.')) {
          replaced = true;
          await unlink(source as string);
          if (replacementType === 'symlink') {
            await symlink('foreign-replacement.json', source as string, 'file');
          } else {
            await writeFile(source as string, 'foreign replacement\n', 'utf8');
          }
        }
        return realLink(source, destination);
      });
      try {
        await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
        expect(replaced).toBe(true);
        const preservedPath = join(
          tombstonePath,
          `captured.finalizing.${NONCE}`,
          'entry'
        );
        if (replacementType === 'symlink') {
          await expect(readlink(preservedPath)).resolves.toBe('foreign-replacement.json');
          expect((await lstat(preservedPath)).isSymbolicLink()).toBe(true);
        } else {
          await expect(readFile(preservedPath, 'utf8')).resolves.toBe('foreign replacement\n');
          expect((await lstat(preservedPath)).isFile()).toBe(true);
        }
      } finally {
        linkSpy.mockRestore();
      }
    }
  );

  it.each(['symlink', 'file'] as const)(
    'does not delete a replacement %s that wins the cleanup residue final mutation',
    async (replacementType) => {
      const { targetPath, detachedPath, tombstonePath, capturedPath } =
        await prepareRepublishedCapturedReservation();
      const cleanupPath = join(
        tombstonePath,
        `captured.finalizing.${NONCE}`,
        `entry.cleanup.${NONCE}`
      );
      const cleanupDetachedPath = join(
        tombstonePath,
        `captured.finalizing.${NONCE}`,
        `entry.cleanup.${NONCE}.deleting.${NONCE}`
      );
      const realLink = fs.promises.link.bind(fs.promises);
      let replacementWon = false;
      const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
        // link(2) is the actual no-replace publication boundary. A foreign
        // destination arriving here must win rather than be overwritten.
        if (
          !replacementWon &&
          matchesPublicOrDescriptorPath(source, cleanupPath) &&
          String(destination).includes('.deleting.')
        ) {
          replacementWon = true;
          if (replacementType === 'symlink') {
            await symlink('foreign-final.json', destination as string, 'file');
          } else {
            await writeFile(destination as string, 'foreign final replacement\n', 'utf8');
          }
        }
        return realLink(source, destination);
      });
      try {
        await expect(
          removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))
        ).resolves.toBe('changed');
        expect(replacementWon).toBe(true);
        if (replacementType === 'symlink') {
          await expect(readlink(cleanupDetachedPath)).resolves.toBe('foreign-final.json');
          expect((await lstat(cleanupDetachedPath)).isSymbolicLink()).toBe(true);
        } else {
          await expect(readFile(cleanupDetachedPath, 'utf8')).resolves.toBe('foreign final replacement\n');
          expect((await lstat(cleanupDetachedPath)).isFile()).toBe(true);
        }
        await expect(lstat(capturedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        linkSpy.mockRestore();
      }
    }
  );

  it('keeps a replacement published after final authentication outside detached cleanup', async () => {
    const { targetPath, detachedPath, tombstonePath } = await prepareRepublishedCapturedReservation();
    const finalizationPath = join(tombstonePath, `captured.finalizing.${NONCE}`);
    const cleanupDetachedPath = join(finalizationPath, `entry.cleanup.${NONCE}.deleting.${NONCE}`);
    const realUnlink = fs.promises.unlink.bind(fs.promises);
    let replacementWon = false;
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (candidate) => {
      // The old implementation unlinked cleanupDetachedPath after authenticating
      // it. Publish B at that old pathname at the former unlink point. The
      // protocol must now unlink only the separately detached finalization name.
      if (
        !replacementWon &&
        String(candidate).includes(`entry.cleanup.${NONCE}.final`)
      ) {
        replacementWon = true;
        await writeFile(cleanupDetachedPath, 'foreign final replacement\n', 'utf8');
      }
      return realUnlink(candidate);
    });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe(
        'changed'
      );
      expect(replacementWon).toBe(true);
      await expect(readFile(cleanupDetachedPath, 'utf8')).resolves.toBe('foreign final replacement\n');
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('settles an authenticated cleanup residue after a crash immediately following its rename', async () => {
    const { directory, targetPath, detachedPath, capturePath, capturedPath, record } =
      await prepareRepublishedCapturedReservation();
    const cleanupPath = join(capturePath, `entry.cleanup.${NONCE}`);
    // This is the durable state after the journal has been fsynced and the
    // capture rename reached disk, but before the post-rename receipt or
    // cleanup could run in the crashed process.
    await persistDetachedRemovalPublicReservationRecord({
      record: { ...record, tombstoneCleanupPath: cleanupPath },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await fs.promises.rename(capturedPath, cleanupPath);

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe(
      'deleted'
    );
    await expect(lstat(cleanupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe(
      'deleted'
    );
  });

  it('recovers a crash after detaching the complete finalization parent namespace', async () => {
    const { directory, targetPath, detachedPath, tombstonePath, capturePath, record } =
      await prepareRepublishedCapturedReservation();
    const finalizationPath = join(tombstonePath, `captured.finalizing.${NONCE}`);
    await persistDetachedRemovalPublicReservationRecord({
      record: { ...record, tombstoneCleanupFinalizationPath: finalizationPath },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await fs.promises.rename(capturePath, finalizationPath);

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe(
      'deleted'
    );
    await expect(lstat(finalizationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drains the marker/tombstone suffix after finalization rmdir reached disk', async () => {
    const { directory, targetPath, detachedPath, tombstonePath, capturePath, record } =
      await prepareRepublishedCapturedReservation();
    const finalizationPath = join(tombstonePath, `captured.finalizing.${NONCE}`);
    await persistDetachedRemovalPublicReservationRecord({
      record: { ...record, tombstoneCleanupFinalizationPath: finalizationPath },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    // Crash prefix: capture was finalized and rmdir(finalization) completed,
    // but neither ownership marker nor tombstone rmdir ran.
    await rm(capturePath, { recursive: true, force: true });

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe(
      'deleted'
    );
    await expect(lstat(tombstonePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers cleanupDetachedPath when cleanupPath and the captured entry are both absent', async () => {
    const { directory, targetPath, detachedPath, capturePath, capturedPath, record } =
      await prepareRepublishedCapturedReservation();
    const cleanupPath = join(capturePath, `entry.cleanup.${NONCE}`);
    const cleanupDetachedPath = join(capturePath, `entry.cleanup.${NONCE}.deleting.${NONCE}`);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneCleanupPath: cleanupPath,
        tombstoneCleanupDetachedPath: cleanupDetachedPath,
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await fs.promises.rename(capturedPath, cleanupPath);
    await fs.promises.rename(cleanupPath, cleanupDetachedPath);
    await expect(lstat(cleanupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(capturedPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe(
      'deleted'
    );
    await expect(lstat(cleanupDetachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe(
      'deleted'
    );
  });

  it('serializes record validation and publication across independent filesystem lock users', async () => {
    const { directory, targetPath, detachedPath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');

    const recordPath = getDetachedRemovalPublicReservationRecordPath(detachedPath);
    const realRename = fs.promises.rename.bind(fs.promises);
    let releaseCleaning!: () => void;
    const cleaningReleased = new Promise<void>((resolve) => {
      releaseCleaning = resolve;
    });
    let cleaningPaused!: () => void;
    const cleaningPause = new Promise<void>((resolve) => {
      cleaningPaused = resolve;
    });
    let paused = false;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (candidate, destination) => {
      if (!paused && String(destination) === recordPath) {
        paused = true;
        cleaningPaused();
        await cleaningReleased;
      }
      return realRename(candidate, destination);
    });
    const cleaningWrite = persistDetachedRemovalPublicReservationRecord({
      record: { ...record, phase: 'cleaning' },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await cleaningPause;

    let republishedSynced = false;
    // A fresh module instance has no shared JavaScript queue state. Its write
    // must still wait at the filesystem lease while cleaning is paused before
    // the destructive record publication.
    vi.resetModules();
    const isolatedModule = await import('../../../src/main/utils/durableDetachedRemoval');
    const realLink = fs.promises.link.bind(fs.promises);
    let contenderAttempted!: () => void;
    const contenderAttemptedPromise = new Promise<void>((resolve) => {
      contenderAttempted = resolve;
    });
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      if (String(destination) === `${recordPath}.lock`) contenderAttempted();
      return realLink(source, destination);
    });
    const republishedWrite = isolatedModule.persistDetachedRemovalPublicReservationRecord({
      record: { ...record, phase: 'republished' },
      parentDirectory: directory,
      syncParentDirectory: async () => {
        republishedSynced = true;
      },
      allowPhaseAdvance: true,
    });
    await contenderAttemptedPromise;
    expect(republishedSynced).toBe(false);

    try {
      releaseCleaning();
      await Promise.all([cleaningWrite, republishedWrite]);
      const persisted = await readDetachedRemovalPublicReservationRecord({
        targetPath,
        detachedPath,
        parentDirectory: directory,
      });
      expect(persisted?.phase).toBe('republished');
    } finally {
      linkSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('waits for a complete lock held by an independent process incarnation', async () => {
    if (process.platform !== 'linux') return;
    const { directory, targetPath, detachedPath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const lockPath = `${getDetachedRemovalPublicReservationRecordPath(detachedPath)}.lock`;
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');const cp=require('node:child_process');const path=require('node:path');const p=process.argv[1];const n='12345678-1234-4abc-8def-123456789abd';const start=String(Date.parse(cp.execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}}).trim()));const t=p+'.prepare.'+n;const h=fs.openSync(t,'wx',0o600);const st=fs.fstatSync(h);const parent=fs.lstatSync(path.dirname(p));fs.writeFileSync(h,JSON.stringify({version:1,nonce:n,pid:process.pid,processStart:start,incarnation:'portable-start-time-v1',identity:{dev:st.dev,ino:st.ino,birthtimeMs:st.birthtimeMs},fileName:path.basename(p),parentIdentity:{dev:parent.dev,ino:parent.ino,birthtimeMs:parent.birthtimeMs}})+'\\n');fs.fsyncSync(h);fs.closeSync(h);fs.linkSync(t,p);fs.unlinkSync(t);process.stdout.write('ready\\n');setTimeout(()=>{fs.unlinkSync(p);},100);`,
        lockPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    const childExit = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`lock child exited ${code}`))));
    });
    if (!child.stdout) throw new Error('lock child stdout is unavailable');
    const childStdout = child.stdout;
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      childStdout.once('data', () => resolve());
    });
    let synced = false;
    await persistDetachedRemovalPublicReservationRecord({
      record,
      parentDirectory: directory,
      syncParentDirectory: async () => {
        synced = true;
      },
    });
    await childExit;
    // The identical record is a no-op after acquisition, but the completed
    // independent-process lease had to be released first.
    expect(synced).toBe(false);
  });

  it('preserves a concurrent foreign tombstone occupant', async () => {
    const { targetPath, detachedPath, reservationPath, tombstonePath } = await scene();
    await writeFile(reservationPath + '.foreign', 'foreign\n', 'utf8');
    await symlink(reservationPath + '.foreign', tombstonePath, 'junction');
    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    expect((await lstat(tombstonePath)).isSymbolicLink()).toBe(true);
    await expect(readFile(reservationPath + '.foreign', 'utf8')).resolves.toBe('foreign\n');
  });

  it('does not clobber a foreign tombstone occupant arriving at mkdir publication', async () => {
    const { targetPath, detachedPath, tombstonePath } = await scene();
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    let arrived = false;
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (candidate, options) => {
      if (!arrived && String(candidate) === tombstonePath) {
        arrived = true;
        await writeFile(tombstonePath, 'foreign-last-mile\n', 'utf8');
      }
      return realMkdir(candidate, options);
    });
    try {
      await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
      expect(arrived).toBe(true);
      await expect(readFile(tombstonePath, 'utf8')).resolves.toBe('foreign-last-mile\n');
      expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it('recovers a crash immediately after capturing a foreign directory into an owned tombstone', async () => {
    const { directory, targetPath, detachedPath, reservationPath, tombstonePath } = await scene();
    const record = await readDetachedRemovalPublicReservationRecord({
      targetPath,
      detachedPath,
      parentDirectory: directory,
    });
    if (!record) throw new Error('missing reservation record');
    const markerPath = join(tombstonePath, `.review-tombstone.${NONCE}.owner`);
    const capturePath = join(tombstonePath, 'captured');
    await mkdir(tombstonePath);
    await writeFile(markerPath, `${NONCE}\n`, 'utf8');
    await mkdir(capturePath);
    const tombstoneStats = await lstat(tombstonePath);
    const captureStats = await lstat(capturePath);
    await persistDetachedRemovalPublicReservationRecord({
      record: {
        ...record,
        tombstoneMarkerPath: markerPath,
        tombstoneCapturePath: capturePath,
        tombstoneCaptureIdentity: getDurablePathIdentity(captureStats),
        tombstoneIdentity: getDurablePathIdentity(tombstoneStats),
        tombstoneState: 'prepared',
      },
      parentDirectory: directory,
      syncParentDirectory: async () => undefined,
      allowPhaseAdvance: true,
    });
    await rm(targetPath);
    await mkdir(targetPath);
    await writeFile(join(targetPath, 'successor.json'), '{"successor":true}\n', 'utf8');
    await fs.promises.rename(targetPath, join(capturePath, 'entry'));

    await expect(removePathWithIdentityFenceAsync(targetPath, resumeOptions(detachedPath))).resolves.toBe('changed');
    await expect(readFile(join(targetPath, 'successor.json'), 'utf8')).resolves.toBe('{"successor":true}\n');
    await expect(readFile(join(capturePath, 'entry', 'successor.json'), 'utf8')).resolves.toBe('{"successor":true}\n');
    expect((await lstat(tombstonePath)).isDirectory()).toBe(true);
    expect(reservationPath).not.toBe('');
  });
});
