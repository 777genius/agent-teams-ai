import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { allocateAtomicCreateRecoveryDirectory } from '../../../src/main/utils/atomicCreateCleanupCapacity';
import { acquireGenerationBoundCleanupLock } from '../../../src/main/utils/atomicCreateCleanupGenerationLock';
import {
  publishAdmissionOwner,
  publishLeaseOwner,
  retireStaleAdmissionOwner,
} from '../../../src/main/utils/atomicCreateCleanupLeasePublication';
import { parseAtomicCreateRecoveryRecord } from '../../../src/main/utils/atomicCreateCleanupRecord';
import {
  type AtomicCreateRecoveryBudget,
  boundedMatchingEntries,
  createRecoveryRecord,
  readBoundedRegularTextWithIdentity,
  withinAtomicCreateRecoveryBudget,
} from '../../../src/main/utils/atomicCreateCleanupRecoveryIo';
import { atomicCreateAsync, cleanupAtomicCreateTempLinks } from '../../../src/main/utils/atomicWrite';
import {
  type DurableFileIdentity,
  type DurablePathIdentity,
  getDurableFileIdentity,
  getDurablePathIdentity,
  isSameDurableFileIdentity,
  isSameDurablePathIdentity,
} from '../../../src/main/utils/durablePathIdentity';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.promises.rm(directory, { recursive: true, force: true })
    )
  );
});

function expiredBudget(remainingMetadataOperations = 8): AtomicCreateRecoveryBudget {
  return { deadlineMs: Date.now() - 1, remainingMetadataOperations };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-write-real-'));
  temporaryDirectories.push(directory);
  return directory;
}

type ExactGenerationTestOperations = {
  unlinkExactGeneration?: (pathname: string, identity: DurableFileIdentity) => Promise<void>;
  rmdirExactGeneration?: (pathname: string, identity: DurablePathIdentity) => Promise<void>;
  renameExactGeneration?: (
    source: string,
    destination: string,
    identity: DurableFileIdentity
  ) => Promise<void>;
  linkExactGeneration?: (
    source: string,
    destination: string,
    identity: DurableFileIdentity
  ) => Promise<void>;
  mkdtempWithHandle?: (
    prefix: string
  ) => Promise<{ pathname: string; directoryHandle: fs.promises.FileHandle }>;
  mkdirWithHandle?: (
    pathname: string,
    options?: { mode?: number }
  ) => Promise<{ directoryHandle: fs.promises.FileHandle }>;
};

async function withExactGenerationTestOperations<T>(operation: () => Promise<T>): Promise<T> {
  const promises = fs.promises as typeof fs.promises & ExactGenerationTestOperations;
  const original: ExactGenerationTestOperations = {
    unlinkExactGeneration: promises.unlinkExactGeneration,
    rmdirExactGeneration: promises.rmdirExactGeneration,
    renameExactGeneration: promises.renameExactGeneration,
    linkExactGeneration: promises.linkExactGeneration,
    mkdtempWithHandle: promises.mkdtempWithHandle,
    mkdirWithHandle: promises.mkdirWithHandle,
  };
  const assertFile = async (pathname: string, identity: DurableFileIdentity): Promise<void> => {
    if (!isSameDurableFileIdentity(getDurableFileIdentity(await fs.promises.lstat(pathname)), identity)) {
      throw Object.assign(new Error('generation changed'), { code: 'ENOENT' });
    }
  };
  const assertDirectory = async (pathname: string, identity: DurablePathIdentity): Promise<void> => {
    if (!isSameDurablePathIdentity(getDurablePathIdentity(await fs.promises.lstat(pathname)), identity)) {
      throw Object.assign(new Error('generation changed'), { code: 'ENOENT' });
    }
  };
  Object.assign(promises, {
    unlinkExactGeneration: async (pathname: string, identity: DurableFileIdentity) => {
      await assertFile(pathname, identity);
      await fs.promises.unlink(pathname);
    },
    rmdirExactGeneration: async (pathname: string, identity: DurablePathIdentity) => {
      await assertDirectory(pathname, identity);
      await fs.promises.rmdir(pathname);
    },
    renameExactGeneration: async (
      source: string,
      destination: string,
      identity: DurableFileIdentity
    ) => {
      await assertFile(source, identity);
      await fs.promises.rename(source, destination);
    },
    linkExactGeneration: async (
      source: string,
      destination: string,
      identity: DurableFileIdentity
    ) => {
      await assertFile(source, identity);
      await fs.promises.link(source, destination);
    },
    mkdtempWithHandle: async (prefix: string) => {
      const pathname = await fs.promises.mkdtemp(prefix);
      return { pathname, directoryHandle: await fs.promises.open(pathname, 'r') };
    },
    mkdirWithHandle: async (pathname: string, options?: { mode?: number }) => {
      await fs.promises.mkdir(pathname, options);
      return { directoryHandle: await fs.promises.open(pathname, 'r') };
    },
  });
  try {
    return await operation();
  } finally {
    if (original.unlinkExactGeneration) {
      promises.unlinkExactGeneration = original.unlinkExactGeneration;
    } else {
      delete promises.unlinkExactGeneration;
    }
    if (original.rmdirExactGeneration) {
      promises.rmdirExactGeneration = original.rmdirExactGeneration;
    } else {
      delete promises.rmdirExactGeneration;
    }
    if (original.renameExactGeneration) {
      promises.renameExactGeneration = original.renameExactGeneration;
    } else {
      delete promises.renameExactGeneration;
    }
    if (original.linkExactGeneration) {
      promises.linkExactGeneration = original.linkExactGeneration;
    } else {
      delete promises.linkExactGeneration;
    }
    if (original.mkdtempWithHandle) {
      promises.mkdtempWithHandle = original.mkdtempWithHandle;
    } else {
      delete promises.mkdtempWithHandle;
    }
    if (original.mkdirWithHandle) {
      promises.mkdirWithHandle = original.mkdirWithHandle;
    } else {
      delete promises.mkdirWithHandle;
    }
  }
}

describe('atomic-create cleanup real contracts', () => {
  it('retains the real published guard after unlink fails and requests operator reconciliation', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'review.json');
    const originalUnlink = fs.promises.unlink;
    let failedUnlink = false;
    fs.promises.unlink = (async (pathname) => {
      if (!failedUnlink && path.basename(String(pathname)).startsWith('.review-create.')) {
        failedUnlink = true;
        throw Object.assign(new Error('injected unlink failure'), { code: 'EBUSY' });
      }
      return originalUnlink(pathname);
    }) as typeof fs.promises.unlink;
    try {
      await atomicCreateAsync(target, 'A');
    } finally {
      fs.promises.unlink = originalUnlink;
    }
    expect(failedUnlink).toBe(true);
    const guards = (await fs.promises.readdir(directory)).filter((name) =>
      /^\.review-create\.[a-f0-9-]+\.tmp$/i.test(name)
    );
    expect(guards).toHaveLength(1);
    await expect(cleanupAtomicCreateTempLinks(target)).rejects.toMatchObject({
      code: 'EATOMICCREATE_OPERATOR_REQUIRED', reconciliation: 'operator_required',
    });
    await expect(fs.promises.readFile(path.join(directory, guards[0]!), 'utf8')).resolves.toBe('A');
    expect((await fs.promises.lstat(path.join(directory, '.atomic-create-operator-required'))).isDirectory()).toBe(true);
  });

  it('preserves victim B through a retirement-directory symlink trap', async () => {
    const directory = await makeTemporaryDirectory();
    const victimDirectory = path.join(directory, 'victim');
    const victim = path.join(victimDirectory, 'owner.json');
    const trap = path.join(directory, 'retirement-trap');
    const owner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    await fs.promises.mkdir(victimDirectory);
    await fs.promises.writeFile(victim, 'B');
    await fs.promises.symlink(victimDirectory, trap);
    await fs.promises.writeFile(owner, 'A');
    const identity = getDurableFileIdentity(await fs.promises.lstat(owner));
    const originalMkdtemp = fs.promises.mkdtemp;
    let createAttempted = false;
    fs.promises.mkdtemp = (async () => {
      createAttempted = true;
      return trap;
    }) as unknown as typeof fs.promises.mkdtemp;
    try {
      await expect(retireStaleAdmissionOwner(directory, 'A', identity)).rejects.toThrow('operator reconciliation');
    } finally {
      fs.promises.mkdtemp = originalMkdtemp;
    }
    expect(createAttempted).toBe(false);
    await expect(fs.promises.readFile(victim, 'utf8')).resolves.toBe('B');
    await expect(fs.promises.readFile(owner, 'utf8')).resolves.toBe('A');
  });

  it('preserves B under a self-consistent forged record when the target is missing', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'missing-review.json');
    const nonce = '12345678-1234-1234-1234-123456789abc';
    const authority = 'abcdef12-1234-1234-1234-123456789abc';
    const name = `.review-create-cleanup-${nonce}-${authority}-forged`;
    const recovery = path.join(directory, name);
    const attachment = path.join(recovery, `.review-create.${nonce}.tmp`);
    await fs.promises.mkdir(recovery);
    await fs.promises.writeFile(attachment, 'B');
    await fs.promises.writeFile(path.join(recovery, '.atomic-create-recovery.json'), JSON.stringify({
      version: 1, nonce, cleanupAuthority: authority, directoryName: name,
      directoryIdentity: getDurablePathIdentity(await fs.promises.lstat(recovery)),
      attachment: { name: path.basename(attachment), identity: getDurableFileIdentity(await fs.promises.lstat(attachment)) },
    }));
    await expect(withExactGenerationTestOperations(() => cleanupAtomicCreateTempLinks(target)))
      .rejects.toMatchObject({ reconciliation: 'operator_required' });
    await expect(fs.promises.readFile(attachment, 'utf8')).resolves.toBe('B');
    expect((await fs.promises.readdir(recovery)).length).toBe(2);
  });

  it('starts no late retry that can delete B after a publication timeout', async () => {
    const directory = await makeTemporaryDirectory();
    const lease = path.join(directory, 'lease');
    const owner = path.join(lease, 'owner.json');
    await fs.promises.mkdir(lease);
    await fs.promises.writeFile(owner, 'B');
    const promises = fs.promises as typeof fs.promises & ExactGenerationTestOperations;
    await withExactGenerationTestOperations(async () => {
      let releaseCalls = 0;
      promises.unlinkExactGeneration = async () => { releaseCalls++; await fs.promises.unlink(owner); };
      await expect(publishLeaseOwner(directory, 'lease', {
        version: 1, fence: '12345678-1234-1234-1234-123456789abc',
        pid: process.pid, incarnation: null,
      }, { deadlineMs: Date.now() + 1, remainingMetadataOperations: 8 }))
        .rejects.toThrow('operator reconciliation');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(releaseCalls).toBe(0);
    });
    await expect(fs.promises.readFile(owner, 'utf8')).resolves.toBe('B');
  });

  it('retains a recordless crash prefix and reports operator action for a linked target', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'review.json');
    const otherLink = path.join(directory, 'external-link');
    const prefix = await fs.promises.mkdtemp(path.join(directory, '.review-create-cleanup-prefix-'));
    await fs.promises.writeFile(target, 'A');
    await fs.promises.link(target, otherLink);
    await expect(cleanupAtomicCreateTempLinks(target)).rejects.toMatchObject({ reconciliation: 'operator_required' });
    expect((await fs.promises.lstat(prefix)).isDirectory()).toBe(true);
    await expect(fs.promises.readFile(otherLink, 'utf8')).resolves.toBe('A');
  });

  it('keeps one durable operator marker across repeated blocked authorization passes', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'review.json');
    const guard = path.join(directory, '.review-create.12345678-1234-1234-1234-123456789abc.tmp');
    await fs.promises.writeFile(target, 'A');
    await fs.promises.link(target, guard);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(cleanupAtomicCreateTempLinks(target)).rejects.toMatchObject({
        code: 'EATOMICCREATE_OPERATOR_REQUIRED', reconciliation: 'operator_required',
      });
    }
    const markers = (await fs.promises.readdir(directory)).filter((name) =>
      name === '.atomic-create-operator-required'
    );
    expect(markers).toHaveLength(1);
    expect((await fs.promises.lstat(path.join(directory, markers[0]!))).isDirectory()).toBe(true);
    await expect(fs.promises.readFile(guard, 'utf8')).resolves.toBe('A');
  });

  it('marks a 65-guard capacity overflow and retains every linked generation on recovery', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'review.json');
    const unrelated = path.join(directory, 'unrelated-B');
    const marker = path.join(directory, '.atomic-create-operator-required');
    await fs.promises.writeFile(target, 'A');
    await fs.promises.writeFile(unrelated, 'B');
    const guards = Array.from({ length: 65 }, (_, index) =>
      path.join(directory, `.review-create.${index.toString(16).padStart(32, '0')}.tmp`)
    );
    for (const guard of guards) await fs.promises.link(target, guard);

    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await cleanupAtomicCreateTempLinks(target).catch((error: unknown) => error) as {
        code: string;
        reconciliation: string;
        cause: Error;
      };
      expect(failure).toMatchObject({
        code: 'EATOMICCREATE_OPERATOR_REQUIRED', reconciliation: 'operator_required',
      });
      expect(failure.cause.message).toContain('retention limit (64) exceeded');
      expect((await fs.promises.lstat(marker)).isDirectory()).toBe(true);
      expect(await fs.promises.readFile(target, 'utf8')).toBe('A');
      expect(await fs.promises.readFile(unrelated, 'utf8')).toBe('B');
      for (const guard of guards) {
        expect(await fs.promises.readFile(guard, 'utf8')).toBe('A');
      }
    }
    expect((await fs.promises.readdir(directory)).filter((name) =>
      name === '.atomic-create-operator-required'
    )).toHaveLength(1);
  });

  it('marks a single retained staged-attachment guard without a live journal pin', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, '.attachment-delete.12345678-1234-4234-8234-123456789abc.staged');
    const guard = path.join(directory, '.review-create.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp');
    const unrelated = path.join(directory, 'unrelated-B');
    await fs.promises.writeFile(target, 'attachment bytes');
    await fs.promises.link(target, guard);
    await fs.promises.writeFile(unrelated, 'B');

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(cleanupAtomicCreateTempLinks(target)).rejects.toMatchObject({
        code: 'EATOMICCREATE_OPERATOR_REQUIRED', reconciliation: 'operator_required',
      });
      expect((await fs.promises.lstat(path.join(directory, '.atomic-create-operator-required')))
        .isDirectory()).toBe(true);
      await expect(fs.promises.readFile(guard, 'utf8')).resolves.toBe('attachment bytes');
      await expect(fs.promises.readFile(target, 'utf8')).resolves.toBe('attachment bytes');
      await expect(fs.promises.readFile(unrelated, 'utf8')).resolves.toBe('B');
    }
  });

  it('preserves B when the operator marker name is a symlink', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'review.json');
    const guard = path.join(directory, '.review-create.12345678-1234-1234-1234-123456789abc.tmp');
    const victim = path.join(directory, 'B');
    await fs.promises.writeFile(target, 'A');
    await fs.promises.link(target, guard);
    await fs.promises.writeFile(victim, 'B');
    await fs.promises.symlink(victim, path.join(directory, '.atomic-create-operator-required'));
    await expect(cleanupAtomicCreateTempLinks(target)).rejects.toMatchObject({
      code: 'EATOMICCREATE_OPERATOR_REQUIRED', reconciliation: 'operator_required',
    });
    await expect(fs.promises.readFile(victim, 'utf8')).resolves.toBe('B');
    await expect(fs.promises.readFile(guard, 'utf8')).resolves.toBe('A');
  });

  it('refuses stale owner retirement before a substituted retirement symlink can overwrite B', async () => {
    const directory = await makeTemporaryDirectory();
    const owner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const victim = path.join(directory, 'victim-B');
    await fs.promises.writeFile(owner, 'A');
    await fs.promises.writeFile(victim, 'B');
    const identity = getDurableFileIdentity(await fs.promises.lstat(owner));
    const rename = vi.spyOn(fs.promises, 'rename');
    try {
      await expect(retireStaleAdmissionOwner(directory, 'A', identity)).rejects.toThrow('operator reconciliation');
      expect(rename).not.toHaveBeenCalled();
      await expect(fs.promises.readFile(owner, 'utf8')).resolves.toBe('A');
      await expect(fs.promises.readFile(victim, 'utf8')).resolves.toBe('B');
    } finally { rename.mockRestore(); }
  });
  it('retains both owner generations when a capability adapter is installed', async () => {
    const directory = await makeTemporaryDirectory();
    const owner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const pinnedA = path.join(directory, 'owner-A');
    await fs.promises.writeFile(owner, 'A');
    const identity = getDurableFileIdentity(await fs.promises.lstat(owner));
    await fs.promises.link(owner, pinnedA);
    await fs.promises.unlink(owner);
    await fs.promises.writeFile(owner, 'B');
    await withExactGenerationTestOperations(async () => {
      await expect(retireStaleAdmissionOwner(directory, 'A', identity)).rejects.toThrow('operator reconciliation');
    });
    await expect(fs.promises.readFile(owner, 'utf8')).resolves.toBe('B');
    await expect(fs.promises.readFile(pinnedA, 'utf8')).resolves.toBe('A');
  });
  it('does not retire replacement B when it has the stale A bytes', async () => {
    const directory = await makeTemporaryDirectory();
    const ownerPath = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const ownerAPin = path.join(directory, 'owner-A.pin');
    const ownerBytes = '{"version":1,"fence":"same-bytes"}';
    await fs.promises.writeFile(ownerPath, ownerBytes);
    const ownerAIdentity = getDurableFileIdentity(await fs.promises.lstat(ownerPath));
    await fs.promises.link(ownerPath, ownerAPin);
    await fs.promises.unlink(ownerPath);
    await fs.promises.writeFile(ownerPath, ownerBytes);
    const ownerBIdentity = getDurableFileIdentity(await fs.promises.lstat(ownerPath));
    expect(isSameDurableFileIdentity(ownerAIdentity, ownerBIdentity)).toBe(false);

    await expect(
      retireStaleAdmissionOwner(directory, ownerBytes, ownerAIdentity)
    ).rejects.toThrow('operator reconciliation');
    await expect(fs.promises.readFile(ownerPath, 'utf8')).resolves.toBe(ownerBytes);
    expect(
      isSameDurableFileIdentity(
        getDurableFileIdentity(await fs.promises.lstat(ownerPath)),
        ownerBIdentity
      )
    ).toBe(true);
  });

  it('retains a real crash hardlink and publishes a durable operator marker', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'review.json');
    const guard = path.join(directory, '.review-create.12345678-1234-1234-1234-123456789abc.tmp');
    await fs.promises.writeFile(target, 'A');
    await fs.promises.link(target, guard);
    const identity = getDurableFileIdentity(await fs.promises.lstat(guard));
    const failure = await cleanupAtomicCreateTempLinks(target).catch((error: unknown) => error) as {
      markerPath: string;
      code: string;
      reconciliation: string;
    };
    expect(failure).toMatchObject({ code: 'EATOMICCREATE_OPERATOR_REQUIRED', reconciliation: 'operator_required' });
    expect((await fs.promises.lstat(failure.markerPath)).isDirectory()).toBe(true);
    expect(isSameDurableFileIdentity(getDurableFileIdentity(await fs.promises.lstat(guard)), identity)).toBe(true);
  });
  it('preserves live B and legacy detached A with an operator outcome', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'review.json');
    const guard = path.join(directory, '.review-create.12345678-1234-1234-1234-123456789abc.tmp');
    const legacy = await fs.promises.mkdtemp(path.join(directory, '.review-create-cleanup-legacy-'));
    const detached = path.join(legacy, path.basename(guard));
    await fs.promises.writeFile(target, 'A');
    await fs.promises.link(target, detached);
    await fs.promises.writeFile(guard, 'B');
    await expect(cleanupAtomicCreateTempLinks(target)).rejects.toMatchObject({ reconciliation: 'operator_required' });
    await expect(fs.promises.readFile(guard, 'utf8')).resolves.toBe('B');
    await expect(fs.promises.readFile(detached, 'utf8')).resolves.toBe('A');
  });
  it('preserves B when a publisher replaces the public guard during cleanup', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'review.json');
    const guard = path.join(directory, '.review-create.12345678-1234-1234-1234-123456789abc.tmp');
    const retiredA = path.join(directory, 'retired-A');
    await fs.promises.writeFile(target, 'A');
    await fs.promises.link(target, guard);

    await Promise.all([
      cleanupAtomicCreateTempLinks(target),
      (async () => {
        await fs.promises.rename(guard, retiredA);
        await fs.promises.writeFile(guard, 'B', { flag: 'wx' });
      })(),
    ]);
    await expect(fs.promises.readFile(guard, 'utf8')).resolves.toBe('B');
    await expect(fs.promises.readFile(retiredA, 'utf8')).resolves.toBe('A');
  });

  it('retains record-only and partial-record crash prefixes on stock Node', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'review.json');
    await fs.promises.writeFile(target, '{"review":"A"}');
    const complete = await fs.promises.mkdtemp(path.join(directory, '.review-create-cleanup-complete-'));
    const partial = await fs.promises.mkdtemp(path.join(directory, '.review-create-cleanup-partial-'));
    const completeRecord = path.join(complete, '.atomic-create-recovery.json');
    const partialRecord = path.join(partial, '.atomic-create-recovery.json');
    await fs.promises.writeFile(completeRecord, '{}');
    await fs.promises.writeFile(partialRecord, '{"version":1');

    await expect(cleanupAtomicCreateTempLinks(target)).rejects.toMatchObject({
      reconciliation: 'operator_required',
    });
    await expect(fs.promises.readFile(completeRecord, 'utf8')).resolves.toBe('{}');
    await expect(fs.promises.readFile(partialRecord, 'utf8')).resolves.toBe('{"version":1');
  });

  it('refuses owner publication before pending-name substitution', async () => {
    const directory = await makeTemporaryDirectory();
    const lease = path.join(directory, 'lease');
    await fs.promises.mkdir(lease);
    const pending = path.join(lease, 'owner.json.pending-12345678-1234-1234-1234-123456789abc');
    await fs.promises.writeFile(pending, 'B');
    await withExactGenerationTestOperations(async () => {
      await expect(publishLeaseOwner(directory, 'lease', { version: 1, fence: '12345678-1234-1234-1234-123456789abc', pid: process.pid, incarnation: null })).rejects.toThrow('operator reconciliation');
    });
    await expect(fs.promises.readFile(pending, 'utf8')).resolves.toBe('B');
  });
  it('refuses replacement publication after a released owner is substituted', async () => {
    const directory = await makeTemporaryDirectory();
    const owner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    await fs.promises.writeFile(owner, 'B');
    const stale = getDurableFileIdentity(await fs.promises.lstat(owner));
    await withExactGenerationTestOperations(async () => {
      await expect(publishAdmissionOwner(directory, { version: 1, fence: '12345678-1234-1234-1234-123456789abc', pid: process.pid, incarnation: null }, true, stale)).rejects.toThrow('operator reconciliation');
    });
    await expect(fs.promises.readFile(owner, 'utf8')).resolves.toBe('B');
  });
  it('refuses a capability lock before a replacement lock can be deleted', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'generation-bound');
    const lock = `${target}.lock`;
    await fs.promises.mkdir(lock);
    await withExactGenerationTestOperations(async () => {
      await expect(acquireGenerationBoundCleanupLock(target, { realpath: false, stale: 30_000, update: 5_000, retries: 0 })).rejects.toThrow('operator reconciliation');
    });
    expect((await fs.promises.lstat(lock)).isDirectory()).toBe(true);
  });
  it('treats a concurrently disappeared target as no cleanup authority', async () => {
    const directory = await makeTemporaryDirectory();
    const target = path.join(directory, 'missing-target');

    // Exercise the actual recovery branch with a host adapter that refuses
    // substituted generations. The target disappears before its lstat.
    await expect(
      withExactGenerationTestOperations(() => cleanupAtomicCreateTempLinks(target))
    ).resolves.toBeUndefined();
  });

  it('stops a recovery pass at its total metadata budget boundary', async () => {
    const directory = await makeTemporaryDirectory();
    await fs.promises.writeFile(path.join(directory, '.review-create.one.tmp'), 'one');
    const budget: AtomicCreateRecoveryBudget = {
      deadlineMs: Date.now() + 1_000,
      // directory open + one directory read; a second read must not start.
      remainingMetadataOperations: 2,
    };

    await expect(
      boundedMatchingEntries(directory, /^\.review-create\./, 64, 'test-guard', budget)
    ).rejects.toThrow('budget exhausted');
  });

  it('charges unrelated traversal entries to the same metadata budget', async () => {
    const directory = await makeTemporaryDirectory();
    await fs.promises.writeFile(path.join(directory, 'unrelated-user-file'), 'one');
    const budget: AtomicCreateRecoveryBudget = {
      deadlineMs: Date.now() + 1_000,
      remainingMetadataOperations: 2,
    };

    await expect(
      boundedMatchingEntries(directory, /^\.review-create\./, 64, 'test-guard', budget)
    ).rejects.toThrow('budget exhausted');
  });

  it('closes a directory that opens successfully after its recovery timeout exactly once', async () => {
    const originalOpendir = fs.promises.opendir;
    let resolveOpen!: (directory: fs.Dir) => void;
    const close = vi.fn().mockResolvedValue(undefined);
    const lateDirectory = { close } as unknown as fs.Dir;
    fs.promises.opendir = (() =>
      new Promise<fs.Dir>((resolve) => {
        resolveOpen = resolve;
      })) as typeof fs.promises.opendir;
    try {
      await expect(
        boundedMatchingEntries(
          '/stalled-opendir',
          /never/,
          1,
          'test-guard',
          { deadlineMs: Date.now() + 25, remainingMetadataOperations: 4 }
        )
      ).rejects.toThrow('timed out');
      resolveOpen(lateDirectory);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fs.promises.opendir = originalOpendir;
    }
  });

  it('drains a timed-out directory read before closing exactly once', async () => {
    const originalOpendir = fs.promises.opendir;
    let resolveRead!: (entry: fs.Dirent | null) => void;
    const close = vi.fn().mockResolvedValue(undefined);
    const directory = {
      read: vi.fn(
        () =>
          new Promise<fs.Dirent | null>((resolve) => {
            resolveRead = resolve;
          })
      ),
      close,
    } as unknown as fs.Dir;
    fs.promises.opendir = vi.fn().mockResolvedValue(directory) as typeof fs.promises.opendir;
    try {
      await expect(
        boundedMatchingEntries(
          '/stalled-read',
          /never/,
          1,
          'test-guard',
          { deadlineMs: Date.now() + 25, remainingMetadataOperations: 4 }
        )
      ).rejects.toThrow('timed out');
      expect(close).not.toHaveBeenCalled();
      resolveRead(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fs.promises.opendir = originalOpendir;
    }
  });

  it('closes a file that opens successfully after its recovery timeout exactly once', async () => {
    const directory = await makeTemporaryDirectory();
    const recordPath = path.join(directory, 'owner.json');
    await fs.promises.writeFile(recordPath, '{}');
    const originalOpen = fs.promises.open;
    let resolveOpen!: (handle: fs.promises.FileHandle) => void;
    const close = vi.fn().mockResolvedValue(undefined);
    const lateHandle = { close } as unknown as fs.promises.FileHandle;
    fs.promises.open = (() =>
      new Promise<fs.promises.FileHandle>((resolve) => {
        resolveOpen = resolve;
      })) as typeof fs.promises.open;
    try {
      await expect(
        readBoundedRegularTextWithIdentity(recordPath, 4 * 1024, {
          deadlineMs: Date.now() + 50,
          remainingMetadataOperations: 4,
        })
      ).rejects.toThrow('timed out');
      resolveOpen(lateHandle);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fs.promises.open = originalOpen;
    }
  });

  it('stops before open when ownership-record lstat stalls past the deadline', async () => {
    const originalLstat = fs.promises.lstat;
    const originalOpen = fs.promises.open;
    let openStarted = false;
    function stalledLstat(
      pathname: fs.PathLike,
      options?: fs.StatOptions & { bigint?: false }
    ): Promise<fs.Stats>;
    function stalledLstat(
      pathname: fs.PathLike,
      options: fs.StatOptions & { bigint: true }
    ): Promise<fs.BigIntStats>;
    function stalledLstat(
      pathname: fs.PathLike,
      options?: fs.StatOptions
    ): Promise<fs.Stats | fs.BigIntStats>;
    function stalledLstat(
      pathname: fs.PathLike,
      options?: fs.StatOptions
    ): Promise<fs.Stats | fs.BigIntStats> {
      void pathname;
      void options;
      return new Promise<fs.Stats | fs.BigIntStats>(() => undefined);
    }
    fs.promises.lstat = stalledLstat;
    fs.promises.open = (async () => {
      openStarted = true;
      throw new Error('open must not start');
    }) as typeof fs.promises.open;
    try {
      await expect(
        readBoundedRegularTextWithIdentity('/stalled-lstat', 4 * 1024, {
          deadlineMs: Date.now() + 25,
          remainingMetadataOperations: 4,
        })
      ).rejects.toThrow('timed out');
      expect(openStarted).toBe(false);
    } finally {
      fs.promises.lstat = originalLstat;
      fs.promises.open = originalOpen;
    }
  });

  it('does not start work once the recovery deadline has passed', async () => {
    let started = false;

    await expect(
      withinAtomicCreateRecoveryBudget(expiredBudget(), 'test-operation', async () => {
        started = true;
      })
    ).rejects.toThrow('budget exhausted');

    expect(started).toBe(false);
  });

  it('does not start a descriptor read after its metadata allowance is exhausted', async () => {
    const directory = await makeTemporaryDirectory();
    const recordPath = path.join(directory, 'owner.json');
    await fs.promises.writeFile(recordPath, '{}');
    const originalOpen = fs.promises.open;
    const handle = await originalOpen(recordPath, 'r');
    const read = vi.spyOn(handle, 'read');
    fs.promises.open = vi.fn().mockResolvedValue(handle) as typeof fs.promises.open;
    try {
      await expect(
        readBoundedRegularTextWithIdentity(recordPath, 4 * 1024, {
          deadlineMs: Date.now() + 1_000,
          // lstat, open, and fstat are allowed; the read is not.
          remainingMetadataOperations: 3,
        })
      ).rejects.toThrow('budget exhausted');
      expect(read).not.toHaveBeenCalled();
    } finally {
      fs.promises.open = originalOpen;
      await handle.close().catch(() => undefined);
    }
  });

  it('refuses direct record publication without a capacity reservation', async () => {
    const directory = await makeTemporaryDirectory();
    const handle = await fs.promises.open(directory, 'r');
    try {
      await expect(createRecoveryRecord(directory, { pathname: directory, identity: getDurablePathIdentity(await handle.stat()), directoryHandle: handle, stablePath: directory }, 'fake', 'a', 'b', 'c', getDurableFileIdentity(await fs.promises.lstat(path.join(directory, '..'))))).rejects.toThrow('operator reconciliation');
      expect(await fs.promises.readdir(directory)).toEqual([]);
    } finally { await handle.close(); }
  });
  it('retains recordless state when direct record creation is refused', async () => {
    const directory = await makeTemporaryDirectory();
    const handle = await fs.promises.open(directory, 'r');
    try {
      await expect(createRecoveryRecord(directory, { pathname: directory, identity: getDurablePathIdentity(await handle.stat()), directoryHandle: handle, stablePath: directory }, 'fake', 'a', 'b', 'c', getDurableFileIdentity(await fs.promises.lstat(directory)))).rejects.toThrow('operator reconciliation');
      expect((await fs.promises.readdir(directory)).length).toBe(0);
    } finally { await handle.close(); }
  });
  it('rejects a forged record authority before opening descriptors', async () => {
    const directory = await makeTemporaryDirectory();
    const handle = await fs.promises.open(directory, 'r');
    const open = vi.spyOn(fs.promises, 'open');
    try {
      await expect(createRecoveryRecord(directory, { pathname: directory, identity: getDurablePathIdentity(await handle.stat()), directoryHandle: handle, stablePath: directory }, 'fake', 'a', 'b', 'c', getDurableFileIdentity(await handle.stat()))).rejects.toThrow('operator reconciliation');
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); await handle.close(); }
  });
  it('does not start a pending owner write that could outlive its deadline', async () => {
    const directory = await makeTemporaryDirectory();
    const lease = path.join(directory, 'lease');
    await fs.promises.mkdir(lease);
    const open = vi.spyOn(fs.promises, 'open');
    try {
      await withExactGenerationTestOperations(async () => {
        await expect(publishLeaseOwner(directory, 'lease', { version: 1, fence: '12345678-1234-1234-1234-123456789abc', pid: process.pid, incarnation: null }, { deadlineMs: Date.now() + 25, remainingMetadataOperations: 8 })).rejects.toThrow('operator reconciliation');
      });
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); }
  });
  it('retains a pending B alias when publication is refused', async () => {
    const directory = await makeTemporaryDirectory();
    const lease = path.join(directory, 'lease');
    await fs.promises.mkdir(lease);
    const pending = path.join(lease, 'owner.json.pending-12345678-1234-1234-1234-123456789abc');
    await fs.promises.writeFile(pending, 'B');
    await expect(publishLeaseOwner(directory, 'lease', { version: 1, fence: '12345678-1234-1234-1234-123456789abc', pid: process.pid, incarnation: null }, expiredBudget())).rejects.toThrow('operator reconciliation');
    await expect(fs.promises.readFile(pending, 'utf8')).resolves.toBe('B');
  });
  it('refuses count-then-create allocation before exceeding the 64 slot cap', async () => {
    const directory = await makeTemporaryDirectory();
    for (let i = 0; i < 64; i++) await fs.promises.mkdir(path.join(directory, `.review-create-cleanup-${i}`));
    let started = 0;
    await withExactGenerationTestOperations(async () => {
      await expect(allocateAtomicCreateRecoveryDirectory(directory, path.join(directory, '.review-create-cleanup-next-'), async () => { started++; return 63; }, { deadlineMs: Date.now() + 25, remainingMetadataOperations: 8 })).rejects.toThrow('operator reconciliation');
    });
    expect(started).toBe(0);
    expect((await fs.promises.readdir(directory)).length).toBe(64);
  });
  it('refuses a record with a writable self-consistent attachment identity', async () => {
    const directory = await makeTemporaryDirectory();
    const attachment = path.join(directory, 'B');
    await fs.promises.writeFile(attachment, 'B');
    const handle = await fs.promises.open(directory, 'r');
    try {
      await expect(createRecoveryRecord(directory, { pathname: directory, identity: getDurablePathIdentity(await handle.stat()), directoryHandle: handle, stablePath: directory }, 'fake', 'a', 'b', 'B', getDurableFileIdentity(await fs.promises.lstat(attachment)))).rejects.toThrow('operator reconciliation');
      await expect(fs.promises.readFile(attachment, 'utf8')).resolves.toBe('B');
    } finally { await handle.close(); }
  });
  it('rejects a retired recovery record whose directoryName is not a string', () => {
    const malformed = JSON.stringify({
      version: 1,
      nonce: '12345678-1234-1234-1234-123456789abc',
      cleanupAuthority: 'abcdefab-1234-1234-1234-abcdefabcdef',
      directoryName: { includes: true },
      directoryIdentity: { dev: 1, ino: 2, birthtimeMs: 3 },
      attachment: {
        name: '.review-create.12345678-1234-1234-1234-123456789abc.tmp',
        identity: { dev: 1, ino: 4, birthtimeMs: 5, size: 6 },
      },
    });

    expect(parseAtomicCreateRecoveryRecord(malformed, 'retired', true)).toBeNull();
  });
});
