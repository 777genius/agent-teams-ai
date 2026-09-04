import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAnnouncementState,
  normalizeAnnouncementFeed,
} from '../../../../src/features/announcements/core/domain';
import { AnnouncementsService } from '../../../../src/features/announcements/main/application/AnnouncementsService';
import { AnnouncementUsageTracker } from '../../../../src/features/announcements/main/application/AnnouncementUsageTracker';
import { AnnouncementWriterOwner } from '../../../../src/features/announcements/main/infrastructure/AnnouncementWriterOwner';
import { JsonAnnouncementRepository } from '../../../../src/features/announcements/main/infrastructure/JsonAnnouncementRepository';

const initial = () =>
  createAnnouncementState('fresh', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');
const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'announcements-test-'));
  directories.push(value);
  return value;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('durable repository and writer ownership', () => {
  it('serializes checkpoint and consumption and repairs missing marker', async () => {
    const dir = await directory();
    const repo = new JsonAnnouncementRepository(dir);
    await repo.initialize(initial());
    await Promise.all([
      repo.update((s) => ({ ...s, accumulatedOpenMs: 5000 })),
      repo.update((s) => ({
        ...s,
        handledIds: ['news'],
        autoSuppressedThrough: { id: 'news', publishedAt: '2026-09-01T00:00:00.000Z' },
      })),
    ]);
    await rm(join(dir, 'initialized.json'));
    const recovered = await new JsonAnnouncementRepository(dir).initialize(initial());
    expect(recovered.accumulatedOpenMs).toBe(5000);
    expect(recovered.handledIds).toEqual(['news']);
    expect(JSON.parse(await readFile(join(dir, 'initialized.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
    });
  });
  it.each(['missing', 'corrupt', 'future'])(
    'fails closed with %s state and existing marker',
    async (mode) => {
      const dir = await directory();
      await writeFile(join(dir, 'initialized.json'), '{"schemaVersion":1}');
      if (mode !== 'missing')
        await writeFile(
          join(dir, 'state.json'),
          mode === 'corrupt' ? 'broken' : '{"schemaVersion":2}'
        );
      await expect(new JsonAnnouncementRepository(dir).initialize(initial())).rejects.toThrow();
    }
  );
  it('does not claim initialization success when marker durability fails', async () => {
    const dir = await directory();
    const writer = async (file: string, value: unknown) => {
      if (file.endsWith('initialized.json')) throw new Error('disk full');
      await writeFile(file, JSON.stringify(value));
    };
    const repo = new JsonAnnouncementRepository(dir, writer);
    await expect(repo.initialize(initial())).rejects.toThrow('disk full');
    await expect(repo.update((s) => s)).rejects.toThrow('state_unavailable');
    expect(await new JsonAnnouncementRepository(dir).initialize(initial())).toEqual(initial());
  });
  it('never steals alive/uncertain PID, recovers proven dead, and fences old release', async () => {
    const dir = await directory();
    const first = new AnnouncementWriterOwner(dir);
    expect(await first.acquire()).toBe(true);
    expect(await new AnnouncementWriterOwner(dir, () => 'unknown').acquire()).toBe(false);
    expect(await new AnnouncementWriterOwner(dir, () => 'alive').acquire()).toBe(false);
    const replacement = new AnnouncementWriterOwner(dir, () => 'dead');
    expect(await replacement.acquire()).toBe(true);
    await first.release();
    expect(await new AnnouncementWriterOwner(dir, () => 'alive').acquire()).toBe(false);
    await replacement.release();
    expect(await first.acquire()).toBe(true);
    await first.release();
  });
});

it('counts union of windows, excludes sleep, last-window gaps and missed heartbeats', () => {
  let mono = 0;
  const tracker = new AnnouncementUsageTracker({ now: () => 0, monotonic: () => mono });
  tracker.setEnabled(true);
  tracker.register(1);
  mono = 5000;
  tracker.register(2);
  mono = 10000;
  tracker.unregister(1);
  mono = 15000;
  tracker.suspend();
  mono = 100000;
  tracker.resume();
  mono = 105000;
  tracker.unregister(2);
  mono = 200000;
  tracker.register(3);
  mono = 220000;
  tracker.tick();
  mono = 225000;
  tracker.tick();
  expect(tracker.takePending()).toBe(25000);
});

function fixture() {
  let now = Date.parse('2026-09-04T01:00:00Z');
  let mono = 0;
  let saved = initial();
  let fails = false;
  let busy = false;
  const feed = normalizeAnnouncementFeed({
    schemaVersion: 1,
    revision: 'a'.repeat(64),
    autoShowEnabled: true,
    items: ['old', 'new'].map((id, index) => ({
      id,
      title: id,
      status: 'published',
      publishedAt: `2026-09-0${index + 1}T00:00:00Z`,
      minUsageMinutes: 0,
      bodySha256: 'b'.repeat(64),
      bodyPath: `/announcements/content/${id}/${'c'.repeat(64)}/body.md`,
    })),
  });
  const source = {
    current: () => feed,
    loadCached: async () => undefined,
    drain: async () => undefined,
    refresh: vi.fn(async () => feed),
    body: vi.fn(async () => ({
      markdown: '# News',
      bodyUrl: 'https://agentteams.live/announcements/body.md',
    })),
  };
  const repo = {
    initialize: async () => saved,
    update: vi.fn(async (change: (state: typeof saved) => typeof saved) => {
      if (fails) throw new Error('disk');
      saved = change(saved);
      return saved;
    }),
    drain: async () => undefined,
  };
  const owner = { acquire: async () => !busy, release: vi.fn(async () => undefined) };
  const service = new AnnouncementsService({
    source,
    repository: repo,
    owner,
    clock: { now: () => now, monotonic: () => mono },
    origin: 'fresh',
    networkEnabled: true,
  });
  const context = { windowId: 1, uiGeneration: 1, isReady: () => true };
  return {
    service,
    source,
    repo,
    owner,
    feed,
    context,
    saved: () => saved,
    fail: () => {
      fails = true;
    },
    busy: () => {
      busy = true;
    },
    advance: (ms: number) => {
      now += ms;
      mono += ms;
    },
  };
}

describe('announcement consumption service', () => {
  it('precommits newest once and suppresses older announcements through restart', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    const prepared = await f.service.prepareAuto(f.context);
    expect(prepared?.announcement.id).toBe('new');
    const input = { id: 'new', revision: f.feed.revision, bodySha256: 'b'.repeat(64) };
    const result = await f.service.claimAuto(input, f.context);
    expect(result?.announcement.id).toBe('new');
    expect(f.saved().handledIds).toEqual(['new']);
    expect(await f.service.claimAuto(input, f.context)).toBe(null);
    expect(await f.service.prepareAuto(f.context)).toBe(null);
    expect(await f.service.dismiss('new')).toEqual({ saved: true });
    await f.service.dispose();
  });
  it('does not consume when body fails or focus changes during preparation', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    f.source.body.mockRejectedValueOnce(new Error('404'));
    expect(await f.service.openManual('new')).toBe(null);
    expect(f.saved().handledIds).toEqual([]);
    let ready = true;
    f.source.body.mockImplementationOnce(async () => {
      ready = false;
      return { markdown: 'x', bodyUrl: 'https://agentteams.live/x' };
    });
    expect(await f.service.prepareAuto({ ...f.context, isReady: () => ready })).toBe(null);
    expect(f.saved().handledIds).toEqual([]);
    await f.service.dispose();
  });
  it('keeps manual body available on storage failure but blocks automatic grants', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    f.fail();
    expect((await f.service.openManual('new'))?.announcement.id).toBe('new');
    expect((await f.service.getSnapshot()).status).toBe('state_unavailable');
    expect(await f.service.prepareAuto(f.context)).toBe(null);
    expect(await f.service.dismiss('new')).toEqual({ saved: false });
    await f.service.dispose();
  });
  it('blocks articles in secondary instance and excludes suspend freshness', async () => {
    const f = fixture();
    f.busy();
    f.service.registerWindow(1);
    await f.service.initialize();
    expect((await f.service.getSnapshot()).status).toBe('writer_busy');
    expect(await f.service.openManual('new')).toBe(null);
    await f.service.dispose();
    const g = fixture();
    g.service.registerWindow(1);
    await g.service.initialize();
    await g.service.suspend();
    expect(await g.service.prepareAuto(g.context)).toBe(null);
    await g.service.dispose();
  });
  it('rechecks candidate expiry and UI generation before a durable claim', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    await f.service.prepareAuto(f.context);
    const input = { id: 'new', revision: f.feed.revision, bodySha256: 'b'.repeat(64) };
    expect(await f.service.claimAuto(input, { ...f.context, uiGeneration: 2 })).toBe(null);
    expect(f.saved().handledIds).toEqual([]);
    await f.service.prepareAuto(f.context);
    f.feed.items.find((i) => i.id === 'new')!.validUntil = '2026-09-04T01:00:00Z';
    expect(await f.service.claimAuto(input, f.context)).toBe(null);
    expect(f.saved().handledIds).toEqual([]);
    await f.service.dispose();
  });
});

it('discards stale body callback after last-window ownership handoff', async () => {
  const f = fixture();
  f.service.registerWindow(1);
  await f.service.initialize();
  let finish!: (value: { markdown: string; bodyUrl: string }) => void;
  f.source.body.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const opening = f.service.openManual('new');
  await f.service.unregisterWindow(1);
  finish({ markdown: '# News', bodyUrl: 'https://agentteams.live/announcements/x' });
  expect(await opening).toBe(null);
  expect(f.saved().handledIds).toEqual([]);
  expect(f.owner.release).toHaveBeenCalledTimes(1);
  await f.service.dispose();
});

it('does not fall back or repeatedly refetch a broken newest body after forced feed refresh', async () => {
  const f = fixture();
  f.service.registerWindow(1);
  await f.service.initialize();
  f.source.body.mockRejectedValue(new Error('404'));
  expect(await f.service.prepareAuto(f.context)).toBe(null);
  await f.service.refresh();
  expect(await f.service.prepareAuto(f.context)).toBe(null);
  expect(f.source.body).toHaveBeenCalledTimes(1);
  expect(f.saved().handledIds).toEqual([]);
  await f.service.dispose();
});

it('withholds paint if the publication expires during durable consume', async () => {
  const f = fixture();
  f.service.registerWindow(1);
  await f.service.initialize();
  await f.service.prepareAuto(f.context);
  f.repo.update.mockImplementationOnce(async (change) => {
    const result = change(f.saved());
    f.feed.items.find((entry) => entry.id === 'new')!.validUntil = '2026-09-04T01:00:00Z';
    return result;
  });
  expect(
    await f.service.claimAuto(
      { id: 'new', revision: f.feed.revision, bodySha256: 'b'.repeat(64) },
      f.context
    )
  ).toBe(null);
  await f.service.dispose();
});

it('does not consume an old prepared candidate when checkpoint awaits and newest changes', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.service.registerWindow(1);
  await f.service.initialize();
  f.advance(5000);
  await vi.advanceTimersByTimeAsync(5000);
  await f.service.prepareAuto(f.context);
  let finish!: () => void;
  let started!: () => void;
  const checkpointStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.repo.update.mockImplementationOnce(async (change) => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return change(f.saved());
  });
  const claiming = f.service.claimAuto(
    { id: 'new', revision: f.feed.revision, bodySha256: 'b'.repeat(64) },
    f.context
  );
  await checkpointStarted;
  f.feed.items = f.feed.items.filter((entry) => entry.id !== 'new');
  finish();
  expect(await claiming).toBe(null);
  expect(f.repo.update).toHaveBeenCalledTimes(1);
  expect(f.saved().handledIds).toEqual([]);
  await f.service.dispose();
});

it('does not return a manual article withdrawn while consumption is being persisted', async () => {
  const f = fixture();
  f.service.registerWindow(1);
  await f.service.initialize();
  f.repo.update.mockImplementationOnce(async (change) => {
    const next = change(f.saved());
    f.feed.items = [];
    return next;
  });
  expect(await f.service.openManual('new')).toBe(null);
  await f.service.dispose();
});

it.each([
  '',
  '.deleting.22222222-2222-2222-2222-222222222222',
  '.deleting.22222222-2222-2222-2222-222222222222.deleting.33333333-3333-3333-3333-333333333333',
])('recovers a proven dead owner during identity detach crash %s', async (suffix) => {
  const dir = await directory();
  const lock = join(dir, 'writer.lock');
  const token = '11111111-1111-1111-1111-111111111111';
  await mkdir(lock);
  await writeFile(
    join(lock, `${suffix ? '.' : ''}${token}.json${suffix}`),
    JSON.stringify({ token, pid: 12345 })
  );
  const owner = new AnnouncementWriterOwner(dir, () => 'dead');
  expect(await owner.acquire()).toBe(true);
  await owner.release();
});
