import { DetailReadCoordinator } from '@features/member-log-reads/main';
import { describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const coordinator = new DetailReadCoordinator<string>();
  const source = {};
  const builds: ReturnType<typeof deferred<string | null>>[] = [];
  const releases: number[] = [];
  let prepares = 0;
  const read = (owner: object, fresh = false, address = 'synthetic-session') =>
    coordinator.subscribe({
      key: address,
      source,
      owner,
      fresh,
      prepare: () => {
        const id = prepares++;
        let current = true;
        return {
          isCurrent: () => current,
          execute: () => {
            const build = deferred<string | null>();
            builds.push(build);
            return build.promise;
          },
          release: () => {
            current = false;
            releases.push(id);
          },
        };
      },
    });
  return { coordinator, read, builds, releases, prepares: () => prepares };
}

describe('detail read subscription contract', () => {
  it('does not cancel shared work when one subscriber leaves', async () => {
    const { read, builds, releases } = fixture();
    const first = read({});
    const second = read({});
    await vi.waitFor(() => expect(builds).toHaveLength(1));
    first.dispose();
    first.dispose();
    expect(await first.result).toEqual({ status: 'disposed' });
    expect(releases).toEqual([]);
    builds[0].resolve('shared');
    expect(await second.result).toEqual({ status: 'success', value: 'shared' });
    expect(releases).toEqual([0]);
  });

  it('removes abandoned pending work and releases each permit once', async () => {
    const { read, builds, releases } = fixture();
    const active = read({});
    await vi.waitFor(() => expect(builds).toHaveLength(1));
    const pending = read({}, true);
    pending.dispose();
    pending.dispose();
    expect(await pending.result).toEqual({ status: 'disposed' });
    builds[0].resolve('active');
    expect(await active.result).toEqual({ status: 'success', value: 'active' });
    await Promise.resolve();
    expect(builds).toHaveLength(1);
    expect(releases.toSorted((a, b) => a - b)).toEqual([0, 1]);
  });

  it('retires only one adapter while another owner still needs the same physical read', async () => {
    const { coordinator, read, builds, releases } = fixture();
    const adapterA = {};
    const retired = read(adapterA);
    const survivor = read({});
    await vi.waitFor(() => expect(builds).toHaveLength(1));
    coordinator.retireOwner(adapterA);
    expect(await retired.result).toEqual({ status: 'superseded' });
    expect(releases).toEqual([]);
    builds[0].resolve('survivor');
    expect(await survivor.result).toEqual({ status: 'success', value: 'survivor' });
    expect(releases).toEqual([0]);
  });

  it('starts a queued fresh read after the predecessor fails', async () => {
    const { read, builds, releases } = fixture();
    const active = read({});
    await vi.waitFor(() => expect(builds).toHaveLength(1));
    const fresh = read({}, true);
    const failure = new Error('observable filesystem failure');
    builds[0].reject(failure);
    expect(await active.result).toEqual({ status: 'failure', error: failure });
    await vi.waitFor(() => expect(builds).toHaveLength(2));
    builds[1].resolve(null);
    expect(await fresh.result).toEqual({ status: 'success', value: null });
    expect(releases).toEqual([0, 1]);
  });

  it('does not retain a completed result as a later read', async () => {
    const { read, builds, prepares } = fixture();
    const first = read({});
    await vi.waitFor(() => expect(builds).toHaveLength(1));
    builds[0].resolve('first');
    await first.result;
    const second = read({});
    await vi.waitFor(() => expect(builds).toHaveLength(2));
    builds[1].resolve('second');
    expect(await second.result).toEqual({ status: 'success', value: 'second' });
    expect(prepares()).toBe(2);
  });

  it('settles all owners on disposal and never admits another build', async () => {
    const { coordinator, read, builds, releases, prepares } = fixture();
    const active = read({});
    await vi.waitFor(() => expect(builds).toHaveLength(1));
    const pending = read({}, true);
    coordinator.dispose();
    coordinator.dispose();
    expect(await active.result).toEqual({ status: 'disposed' });
    expect(await pending.result).toEqual({ status: 'disposed' });
    expect(await read({}).result).toEqual({ status: 'disposed' });
    builds[0].resolve('retired');
    await Promise.resolve();
    expect(builds).toHaveLength(1);
    expect(prepares()).toBe(2);
    expect(releases.toSorted((a, b) => a - b)).toEqual([0, 1]);
  });
});
