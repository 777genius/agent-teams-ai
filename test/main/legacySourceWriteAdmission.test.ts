import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLegacySourceWriteAdmissionPolicy } from '../../src/main/composition/legacySourceWriteAdmission';
import { withTeamLaunchStatePublicationLock } from '../../src/main/services/team/TeamLaunchStateStore';

const qualified = vi.hoisted(() => new Set<string>());
vi.mock('../../src/main/services/team/provisioning/LegacyNativeStopRelease', () => ({
  readLegacyNativeStopRelease: (path: string) => (qualified.has(path) ? {} : null),
}));

let root: string;
const teamName = 'test-original-source';
const makePolicy = (selectedHost = true, isCurrentOwner = () => true) =>
  createLegacySourceWriteAdmissionPolicy({
    teamsRoot: root,
    selectedHost,
    isCurrentOwner,
    withIdentityFence: (_team, operation) => operation(),
  });
const admitted = (policy = makePolicy(), name = teamName) => {
  const result = policy.capture(name);
  if (result.kind !== 'admitted') throw new Error('Expected mutable source');
  return result;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(async () => {
  qualified.clear();
  root = await mkdtemp(join(tmpdir(), 'TEST-legacy-source-admission-'));
  await mkdir(join(root, teamName));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('captured legacy source write admission', () => {
  it('denies only a positive canonical release under the selected Host', () => {
    qualified.add(join(root, teamName));
    expect(makePolicy().capture(teamName).kind).toBe('read-only');
    expect(makePolicy(false).capture(teamName).kind).toBe('admitted');
  });

  it('preserves the existing lifecycle Team-name grammar without granting path traversal', async () => {
    const name = 'Команда с пробелом.v1';
    await mkdir(join(root, name));
    expect(makePolicy().capture(name).kind).toBe('admitted');
    for (const invalid of ['../outside', '..', '.', 'nested/team', 'nested\\team', 'bad\0name'])
      expect(() => makePolicy().capture(invalid)).toThrow('Unsafe team name');
  });

  it('holds the publication queue through an interrupted worker physical tail', async () => {
    const started = deferred(),
      physical = deferred();
    const failure = new InternalStorageOperationInterruptedError(
      'TEST early RPC rejection',
      'unknown',
      physical.promise
    );
    const policy = createLegacySourceWriteAdmissionPolicy({
      teamsRoot: root,
      selectedHost: true,
      isCurrentOwner: () => true,
      withIdentityFence: (_team, operation) => operation(),
      settleInterrupted: async (error) => {
        if (error instanceof InternalStorageOperationInterruptedError)
          await Promise.allSettled([error.settled]);
      },
    });
    const original = admitted(policy);
    const order: string[] = [];
    const publication = original.run(() =>
      original.publish(async () => {
        started.resolve();
        throw failure;
      })
    );
    const rejected = expect(publication).rejects.toBe(failure);
    await started.promise;
    const stop = withTeamLaunchStatePublicationLock(teamName, async () => {
      order.push('stop');
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    order.push('physical-settled');
    physical.resolve();
    await rejected;
    await stop;
    expect(order).toEqual(['physical-settled', 'stop']);
  });

  it('retains the original restriction after an await and never recaptures a replacement', async () => {
    const policy = makePolicy();
    const original = admitted(policy);
    const barrier = deferred();
    const started = deferred();
    const write = vi.fn(async () => undefined);
    const work = original.run(async () => {
      started.resolve();
      await barrier.promise;
      return policy.current(teamName).publish(write);
    });
    await started.promise;
    await rename(join(root, teamName), join(root, 'old-source'));
    await mkdir(join(root, teamName));
    barrier.resolve();
    await expect(work).rejects.toThrow('directory changed');
    expect(write).not.toHaveBeenCalled();
    expect(policy.capture(teamName).kind).toBe('admitted');
  });

  it('blocks an already-admitted continuation when canonical release appears', async () => {
    const policy = makePolicy();
    const original = admitted(policy);
    const barrier = deferred();
    const started = deferred();
    const write = vi.fn(async () => undefined);
    const work = original.run(async () => {
      started.resolve();
      await barrier.promise;
      return policy.current(teamName).publish(write);
    });
    await started.promise;
    qualified.add(join(root, teamName));
    barrier.resolve();
    await expect(work).rejects.toThrow('read-only');
    expect(write).not.toHaveBeenCalled();
  });

  it('requires an explicit scope and rejects cross-source and nested fresh admission', async () => {
    const policy = makePolicy();
    const original = admitted(policy);
    expect(() => policy.current(teamName)).toThrow('Missing original');
    await original.run(async () => {
      expect(policy.current(teamName)).toBe(original);
      expect(() => policy.current('another-team')).toThrow('Missing original');
      expect(policy.capture(teamName)).toBe(original);
    });
    expect(() => original.publish(async () => undefined)).toThrow('Missing original');
  });

  it('allows nested local publication but rejects its detached expired ownership token', async () => {
    const original = admitted();
    const barrier = deferred();
    const write = vi.fn(async () => undefined);
    let late!: Promise<void>;
    await original.run(async () => {
      await original.publish(async () => {
        await original.publish(write);
        late = barrier.promise.then(() => original.publish(write));
      });
    });
    barrier.resolve();
    await expect(late).rejects.toThrow('publication ownership expired');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('holds the publication queue until a nested physical child settles even when not awaited', async () => {
    const original = admitted();
    const barrier = deferred();
    const started = deferred();
    const order: string[] = [];
    const publication = original.run(() =>
      original.publish(async () => {
        void original.publish(async () => {
          started.resolve();
          await barrier.promise;
          order.push('physical-write');
        });
      })
    );
    await started.promise;
    const stop = withTeamLaunchStatePublicationLock(teamName, async () => {
      order.push('stop-publication');
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    barrier.resolve();
    await publication;
    await stop;
    expect(order).toEqual(['physical-write', 'stop-publication']);
  });

  it('permits first member-directory creation and metadata writes under the existing Team', async () => {
    const policy = makePolicy();
    const original = admitted(policy);
    const member = join(root, teamName, 'members', 'team-lead');
    await original.run(async () => {
      await original.publish(() => mkdir(member, { recursive: true }));
      await policy
        .current(teamName)
        .publish(() => writeFile(join(member, 'member.meta.json'), '{}'));
    });
    expect(await readFile(join(member, 'member.meta.json'), 'utf8')).toBe('{}');
  });

  it('retains absence rather than adopting a newly appeared Team directory', async () => {
    const original = admitted(makePolicy(), 'missing-source');
    expect(() => original.assertCurrent()).not.toThrow();
    await mkdir(join(root, 'missing-source'));
    expect(() => original.assertCurrent()).toThrow('directory changed');
  });

  it('revokes an original admission when its captured owner is replaced', async () => {
    let current = true;
    const original = admitted(makePolicy(true, () => current));
    current = false;
    expect(() => original.assertCurrent()).toThrow('owner changed');
  });
});
