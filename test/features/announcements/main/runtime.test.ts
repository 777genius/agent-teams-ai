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
  it('rejects oversized state before JSON parsing', async () => {
    const dir = await directory();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'initialized.json'), '{"schemaVersion":1}');
    await writeFile(join(dir, 'state.json'), ' '.repeat(512 * 1024 + 1));
    await expect(new JsonAnnouncementRepository(dir).initialize(initial())).rejects.toThrow(
      'state_unavailable'
    );
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
    refresh: vi.fn(async (_signal: AbortSignal) => feed),
    body: vi.fn(async () => ({
      markdown: '# News',
      bodyUrl: 'https://agentteams.live/announcements/body.md',
    })),
    asset: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,eA==', decodedBytes: 1 })),
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

describe('announcement freshness lifecycle', () => {
  it('keeps a successful resume refresh fresh across the first heartbeat after sleep', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    f.advance(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await f.service.suspend();
    f.advance(60_000);
    f.service.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.source.refresh).toHaveBeenCalledTimes(2);
    f.advance(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await f.service.getSnapshot()).status).toBe('ready');
    await f.service.dispose();
  });

  it('starts a replacement refresh when resume races an aborted in-flight request', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    f.advance(5000);
    f.source.refresh.mockImplementationOnce(
      (signal) =>
        new Promise((_, reject) => {
          const aborted = (): void => reject(new Error('aborted'));
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        })
    );
    const refreshing = f.service.refresh();
    const suspending = f.service.suspend();
    f.service.resume();
    await Promise.all([refreshing, suspending]);
    await vi.waitFor(() => expect(f.source.refresh).toHaveBeenCalledTimes(3));
    expect((await f.service.getSnapshot()).status).toBe('ready');
    await f.service.dispose();
  });
});

describe('announcement consumption service', () => {
  it('precommits newest once and suppresses older announcements through restart', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    const prepared = await f.service.prepareAuto(f.context);
    expect(prepared?.announcement.id).toBe('new');
    expect(prepared?.announcement).not.toHaveProperty('bodyPath');
    expect(prepared?.announcement).not.toHaveProperty('minUsageMinutes');
    expect(await f.service.getSnapshot()).not.toHaveProperty('accumulatedOpenMs');
    expect((await f.service.getSnapshot()).items.find((item) => item.id === 'old')).toEqual({
      id: 'old',
      title: 'old',
      publishedAt: '2026-09-01T00:00:00.000Z',
      validUntil: '2026-09-15T00:00:00.000Z',
      status: 'published',
    });
    const input = { id: 'new', revision: f.feed.revision, bodySha256: 'b'.repeat(64) };
    const result = await f.service.claimAuto(input, f.context);
    expect(result?.announcement.id).toBe('new');
    expect(result?.announcement).not.toHaveProperty('bodySha256');
    expect(f.saved().handledIds).toEqual(['new']);
    expect(await f.service.claimAuto(input, f.context)).toBe(null);
    expect(await f.service.prepareAuto(f.context)).toBe(null);
    expect(await f.service.dismiss('new')).toEqual({ saved: true });
    await f.service.dispose();
  });
  it('rejects unissued dismissals and deduplicates cancellable asset work', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    expect(await f.service.dismiss('future-id')).toEqual({ saved: false });
    expect(f.saved().dismissedIds).toEqual([]);
    const url = `https://agentteams.live/announcements/content/new/${'c'.repeat(64)}/assets/demo.png`;
    expect(await f.service.loadAsset(url, 'unissued', f.context)).toBeNull();

    let finish!: (value: { dataUrl: string; decodedBytes: number }) => void;
    f.source.asset.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await f.service.openManual('new', f.context);
    const first = f.service.loadAsset(url, 'request_1', f.context);
    const second = f.service.loadAsset(url, 'request_2', f.context);
    await Promise.resolve();
    expect(f.source.asset).toHaveBeenCalledTimes(1);
    f.service.cancelAsset('request_1', f.context);
    finish({ dataUrl: 'data:image/png;base64,eA==', decodedBytes: 1 });
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBe('data:image/png;base64,eA==');
    await f.service.dispose();
  });
  it('keeps the newest manual open authoritative when an older request finishes late', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    let finishOld!: (value: { markdown: string; bodyUrl: string }) => void;
    f.source.body.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    const oldOpening = f.service.openManual('old', f.context);
    await vi.waitFor(() => expect(f.source.body).toHaveBeenCalledTimes(1));
    expect((await f.service.openManual('new', f.context))?.announcement.id).toBe('new');
    finishOld({ markdown: '# Old', bodyUrl: 'https://agentteams.live/old.md' });
    await expect(oldOpening).resolves.toBeNull();

    const newAsset = `https://agentteams.live/announcements/content/new/${'c'.repeat(64)}/assets/new.png`;
    const oldAsset = `https://agentteams.live/announcements/content/old/${'c'.repeat(64)}/assets/old.png`;
    expect(await f.service.loadAsset(newAsset, 'new_asset', f.context)).not.toBeNull();
    expect(await f.service.loadAsset(oldAsset, 'old_asset', f.context)).toBeNull();
    await f.service.dispose();
  });
  it('records dismissal of an issued older manual article without accepting arbitrary IDs', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    await f.service.openManual('new', f.context);
    expect((await f.service.openManual('old', f.context))?.announcement.id).toBe('old');
    expect(f.saved().handledIds).toEqual(['new']);
    expect(await f.service.dismiss('old', f.context)).toEqual({ saved: true });
    expect(f.saved().dismissedIds).toEqual(['old']);
    expect(await f.service.dismiss('future-id', f.context)).toEqual({ saved: false });
    await f.service.dispose();
  });
  it('does not consume when body fails or focus changes during preparation', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    f.source.body.mockRejectedValueOnce(new Error('404'));
    expect(await f.service.openManual('new', f.context)).toBe(null);
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
    expect((await f.service.openManual('new', f.context))?.announcement.id).toBe('new');
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
    expect(await f.service.openManual('new', f.context)).toBe(null);
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
  const opening = f.service.openManual('new', f.context);
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
  expect(await f.service.openManual('new', f.context)).toBe(null);
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

describe('issued document asset quotas', () => {
  it('keeps the exact issued bundle across feed refresh and revokes it on dismiss/navigation', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    const opened = await f.service.openManual('new', f.context);
    const oldUrl = `https://agentteams.live/announcements/content/new/${'c'.repeat(64)}/assets/hero.png`;
    f.feed.items.find((item) => item.id === 'new')!.bodyPath =
      `/announcements/content/new/${'d'.repeat(64)}/body.md`;
    expect(await f.service.loadAsset(oldUrl, 'old_bundle', f.context)).toBe(
      'data:image/png;base64,eA=='
    );
    expect(f.source.asset).toHaveBeenCalledWith(
      oldUrl,
      `/announcements/content/new/${'c'.repeat(64)}/body.md`,
      20 * 1024 * 1024,
      expect.any(AbortSignal)
    );
    await f.service.dismiss(opened!.announcement.id, f.context);
    expect(await f.service.loadAsset(oldUrl, 'closed', f.context)).toBeNull();

    await f.service.openManual('new', { ...f.context, uiGeneration: 2 });
    expect(
      await f.service.loadAsset(oldUrl, 'navigated', { ...f.context, uiGeneration: 3 })
    ).toBeNull();
    await f.service.dispose();
  });

  it('enforces 64 unique, 20MiB accepted, and 3 concurrent per issued document', async () => {
    const f = fixture();
    f.service.registerWindow(1);
    await f.service.initialize();
    await f.service.openManual('new', f.context);
    const root = `https://agentteams.live/announcements/content/new/${'c'.repeat(64)}/assets/`;
    for (let index = 0; index < 64; index++) {
      expect(
        await f.service.loadAsset(`${root}${index}.png`, `r${index}`, f.context)
      ).not.toBeNull();
    }
    expect(await f.service.loadAsset(`${root}overflow.png`, 'overflow', f.context)).toBeNull();
    expect(await f.service.loadAsset(`${root}0.png`, 'after_exhaustion', f.context)).toBeNull();

    await f.service.openManual('new', f.context);
    f.source.asset.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,',
      decodedBytes: 20 * 1024 * 1024,
    });
    expect(await f.service.loadAsset(`${root}full.png`, 'full', f.context)).not.toBeNull();
    expect(await f.service.loadAsset(`${root}extra.png`, 'extra', f.context)).toBeNull();

    await f.service.openManual('new', f.context);
    const finishes: Array<(value: { dataUrl: string; decodedBytes: number }) => void> = [];
    f.source.asset.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
    const callsBeforeConcurrent = f.source.asset.mock.calls.length;
    const pending = [0, 1, 2].map((index) =>
      f.service.loadAsset(`${root}c${index}.png`, `c${index}`, f.context)
    );
    await Promise.resolve();
    const queued = f.service.loadAsset(`${root}c3.png`, 'c3', f.context);
    expect(f.source.asset.mock.calls.length - callsBeforeConcurrent).toBe(3);
    finishes[0]({ dataUrl: 'data:image/png;base64,eA==', decodedBytes: 1 });
    await pending[0];
    await Promise.resolve();
    expect(f.source.asset.mock.calls.length - callsBeforeConcurrent).toBe(4);
    for (const finish of finishes.slice(1))
      finish({ dataUrl: 'data:image/png;base64,eA==', decodedBytes: 1 });
    expect(await Promise.all([...pending.slice(1), queued])).toEqual([
      'data:image/png;base64,eA==',
      'data:image/png;base64,eA==',
      'data:image/png;base64,eA==',
    ]);
    await f.service.dispose();
  });

  it('does not expose hero paths in list snapshots but includes hero in opened documents', async () => {
    const f = fixture();
    const newest = f.feed.items.find((item) => item.id === 'new')!;
    newest.heroImagePath = `${newest.bodyPath.slice(0, -'body.md'.length)}assets/hero.png`;
    f.service.registerWindow(1);
    await f.service.initialize();
    expect(
      (await f.service.getSnapshot()).items.find((item) => item.id === 'new')
    ).not.toHaveProperty('heroImagePath');
    expect((await f.service.openManual('new', f.context))?.announcement.heroImagePath).toBe(
      newest.heroImagePath
    );
    await f.service.dispose();
  });
});

it('shares three asset network slots globally and queues another window', async () => {
  const f = fixture();
  const second = { windowId: 2, uiGeneration: 1, isReady: () => true };
  f.service.registerWindow(1);
  f.service.registerWindow(2);
  await f.service.initialize();
  await f.service.openManual('new', f.context);
  await f.service.openManual('new', second);
  const root = `https://agentteams.live/announcements/content/new/${'c'.repeat(64)}/assets/`;
  const finishes: Array<(value: { dataUrl: string; decodedBytes: number }) => void> = [];
  f.source.asset.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
  const callsBeforeGlobal = f.source.asset.mock.calls.length;
  const first = [0, 1, 2].map((index) =>
    f.service.loadAsset(`${root}w1-${index}.png`, `w1-${index}`, f.context)
  );
  const queued = f.service.loadAsset(`${root}w2.png`, 'w2', second);
  await Promise.resolve();
  expect(f.source.asset.mock.calls.length - callsBeforeGlobal).toBe(3);
  finishes[0]({ dataUrl: 'data:image/png;base64,eA==', decodedBytes: 1 });
  await first[0];
  await Promise.resolve();
  expect(f.source.asset.mock.calls.length - callsBeforeGlobal).toBe(4);
  for (const finish of finishes.slice(1))
    finish({ dataUrl: 'data:image/png;base64,eA==', decodedBytes: 1 });
  expect(await queued).toBe('data:image/png;base64,eA==');
  await Promise.all(first.slice(1));
  await f.service.dispose();
});

it('bounds pending request consumers even when all request IDs target one asset', async () => {
  const f = fixture();
  f.service.registerWindow(1);
  await f.service.initialize();
  await f.service.openManual('new', f.context);
  const callsBefore = f.source.asset.mock.calls.length;
  f.source.asset.mockImplementationOnce(() => new Promise(() => undefined));
  const url = `https://agentteams.live/announcements/content/new/${'c'.repeat(64)}/assets/shared.png`;
  const pending = Array.from({ length: 64 }, (_, index) =>
    f.service.loadAsset(url, `shared-${index}`, f.context)
  );
  expect(await f.service.loadAsset(url, 'shared-overflow', f.context)).toBeNull();
  expect(f.source.asset.mock.calls.length - callsBefore).toBe(0);
  expect(await Promise.all(pending)).toEqual(Array.from({ length: 64 }, () => null));
  await f.service.dispose();
});

it('keeps opened document assets across focus changes but revokes on document navigation', async () => {
  const f = fixture();
  f.service.registerWindow(1);
  await f.service.initialize();
  const openedContext = { ...f.context, documentGeneration: 7 };
  await f.service.openManual('new', openedContext);
  const url = `https://agentteams.live/announcements/content/new/${'c'.repeat(64)}/assets/lazy.png`;
  expect(
    await f.service.loadAsset(url, 'after-blur', {
      ...openedContext,
      uiGeneration: openedContext.uiGeneration + 2,
    })
  ).toBe('data:image/png;base64,eA==');
  expect(
    await f.service.loadAsset(url, 'after-navigation', {
      ...openedContext,
      uiGeneration: openedContext.uiGeneration + 3,
      documentGeneration: openedContext.documentGeneration + 1,
    })
  ).toBeNull();
  await f.service.dispose();
});
