import {
  InternalStorageOperationInterruptedError,
  KeyedMutex,
} from '@features/internal-storage/main';
import { MemberWorkSyncTeamOperationGate } from '@features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import { MemberWorkSyncStatusAuthority } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStatusAuthority';
import { describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
import type {
  MemberWorkSyncAuthorityRawSnapshot,
  MemberWorkSyncPreparedStatusBackend,
  MemberWorkSyncStatusAuthorityDeps,
} from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStatusAuthority';

const member = { teamName: 'sandbox', memberName: 'alice' };
const incarnation = 'inc-1';
const time = '2026-09-10T00:00:00.000Z';
function status(): MemberWorkSyncStatus {
  return {
    ...member,
    state: 'needs_sync',
    evaluatedAt: time,
    diagnostics: [],
    agenda: { ...member, generatedAt: time, fingerprint: 'agenda', items: [], diagnostics: [] },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(initial: MemberWorkSyncStatus | null = status()) {
  let raw: MemberWorkSyncAuthorityRawSnapshot = initial
    ? { state: 'present', raw: JSON.stringify(initial, null, 2) + '\n', payload: initial }
    : { state: 'absent', raw: null };
  let held = false;
  let currentIncarnation = incarnation;
  const mutex = new KeyedMutex();
  const backend: MemberWorkSyncPreparedStatusBackend = {
    kind: 'sqlite',
    read: vi.fn(async () => raw),
    compareAndWrite: vi.fn<MemberWorkSyncPreparedStatusBackend['compareAndWrite']>(
      async (input) => {
        if (raw.state === 'corrupt' || raw.state === 'unavailable')
          return { committed: false, reason: raw.state };
        if (raw.raw !== input.expectedRaw)
          return { committed: false, reason: 'conflict', current: raw };
        raw = {
          state: 'present',
          raw: JSON.stringify(input.nextStatus),
          payload: input.nextStatus,
        };
        return { committed: true, snapshot: raw };
      }
    ),
  };
  const identity: MemberWorkSyncStatusAuthorityDeps['identity'] = {
    readCurrent: vi.fn<MemberWorkSyncStatusAuthorityDeps['identity']['readCurrent']>(async () => ({
      status: 'identified',
      identityId: currentIncarnation,
    })),
    adoptLegacy: vi.fn<MemberWorkSyncStatusAuthorityDeps['identity']['adoptLegacy']>(async () => ({
      status: 'identified',
      identityId: currentIncarnation,
    })),
    withCurrent: async (_teamName, expected, operation) =>
      mutex.run('identity', async () => {
        if (expected !== currentIncarnation)
          return {
            current: false,
            identity: { status: 'identified', identityId: currentIncarnation },
          };
        held = true;
        try {
          return { current: true, value: await operation() };
        } finally {
          held = false;
        }
      }),
  };
  const deps: MemberWorkSyncStatusAuthorityDeps = {
    identity,
    withPreparedBackend: async (_identity, operation) => operation(backend),
  };
  const authority = new MemberWorkSyncStatusAuthority(deps);
  const read = async () => {
    const call = authority.startRead(member);
    const result = await call.result;
    await call.settled;
    if (!result.ok) throw new Error(result.reason);
    return result.snapshot;
  };
  const input = async () => ({
    ...member,
    incarnation,
    expectedToken: (await read()).token,
    mutationId: 'mutation-1',
    nextStatus: status(),
  });
  return {
    authority,
    backend,
    deps,
    identity,
    read,
    input,
    held: () => held,
    setRaw: (value: MemberWorkSyncAuthorityRawSnapshot) => {
      raw = value;
    },
    recreate: () => {
      currentIncarnation = 'inc-2';
    },
  };
}

describe('status authority physical lifetime', () => {
  it('defers effects so the same physical lifetime can be registered first', async () => {
    const h = harness();
    const call = h.authority.startRead(member);
    expect(h.identity.readCurrent).not.toHaveBeenCalled();
    await expect(call.result).resolves.toMatchObject({ ok: true });
    await call.settled;
    expect(h.held()).toBe(false);
  });

  it('mints legacy revision and rejects a stale token without a second write', async () => {
    const h = harness();
    const input = await h.input();
    const first = h.authority.startCompareAndWrite(input);
    const accepted = await first.result;
    await first.settled;
    expect(accepted).toMatchObject({
      committed: true,
      snapshot: { status: { statusRevision: { incarnation, sequence: 1 } } },
    });
    const second = h.authority.startCompareAndWrite(input);
    await expect(second.result).resolves.toMatchObject({ committed: false, reason: 'conflict' });
    await second.settled;
    expect(h.backend.compareAndWrite).toHaveBeenCalledTimes(1);
  });

  it.each(['preparation', 'cas'] as const)(
    'retains the gate and identity fence after %s interruption',
    async (phase) => {
      const h = harness();
      const input = await h.input();
      const exit = deferred();
      const error = new InternalStorageOperationInterruptedError(
        'timeout',
        'unknown',
        exit.promise
      );
      if (phase === 'preparation')
        h.deps.withPreparedBackend = async () => {
          throw error;
        };
      else
        h.backend.compareAndWrite = vi.fn<MemberWorkSyncPreparedStatusBackend['compareAndWrite']>(
          async () => {
            throw error;
          }
        );
      const gate = new MemberWorkSyncTeamOperationGate();
      const logical = gate.run(member.teamName, async (admission) => {
        const call = h.authority.startCompareAndWrite(input);
        admission.trackSettling(call.settled);
        return call.result;
      });
      await expect(logical).resolves.toMatchObject(
        phase === 'cas'
          ? { committed: 'unknown', mutationId: 'mutation-1' }
          : { committed: false, reason: 'unavailable' }
      );
      gate.beginTeamQuiesce(member.teamName);
      let drained = false;
      const drain = gate.awaitTeamIdle(member.teamName).then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(h.held()).toBe(true);
      expect(drained).toBe(false);
      if (phase === 'preparation') expect(h.backend.compareAndWrite).not.toHaveBeenCalled();
      exit.resolve();
      await drain;
      expect(h.held()).toBe(false);
    }
  );

  it('distinguishes a queued CAS that never reached the writer', async () => {
    const h = harness();
    const input = await h.input();
    const exit = deferred();
    h.backend.compareAndWrite = vi.fn<MemberWorkSyncPreparedStatusBackend['compareAndWrite']>(
      async () => {
        throw new InternalStorageOperationInterruptedError('queued', 'not_started', exit.promise);
      }
    );
    const call = h.authority.startCompareAndWrite(input);
    await expect(call.result).resolves.toEqual({ committed: false, reason: 'unavailable' });
    expect(h.held()).toBe(true);
    exit.resolve();
    await call.settled;
  });

  it('keeps known commit when replica publication is interrupted', async () => {
    const h = harness();
    const input = await h.input();
    const exit = deferred();
    h.deps.withPreparedBackend = async (_identity, operation) => {
      await operation(h.backend);
      throw new InternalStorageOperationInterruptedError('replica', 'unknown', exit.promise);
    };
    const call = h.authority.startCompareAndWrite(input);
    await expect(call.result).resolves.toMatchObject({
      committed: true,
      projectionDegraded: ['backend_or_lifecycle'],
    });
    expect(h.held()).toBe(true);
    exit.resolve();
    await call.settled;
    expect(h.backend.compareAndWrite).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown CAS outcome through a later projection failure', async () => {
    const h = harness();
    const input = await h.input();
    h.backend.compareAndWrite = vi.fn<MemberWorkSyncPreparedStatusBackend['compareAndWrite']>(
      async () => ({ committed: 'unknown', reason: 'commit_unknown', mutationId: 'mutation-1' })
    );
    h.deps.withPreparedBackend = async (_identity, operation) => {
      await operation(h.backend);
      throw new Error('projection');
    };
    const call = h.authority.startCompareAndWrite(input);
    await expect(call.result).resolves.toEqual({
      committed: 'unknown',
      reason: 'commit_unknown',
      mutationId: 'mutation-1',
    });
    await call.settled;
  });

  it('returns a raw unknown outcome before a delayed projection finishes', async () => {
    const h = harness();
    const input = await h.input();
    const release = deferred();
    h.backend.compareAndWrite = vi.fn<MemberWorkSyncPreparedStatusBackend['compareAndWrite']>(
      async () => ({ committed: 'unknown', reason: 'commit_unknown', mutationId: 'mutation-1' })
    );
    h.deps.withPreparedBackend = async (_identity, operation) => {
      const outcome = await operation(h.backend);
      await release.promise;
      return outcome;
    };
    const call = h.authority.startCompareAndWrite(input);
    let settled = false;
    void call.settled.then(() => {
      settled = true;
    });
    try {
      await expect(call.result).resolves.toMatchObject({ committed: 'unknown' });
      expect(h.held()).toBe(true);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await call.settled;
    }
  });

  it('does not interpret an unclassified CAS failure as proven rollback', async () => {
    const h = harness();
    const input = await h.input();
    h.backend.compareAndWrite = vi.fn<MemberWorkSyncPreparedStatusBackend['compareAndWrite']>(
      async () => {
        throw new Error('ack decoding failed');
      }
    );
    const call = h.authority.startCompareAndWrite(input);
    await expect(call.result).resolves.toMatchObject({
      committed: 'unknown',
      mutationId: 'mutation-1',
    });
    await call.settled;
  });

  it('does not claim no write when an acknowledged commit returns invalid payload', async () => {
    const h = harness();
    const input = await h.input();
    h.backend.compareAndWrite = vi.fn<MemberWorkSyncPreparedStatusBackend['compareAndWrite']>(
      async () => ({ committed: true, snapshot: { state: 'present', raw: '{}', payload: {} } })
    );
    const call = h.authority.startCompareAndWrite(input);
    await expect(call.result).resolves.toMatchObject({ committed: 'unknown' });
    await call.settled;
  });

  it.each(['token', 'incarnation', 'corrupt'] as const)('refuses %s before CAS', async (kind) => {
    const h = harness();
    const input = await h.input();
    if (kind === 'token') input.expectedToken = '{}';
    if (kind === 'incarnation') h.recreate();
    if (kind === 'corrupt') h.setRaw({ state: 'corrupt' });
    const call = h.authority.startCompareAndWrite(input);
    await expect(call.result).resolves.toMatchObject({
      committed: false,
      reason: kind === 'token' ? 'invalid_token' : kind === 'incarnation' ? 'inactive' : 'corrupt',
    });
    await call.settled;
    expect(h.backend.compareAndWrite).not.toHaveBeenCalled();
  });
});
