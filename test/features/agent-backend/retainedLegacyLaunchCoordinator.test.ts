import { describe, expect, it, vi } from 'vitest';

import {
  RetainedLegacyLaunchCoordinator,
  RetainedLegacyLaunchRefusal,
} from '../../../src/features/agent-backend/core/application/RetainedLegacyLaunchCoordinator';

import type { RetainedLegacyLaunchAuthority } from '../../../src/features/agent-backend/core/application/RetainedLegacyLaunchCoordinator';

const teamName = 'TEST-original-team';
const request = { teamName, cwd: '/TEST/project', providerId: 'anthropic' as const };
function fixture() {
  let sourceCurrent = true,
    accountCurrent = true,
    now = 1000;
  let absence: 'absent' | 'present' | 'unknown' = 'absent';
  let eligibility: 'stopped' | 'native-custody-unverified' | 'other' = 'native-custody-unverified';
  const calls: string[] = [];
  const run = vi.fn(async (input: { action: string }) => {
    calls.push(`legacy:${input.action}`);
    return input.action === 'launch' ? { runId: 'TEST-original-run' } : null;
  });
  const readImportAbsence = vi.fn(async () => absence);
  const authority: RetainedLegacyLaunchAuthority = {
    sourceKey: 'TEST-physical-source',
    teamName,
    projectPath: '/TEST/project',
    assertSourceCurrent: () => {
      if (!sourceCurrent) throw new RetainedLegacyLaunchRefusal('source-changed');
    },
    assertRuntimeCurrent: () => {
      if (!accountCurrent) throw new RetainedLegacyLaunchRefusal('account-changed');
    },
    readImportAbsence,
    readEligibility: async () => eligibility,
    run: run as RetainedLegacyLaunchAuthority['run'],
    close: vi.fn(async () => undefined),
    cancelModels: vi.fn(async () => ({ ok: true })),
  };
  let ids = 0;
  const owner = new RetainedLegacyLaunchCoordinator({
    capture: async () => authority,
    createId: () => `TEST-scope-${++ids}`,
    now: () => now,
  });
  const open = async (intentId = 'TEST-intent') => {
    const result = await owner.request({ action: 'open', teamName, intentId });
    expect(result).toMatchObject({ ok: true, action: 'open' });
    if (!result.ok || result.action !== 'open') throw new Error('TEST open failed');
    return result.value.scopeId;
  };
  return {
    owner,
    open,
    calls,
    run,
    authority,
    readImportAbsence,
    changeSource: () => {
      sourceCurrent = false;
    },
    changeAccount: () => {
      accountCurrent = false;
    },
    setAbsence: (value: typeof absence) => {
      absence = value;
    },
    setEligibility: (value: typeof eligibility) => {
      eligibility = value;
    },
    advance: () => {
      now += 31 * 60_000;
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('explicit retained original-runtime authority', () => {
  it('keeps unknown physical cleanup debt when bounded cancellation history evicts an old intent', async () => {
    const f = fixture();
    f.setEligibility('other');
    vi.mocked(f.authority.close).mockRejectedValueOnce(new Error('TEST cleanup unknown'));
    expect(
      await f.owner.request({ action: 'open', teamName, intentId: 'TEST-debt' })
    ).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(
      await f.owner.request({ action: 'closeIntent', teamName, intentId: 'TEST-debt' })
    ).toMatchObject({ ok: false, outcome: 'unknown' });
    for (let index = 0; index < 513; index++) {
      expect(
        await f.owner.request({
          action: 'closeIntent',
          teamName: `TEST-unrelated-${index}`,
          intentId: `TEST-close-${index}`,
        })
      ).toMatchObject({ ok: true });
    }
    const publish = vi.fn(async () => 'wrong');
    await expect(f.owner.import('TEST-physical-source', publish)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    const capture = vi.fn(async () => ({ ...f.authority, teamName: 'TEST-alias' }));
    expect(
      await f.owner.request(
        { action: 'open', teamName: 'TEST-alias', intentId: 'TEST-debt' },
        capture,
        'TEST-physical-source'
      )
    ).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(capture).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(f.authority.close).toHaveBeenCalledTimes(1);
  });
  it('refuses a physical alias with cleanup debt before allocating another runtime', async () => {
    const f = fixture();
    f.setEligibility('other');
    vi.mocked(f.authority.close).mockRejectedValueOnce(new Error('TEST cleanup unknown'));
    expect(
      await f.owner.request({ action: 'open', teamName, intentId: 'TEST-debt' })
    ).toMatchObject({ ok: false, outcome: 'unknown' });
    const capture = vi.fn(async () => ({ ...f.authority, teamName: 'TEST-alias' }));
    expect(
      await f.owner.request(
        { action: 'open', teamName: 'TEST-alias', intentId: 'TEST-alias-intent' },
        capture,
        'TEST-physical-source'
      )
    ).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(capture).not.toHaveBeenCalled();
  });
  it.each(['present', 'unknown'] as const)(
    'refuses %s original import before any legacy operation',
    async (state) => {
      const f = fixture();
      f.setAbsence(state);
      expect(
        await f.owner.request({ action: 'open', teamName, intentId: 'TEST-choice' })
      ).toMatchObject({ ok: false, reason: 'import-not-absent', outcome: 'not-dispatched' });
      expect(f.run).not.toHaveBeenCalled();
    }
  );
  it('only admits the exact native-custody refusal, not owner-active or unsupported sources', async () => {
    const f = fixture();
    f.setEligibility('other');
    expect(
      await f.owner.request({ action: 'open', teamName, intentId: 'TEST-choice' })
    ).toMatchObject({ ok: false, reason: 'not-eligible' });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('also preserves an explicitly chosen proven-stopped original before any import', async () => {
    const f = fixture();
    f.setEligibility('stopped');
    await f.open();
    expect(f.run).not.toHaveBeenCalled();
  });
  it('pins status, catalog, preflight and effects to the same original runtime port', async () => {
    const f = fixture(),
      scopeId = await f.open();
    await f.owner.request({ action: 'status', scopeId, projectPath: '/TEST/project' });
    await f.owner.request({
      action: 'models',
      scopeId,
      input: { runtimeId: 'opencode', providerId: 'TEST-provider', projectPath: '/TEST/project' },
    });
    await f.owner.request({ action: 'prepare', scopeId, args: ['/TEST/project', 'anthropic'] });
    await f.owner.request({ action: 'roster', scopeId, request: { members: [] } });
    expect(await f.owner.request({ action: 'launch', scopeId, request })).toEqual({
      ok: true,
      action: 'launch',
      value: { runId: 'TEST-original-run' },
    });
    expect(f.calls).toEqual([
      'legacy:status',
      'legacy:models',
      'legacy:prepare',
      'legacy:roster',
      'legacy:launch',
    ]);
  });
  it('rejects source/profile replacement and account replacement before querying a new owner', async () => {
    for (const kind of ['source', 'account'] as const) {
      const f = fixture(),
        scopeId = await f.open();
      if (kind === 'source') f.changeSource();
      else f.changeAccount();
      expect(
        await f.owner.request({ action: 'status', scopeId, projectPath: '/TEST/project' })
      ).toMatchObject({ ok: false, reason: `${kind}-changed` });
      expect(f.run).not.toHaveBeenCalled();
    }
  });
  it('checks an account change while the original receipt lookup is pending', async () => {
    const f = fixture(),
      scopeId = await f.open(),
      gate = deferred();
    f.readImportAbsence.mockImplementationOnce(async () => {
      await gate.promise;
      return 'absent';
    });
    const pending = f.owner.request({ action: 'roster', scopeId, request: { members: [] } });
    f.changeAccount();
    gate.resolve();
    expect(await pending).toMatchObject({ ok: false, reason: 'account-changed' });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('rejects a different source Team even with a valid opaque choice', async () => {
    const f = fixture(),
      scopeId = await f.open();
    await f.owner.request({ action: 'roster', scopeId, request: { members: [] } });
    expect(
      await f.owner.request({
        action: 'launch',
        scopeId,
        request: { ...request, teamName: 'TEST-neighbor' },
      })
    ).toMatchObject({ ok: false, reason: 'source-changed' });
    expect(f.calls).toEqual(['legacy:roster']);
  });
  it('consumes final Launch once under simultaneous double submission', async () => {
    const f = fixture(),
      scopeId = await f.open(),
      gate = deferred();
    await f.owner.request({ action: 'roster', scopeId, request: { members: [] } });
    f.run.mockImplementationOnce(async () => {
      await gate.promise;
      return { runId: 'TEST-original-run' };
    });
    const first = f.owner.request({ action: 'launch', scopeId, request });
    const second = f.owner.request({ action: 'launch', scopeId, request: { ...request } });
    gate.resolve();
    expect(await first).toEqual(await second);
    expect(f.run).toHaveBeenCalledTimes(2); // one roster + one actual Launch
  });
  it('never sends another native Launch after a lost response or allows import to consume its debt', async () => {
    const f = fixture(),
      scopeId = await f.open();
    await f.owner.request({ action: 'roster', scopeId, request: { members: [] } });
    f.run.mockRejectedValueOnce(new Error('TEST launch sent; reply lost'));
    const launch = { action: 'launch' as const, scopeId, request };
    expect(await f.owner.request(launch)).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(await f.owner.request(launch)).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(await f.owner.request({ action: 'close', scopeId })).toMatchObject({
      ok: false,
      outcome: 'unknown',
    });
    f.advance();
    await expect(f.owner.import('TEST-physical-source', async () => 'wrong')).rejects.toMatchObject(
      { reason: 'busy' }
    );
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('waits for an in-flight import and refuses the now-published original instead of falling back', async () => {
    const f = fixture(),
      gate = deferred();
    const publishing = f.owner.import('TEST-physical-source', async () => {
      await gate.promise;
      f.setAbsence('present');
      return 'published';
    });
    const choice = f.owner.request({ action: 'open', teamName, intentId: 'TEST-choice' });
    gate.resolve();
    await publishing;
    expect(await choice).toMatchObject({ ok: false, reason: 'import-not-absent' });
    expect(f.run).not.toHaveBeenCalled();
  });
  it('blocks a second window import for the entire explicit choice and releases a read-only choice on Close', async () => {
    const f = fixture(),
      scopeId = await f.open(),
      publish = vi.fn(async () => 'published');
    await expect(f.owner.import('TEST-physical-source', publish)).rejects.toMatchObject({
      reason: 'busy',
    });
    expect(publish).not.toHaveBeenCalled();
    expect(await f.owner.request({ action: 'close', scopeId })).toMatchObject({ ok: true });
    expect(await f.owner.import('TEST-physical-source', publish)).toBe('published');
  });
  it('does not retry a changed uncertain roster or launch intent', async () => {
    const f = fixture(),
      scopeId = await f.open();
    f.run.mockRejectedValueOnce(new Error('TEST roster reply lost'));
    await f.owner.request({ action: 'roster', scopeId, request: { members: [] } });
    expect(
      await f.owner.request({
        action: 'roster',
        scopeId,
        request: { members: [{ name: 'alice' }] },
      })
    ).toMatchObject({ ok: false, reason: 'intent-changed' });
    expect(await f.owner.request({ action: 'launch', scopeId, request })).toMatchObject({
      ok: false,
      reason: 'not-eligible',
    });
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('recovers the same explicit open intent without minting another capability', async () => {
    const f = fixture(),
      scopeId = await f.open();
    expect(await f.open()).toBe(scopeId);
    expect(
      await f.owner.request({ action: 'open', teamName, intentId: 'TEST-other-window' })
    ).toMatchObject({ ok: false, reason: 'busy' });
  });
  it('closes each captured authority once when open refuses before retaining it', async () => {
    for (const refusal of ['present', 'unknown', 'ineligible', 'wrong-team'] as const) {
      const f = fixture();
      if (refusal === 'present' || refusal === 'unknown') f.setAbsence(refusal);
      if (refusal === 'ineligible') f.setEligibility('other');
      if (refusal === 'wrong-team') f.authority.teamName = 'TEST-other';
      expect(
        await f.owner.request({ action: 'open', teamName, intentId: 'TEST-choice' })
      ).toMatchObject({ ok: false });
      expect(f.authority.close).toHaveBeenCalledTimes(1);
    }
  });
  it('reclaims expired effect-free choices during open without requiring a later import', async () => {
    const f = fixture(),
      original = await f.open();
    f.advance();
    const replacement = await f.open('TEST-new-choice');
    expect(replacement).not.toBe(original);
    expect(f.authority.close).toHaveBeenCalledTimes(1);
    expect(await f.owner.request({ action: 'read', scopeId: original })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });
  it('explicit close can release a revoked effect-free choice without certifying native release', async () => {
    const f = fixture(),
      scopeId = await f.open();
    f.changeSource();
    f.changeAccount();
    expect(await f.owner.request({ action: 'close', scopeId })).toMatchObject({ ok: true });
    expect(f.authority.close).toHaveBeenCalledTimes(1);
    expect(
      await f.owner.import('TEST-physical-source', async () => 'source reader still decides')
    ).toBe('source reader still decides');
  });
  it('does not reclaim an expired unknown effect when a new choice is requested', async () => {
    const f = fixture(),
      scopeId = await f.open();
    f.run.mockRejectedValueOnce(new Error('TEST uncertain roster'));
    await f.owner.request({ action: 'roster', scopeId, request: { members: [] } });
    f.advance();
    expect(
      await f.owner.request({ action: 'open', teamName, intentId: 'TEST-new-choice' })
    ).toMatchObject({ ok: false, reason: 'busy' });
    expect(f.authority.close).toHaveBeenCalledTimes(1); // only the unretained new capture
    expect(await f.owner.request({ action: 'close', scopeId })).toMatchObject({
      ok: false,
      outcome: 'unknown',
    });
  });
  it('waits for a running read before expiring and closing its original ports', async () => {
    const f = fixture(),
      scopeId = await f.open(),
      entered = deferred(),
      gate = deferred();
    f.run.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return null;
    });
    const reading = f.owner.request({ action: 'read', scopeId });
    await entered.promise;
    f.advance();
    const opening = f.owner.request({ action: 'open', teamName, intentId: 'TEST-replacement' });
    await Promise.resolve();
    expect(f.authority.close).not.toHaveBeenCalled();
    gate.resolve();
    await reading;
    expect(await opening).toMatchObject({ ok: true });
    expect(f.authority.close).toHaveBeenCalledTimes(1);
  });
  it('does not double-close the same authority under simultaneous Close requests', async () => {
    const f = fixture(),
      scopeId = await f.open();
    await Promise.all([
      f.owner.request({ action: 'close', scopeId }),
      f.owner.request({ action: 'close', scopeId }),
    ]);
    expect(f.authority.close).toHaveBeenCalledTimes(1);
  });
  it('retains a source reservation after original helper cleanup has an unknown outcome', async () => {
    const f = fixture(),
      scopeId = await f.open();
    vi.mocked(f.authority.close).mockRejectedValueOnce(new Error('TEST helper close unknown'));
    expect(await f.owner.request({ action: 'close', scopeId })).toMatchObject({
      ok: false,
      outcome: 'unknown',
    });
    expect(await f.owner.request({ action: 'close', scopeId })).toMatchObject({
      ok: false,
      outcome: 'unknown',
    });
    f.advance();
    await expect(f.owner.import('TEST-physical-source', async () => 'wrong')).rejects.toMatchObject(
      { reason: 'busy' }
    );
    expect(f.authority.close).toHaveBeenCalledTimes(1);
  });
  it('reclaims all 32 expired effect-free choices before applying its capacity limit', async () => {
    const f = fixture();
    let now = 0,
      ids = 0;
    const close = vi.fn(async () => {});
    const owner = new RetainedLegacyLaunchCoordinator({
      capture: async (name) => ({ ...f.authority, teamName: name, sourceKey: name, close }),
      createId: () => `TEST-capacity-${++ids}`,
      now: () => now,
      lifetimeMs: 10,
    });
    for (let i = 0; i < 32; i++)
      expect(
        await owner.request({ action: 'open', teamName: `TEST-team-${i}`, intentId: 'TEST-choice' })
      ).toMatchObject({ ok: true });
    now = 11;
    expect(
      await owner.request({ action: 'open', teamName: 'TEST-team-33', intentId: 'TEST-choice' })
    ).toMatchObject({ ok: true });
    expect(close).toHaveBeenCalledTimes(32);
    await owner.shutdown();
  });
  it('cancels a private model load while its serialized read is running after authority revocation', async () => {
    const f = fixture(),
      scopeId = await f.open(),
      entered = deferred(),
      gate = deferred();
    f.run.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return null;
    });
    vi.mocked(f.authority.cancelModels).mockImplementationOnce(async () => {
      gate.resolve();
      return { ok: true };
    });
    const load = f.owner.request({
      action: 'models',
      scopeId,
      input: { runtimeId: 'opencode', providerId: 'TEST', requestGroupId: 'TEST-group' },
    });
    await entered.promise;
    f.changeAccount();
    expect(
      await f.owner.request({
        action: 'cancelModels',
        scopeId,
        input: { requestGroupId: 'TEST-group' },
      })
    ).toMatchObject({ ok: true });
    expect(await load).toMatchObject({ ok: false, reason: 'account-changed' });
    expect(f.authority.cancelModels).toHaveBeenCalledTimes(1);
  });
  it('atomically replaces a zero-effect project choice and recovers the exact rebind intent', async () => {
    const f = fixture(),
      scopeId = await f.open();
    const next = {
      ...f.authority,
      projectPath: '/TEST/second-project',
      close: vi.fn(async () => {}),
    };
    const capture = vi.fn(async () => next);
    const rebind = {
      action: 'rebind' as const,
      scopeId,
      projectPath: next.projectPath,
      intentId: 'TEST-rebind',
    };
    const [first, duplicate] = await Promise.all([
      f.owner.request(rebind, capture),
      f.owner.request(rebind, capture),
    ]);
    expect(first).toMatchObject({
      ok: true,
      action: 'rebind',
      value: { projectPath: next.projectPath },
    });
    expect(duplicate).toEqual(first);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await f.owner.request(rebind, capture)).toEqual(first);
    expect(await f.owner.request({ ...rebind, projectPath: '/TEST/third' }, capture)).toMatchObject(
      { ok: false, reason: 'intent-changed' }
    );
    expect(await f.owner.request({ action: 'close', scopeId })).toMatchObject({ ok: false });
    expect(next.close).not.toHaveBeenCalled();
    expect(f.authority.close).toHaveBeenCalledTimes(1);
    await f.owner.shutdown();
  });
  it('refuses rebind while preflight runs and permits it after conclusive zero-Team-effect completion', async () => {
    const f = fixture(),
      scopeId = await f.open(),
      entered = deferred(),
      gate = deferred();
    f.run.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return null;
    });
    const preparing = f.owner.request({ action: 'prepare', scopeId, args: ['/TEST/project'] });
    await entered.promise;
    const change = {
      action: 'rebind' as const,
      scopeId,
      projectPath: '/TEST/second',
      intentId: 'TEST-rebind',
    };
    const capture = vi.fn(async () => ({ ...f.authority, projectPath: change.projectPath }));
    expect(await f.owner.request(change, capture)).toMatchObject({ ok: false, reason: 'busy' });
    expect(capture).not.toHaveBeenCalled();
    gate.resolve();
    await preparing;
    expect(await f.owner.request(change, capture)).toMatchObject({ ok: true, action: 'rebind' });
  });
  it.each(['roster', 'uncertain-read'] as const)(
    'refuses project rebinding after %s',
    async (kind) => {
      const f = fixture(),
        scopeId = await f.open();
      if (kind === 'roster')
        await f.owner.request({ action: 'roster', scopeId, request: { members: [] } });
      else {
        f.run.mockRejectedValueOnce(new Error('TEST uncertain cleanup'));
        await f.owner.request({ action: 'prepare', scopeId, args: [] });
      }
      const capture = vi.fn(async () => f.authority);
      expect(
        await f.owner.request(
          { action: 'rebind', scopeId, projectPath: '/TEST/second', intentId: 'TEST-rebind' },
          capture
        )
      ).toMatchObject({ ok: false });
      expect(capture).not.toHaveBeenCalled();
    }
  );
  it('refuses a different physical source or newly imported source during project rebind', async () => {
    for (const kind of ['source', 'receipt'] as const) {
      const f = fixture(),
        scopeId = await f.open();
      const next = {
        ...f.authority,
        close: vi.fn(async () => {}),
        ...(kind === 'source'
          ? { sourceKey: 'TEST-neighbor' }
          : { readImportAbsence: async () => 'present' as const }),
      };
      expect(
        await f.owner.request(
          { action: 'rebind', scopeId, projectPath: '/TEST/second', intentId: 'TEST-rebind' },
          async () => next
        )
      ).toMatchObject({ ok: false });
      expect(next.close).toHaveBeenCalledTimes(1);
      expect(f.authority.close).not.toHaveBeenCalled();
    }
  });
  it('closes an unknown open response by exact intent after context revocation', async () => {
    const f = fixture(),
      scopeId = await f.open();
    f.changeSource();
    expect(
      await f.owner.request({ action: 'closeIntent', teamName, intentId: 'TEST-intent' })
    ).toMatchObject({ ok: true });
    expect(f.authority.close).toHaveBeenCalledTimes(1);
    expect(await f.owner.request({ action: 'read', scopeId })).toMatchObject({ ok: false });
  });
  it('cancels a pending open before it can allocate an orphan choice', async () => {
    const f = fixture(),
      entered = deferred(),
      gate = deferred();
    const opening = f.owner.request(
      { action: 'open', teamName, intentId: 'TEST-pending' },
      async () => {
        entered.resolve();
        await gate.promise;
        return f.authority;
      }
    );
    await entered.promise;
    const closing = f.owner.request({ action: 'closeIntent', teamName, intentId: 'TEST-pending' });
    gate.resolve();
    expect(await opening).toMatchObject({ ok: false });
    expect(await closing).toMatchObject({ ok: true });
    expect(f.authority.close).toHaveBeenCalledTimes(1);
    expect(await f.owner.import('TEST-physical-source', async () => 'TEST no orphan')).toBe(
      'TEST no orphan'
    );
  });
  it('cleans a lost-ACK rebind by its own exact intent without treating old Close as new Close', async () => {
    const f = fixture(),
      scopeId = await f.open(),
      next = { ...f.authority, close: vi.fn(async () => {}) };
    expect(
      await f.owner.request(
        { action: 'rebind', scopeId, projectPath: '/TEST/second', intentId: 'TEST-rebound' },
        async () => next
      )
    ).toMatchObject({ ok: true });
    await f.owner.request({ action: 'close', scopeId });
    expect(next.close).not.toHaveBeenCalled();
    expect(
      await f.owner.request({ action: 'closeIntent', teamName, intentId: 'TEST-rebound' })
    ).toMatchObject({ ok: true });
    expect(next.close).toHaveBeenCalledTimes(1);
  });
  it('cancels a pending rebind by intent, retaining the untouched old choice until its own Close', async () => {
    const f = fixture(),
      scopeId = await f.open(),
      entered = deferred(),
      gate = deferred();
    const next = { ...f.authority, close: vi.fn(async () => {}) };
    const changing = f.owner.request(
      { action: 'rebind', scopeId, projectPath: '/TEST/second', intentId: 'TEST-rebound' },
      async () => {
        entered.resolve();
        await gate.promise;
        return next;
      }
    );
    await entered.promise;
    const closing = f.owner.request({ action: 'closeIntent', teamName, intentId: 'TEST-rebound' });
    gate.resolve();
    expect(await changing).toMatchObject({ ok: false });
    expect(await closing).toMatchObject({ ok: true });
    expect(next.close).toHaveBeenCalledTimes(1);
    expect(f.authority.close).not.toHaveBeenCalled();
    expect(await f.owner.request({ action: 'close', scopeId })).toMatchObject({ ok: true });
  });
  it('never uses intent cleanup to erase an uncertain Team effect', async () => {
    const f = fixture(),
      scopeId = await f.open();
    f.run.mockRejectedValueOnce(new Error('TEST dispatched, ACK lost'));
    await f.owner.request({ action: 'roster', scopeId, request: { members: [] } });
    expect(
      await f.owner.request({ action: 'closeIntent', teamName, intentId: 'TEST-intent' })
    ).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(f.authority.close).not.toHaveBeenCalled();
  });
  it('retains cleanup debt when a cancelled pending open cannot close its unpublished authority', async () => {
    const f = fixture(),
      entered = deferred(),
      gate = deferred();
    vi.mocked(f.authority.close).mockRejectedValueOnce(new Error('TEST helper cleanup unknown'));
    const opening = f.owner.request(
      { action: 'open', teamName, intentId: 'TEST-pending' },
      async () => {
        entered.resolve();
        await gate.promise;
        return f.authority;
      }
    );
    await entered.promise;
    const closing = f.owner.request({ action: 'closeIntent', teamName, intentId: 'TEST-pending' });
    gate.resolve();
    expect(await opening).toMatchObject({
      ok: false,
      reason: 'outcome-unknown',
      outcome: 'unknown',
    });
    expect(await closing).toMatchObject({
      ok: false,
      reason: 'outcome-unknown',
      outcome: 'unknown',
    });
    await expect(f.owner.import('TEST-physical-source', async () => 'wrong')).rejects.toMatchObject(
      { reason: 'outcome-unknown' }
    );
    expect(
      await f.owner.request({ action: 'open', teamName, intentId: 'TEST-fresh' })
    ).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(f.authority.close).toHaveBeenCalledTimes(1);
  });
  it('keeps unknown new-authority cleanup after the old scope already closed during rebind', async () => {
    const f = fixture(),
      scopeId = await f.open();
    let revoked = false;
    vi.mocked(f.authority.close).mockImplementationOnce(async () => {
      revoked = true;
    });
    const next = {
      ...f.authority,
      assertRuntimeCurrent: () => {
        if (revoked) throw new RetainedLegacyLaunchRefusal('account-changed');
      },
      close: vi.fn(async () => {
        throw new Error('TEST new helper cleanup unknown');
      }),
    };
    const result = await f.owner.request(
      { action: 'rebind', scopeId, projectPath: '/TEST/new-project', intentId: 'TEST-rebound' },
      async () => next
    );
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(
      await f.owner.request({ action: 'closeIntent', teamName, intentId: 'TEST-rebound' })
    ).toMatchObject({ ok: false, outcome: 'unknown' });
    await expect(f.owner.import('TEST-physical-source', async () => 'wrong')).rejects.toMatchObject(
      { reason: 'outcome-unknown' }
    );
    expect(next.close).toHaveBeenCalledTimes(1);
    expect(f.authority.close).toHaveBeenCalledTimes(1);
  });
  it('holds the physical queue through unpublished candidate cleanup before admitting an import', async () => {
    const f = fixture(),
      closing = deferred(),
      gate = deferred(),
      publish = vi.fn(async () => 'wrong');
    f.setEligibility('other');
    vi.mocked(f.authority.close).mockImplementationOnce(async () => {
      closing.resolve();
      await gate.promise;
      throw new Error('TEST close unknown');
    });
    const opening = f.owner.request({ action: 'open', teamName, intentId: 'TEST-candidate' });
    await closing.promise;
    const importing = f.owner.import('TEST-physical-source', publish);
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    gate.resolve();
    expect(await opening).toMatchObject({ ok: false, outcome: 'unknown' });
    await expect(importing).rejects.toMatchObject({ reason: 'outcome-unknown' });
    expect(publish).not.toHaveBeenCalled();
  });
});
