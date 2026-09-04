import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANNOUNCEMENTS_MAX_ASSET_BYTES,
  ANNOUNCEMENTS_MAX_BODY_BYTES,
} from '../../../../src/features/announcements/contracts';
import {
  createAnnouncementState,
  normalizeAnnouncementFeed,
} from '../../../../src/features/announcements/core/domain';
import { AnnouncementsService } from '../../../../src/features/announcements/main/application/AnnouncementsService';
import { createAnnouncementsFeature } from '../../../../src/features/announcements/main/composition/createAnnouncementsFeature';
import { HttpAnnouncementSource } from '../../../../src/features/announcements/main/infrastructure/HttpAnnouncementSource';
import { atomicWriteAsync } from '../../../../src/main/utils/atomicWrite';

const dirs: string[] = [];
const markdown = '# Hello\r\n';
const hash = createHash('sha256').update(markdown).digest('hex');
const feed = normalizeAnnouncementFeed({
  schemaVersion: 1,
  revision: 'a'.repeat(64),
  autoShowEnabled: true,
  items: [
    {
      id: 'hello',
      title: 'Hello',
      status: 'published',
      publishedAt: '2026-09-01T00:00:00Z',
      bodyPath: `/announcements/content/hello/${'a'.repeat(64)}/body.md`,
      bodySha256: hash,
    },
  ],
});
const signal = () => new AbortController().signal;
async function setup(responses: Response[]) {
  const directory = await mkdtemp(join(tmpdir(), 'announcement-source-'));
  dirs.push(directory);
  const request = vi.fn<typeof fetch>(async () => {
    const result = responses.shift();
    if (!result) throw new Error('Unexpected request');
    return result;
  });
  return {
    source: new HttpAnnouncementSource(
      'https://agentteams.live/announcements/feed.v1.json',
      directory,
      request
    ),
    request,
    directory,
  };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const json = () =>
  new Response(JSON.stringify(feed), {
    headers: { 'Content-Type': 'application/json', ETag: '"feed-one"' },
  });

describe('anonymous validated announcement source', () => {
  it('persists feed+ETag together, validates 304 after restart and caches exact body bytes', async () => {
    const f = await setup([
      json(),
      new Response(markdown, { headers: { 'Content-Type': 'text/markdown' } }),
    ]);
    await f.source.refresh(signal());
    expect((await f.source.body(feed.items[0], signal())).markdown).toBe(markdown);
    expect((await f.source.body(feed.items[0], signal())).markdown).toBe(markdown);
    expect(f.request).toHaveBeenCalledTimes(2);
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
    const restored = new HttpAnnouncementSource(
      'https://agentteams.live/announcements/feed.v1.json',
      f.directory,
      request
    );
    await restored.loadCached();
    expect(await restored.refresh(signal())).toEqual(feed);
    expect(request.mock.calls[0][1]).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'If-None-Match': '"feed-one"' },
    });
    expect((await restored.body(feed.items[0], signal())).markdown).toBe(markdown);
  });
  it('rejects orphan 304, HTML fallback, hash mismatch and oversized bodies', async () => {
    const htmlFallback = new Response('<html>fallback</html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    const cancelHtmlFallback = vi.spyOn(htmlFallback.body!, 'cancel');
    const f = await setup([
      new Response(null, { status: 304 }),
      htmlFallback,
      new Response('wrong bytes', { headers: { 'Content-Type': 'text/plain' } }),
      new Response('x'.repeat(ANNOUNCEMENTS_MAX_BODY_BYTES + 1), {
        headers: { 'Content-Type': 'text/plain' },
      }),
    ]);
    await expect(f.source.refresh(signal())).rejects.toThrow();
    await expect(f.source.refresh(signal())).rejects.toThrow();
    expect(cancelHtmlFallback).toHaveBeenCalledTimes(1);
    await expect(f.source.body(feed.items[0], signal())).rejects.toThrow('body_hash_mismatch');
    await expect(f.source.body(feed.items[0], signal())).rejects.toThrow('response_too_large');
  });
  it('keeps good cache after malformed response and does not retry invalid JSON', async () => {
    const f = await setup([
      json(),
      new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
    ]);
    await f.source.refresh(signal());
    await expect(f.source.refresh(signal())).rejects.toThrow();
    expect(f.source.current()).toEqual(feed);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('bounds oversized feed and Markdown files before reading disk caches', async () => {
    const f = await setup([
      json(),
      new Response(markdown, { headers: { 'Content-Type': 'text/markdown' } }),
    ]);
    await writeFile(join(f.directory, 'feed.json'), 'x'.repeat(1024 * 1024 + 1));
    await f.source.loadCached();
    expect(f.source.current()).toBeNull();
    await f.source.refresh(signal());
    await writeFile(
      join(f.directory, `${feed.items[0].id}-${feed.items[0].bodySha256}.md`),
      'x'.repeat(ANNOUNCEMENTS_MAX_BODY_BYTES + 1)
    );
    expect((await f.source.body(feed.items[0], signal())).markdown).toBe(markdown);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('rejects cross-origin redirects and bounds transient retries to three', async () => {
    const f = await setup([
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/announcements/feed.v1.json' },
      }),
      ...Array.from({ length: 3 }, () => new Response(null, { status: 503 })),
    ]);
    await expect(f.source.refresh(signal())).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
    await expect(f.source.refresh(signal())).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(4);
  });
  it('loads only bounded image assets from a current feed bundle and rejects redirects', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const f = await setup([
      json(),
      new Response(png, { headers: { 'Content-Type': 'image/png' } }),
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/tracker.png' },
      }),
      new Response('x'.repeat(ANNOUNCEMENTS_MAX_ASSET_BYTES + 1), {
        headers: { 'Content-Type': 'image/png' },
      }),
    ]);
    await f.source.refresh(signal());
    const bodyUrl = new URL(feed.items[0].bodyPath, 'https://agentteams.live');
    const assetUrl = new URL('assets/demo.png', bodyUrl).href;
    expect(
      await f.source.asset(assetUrl, bodyUrl.href, ANNOUNCEMENTS_MAX_ASSET_BYTES, signal())
    ).toEqual({
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      decodedBytes: png.byteLength,
    });
    await expect(
      f.source.asset(assetUrl, bodyUrl.href, ANNOUNCEMENTS_MAX_ASSET_BYTES, signal())
    ).rejects.toThrow('fetch_failed');
    await expect(
      f.source.asset(assetUrl, bodyUrl.href, ANNOUNCEMENTS_MAX_ASSET_BYTES, signal())
    ).rejects.toThrow('response_too_large');
    await expect(
      f.source.asset(
        'https://agentteams.live/announcements/unpublished/assets/demo.png',
        bodyUrl.href,
        ANNOUNCEMENTS_MAX_ASSET_BYTES,
        signal()
      )
    ).rejects.toThrow('asset_invalid');
    expect(f.request).toHaveBeenCalledTimes(4);
  });
  it('accepts source override only for explicitly isolated development loopback', () => {
    const options = {
      userDataPath: '/unused-announcement-test',
      origin: 'unknown' as const,
      production: false,
      isolatedProfile: true,
      sourceUrl: 'http://127.0.0.1:8181/announcements/feed.v1.json',
    };
    expect(() => createAnnouncementsFeature(options)).not.toThrow();
    expect(() => createAnnouncementsFeature({ ...options, production: true })).toThrow();
    expect(() => createAnnouncementsFeature({ ...options, isolatedProfile: false })).toThrow();
    expect(() =>
      createAnnouncementsFeature({
        ...options,
        sourceUrl: 'http://evil.example/announcements/feed.v1.json',
      })
    ).toThrow();
  });
});

it('prunes withdrawn disk bodies and prevents an in-flight old body from recreating them', async () => {
  const f = await setup([
    json(),
    new Response(markdown, { headers: { 'Content-Type': 'text/plain' } }),
    new Response(JSON.stringify({ ...feed, items: [] }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ]);
  await f.source.refresh(signal());
  await f.source.body(feed.items[0], signal());
  expect((await readdir(f.directory)).some((name) => name.endsWith('.md'))).toBe(true);
  await f.source.refresh(signal());
  expect((await readdir(f.directory)).some((name) => name.endsWith('.md'))).toBe(false);
  f.request.mockResolvedValueOnce(
    new Response(markdown, { headers: { 'Content-Type': 'text/plain' } })
  );
  await f.source.body(feed.items[0], signal());
  expect((await readdir(f.directory)).some((name) => name.endsWith('.md'))).toBe(false);
});

it('does not retry before a Retry-After beyond the bounded batch wait', async () => {
  const f = await setup([new Response(null, { status: 429, headers: { 'Retry-After': '60' } })]);
  await expect(f.source.refresh(signal())).rejects.toThrow('fetch_failed');
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('drains an in-flight atomic body write before ownership can transfer and prune withdrawn content', async () => {
  const f = await setup([
    json(),
    new Response(markdown, { headers: { 'Content-Type': 'text/plain' } }),
  ]);
  let finishWrite!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const source = new HttpAnnouncementSource(
    'https://agentteams.live/announcements/feed.v1.json',
    f.directory,
    f.request,
    async (file, data, options) => {
      if (file.endsWith('.md')) {
        started();
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
      }
      await atomicWriteAsync(file, data, options);
    }
  );
  let state = createAnnouncementState(
    'fresh',
    '2026-09-04T00:00:00.000Z',
    '2026-09-04T00:00:00.000Z'
  );
  const release = vi.fn(async () => undefined);
  const service = new AnnouncementsService({
    source,
    repository: {
      initialize: async () => state,
      update: async (change) => {
        state = change(state);
        return state;
      },
      drain: async () => undefined,
    },
    owner: { acquire: async () => true, release },
    clock: { now: () => Date.parse('2026-09-04T00:00:00Z'), monotonic: () => 0 },
    origin: 'fresh',
    networkEnabled: true,
  });
  service.registerWindow(1);
  await service.initialize();
  const article = service.openManual('hello', {
    windowId: 1,
    uiGeneration: 1,
    isReady: () => true,
  });
  await writing;
  const closing = service.unregisterWindow(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(release).not.toHaveBeenCalled();
  finishWrite();
  await closing;
  expect(release).toHaveBeenCalledTimes(1);
  expect(await article).toBe(null);
  const successor = new HttpAnnouncementSource(
    'https://agentteams.live/announcements/feed.v1.json',
    f.directory,
    async () =>
      new Response(JSON.stringify({ ...feed, items: [] }), {
        headers: { 'Content-Type': 'application/json' },
      })
  );
  await successor.refresh(signal());
  await source.drain();
  expect((await readdir(f.directory)).some((name) => name.endsWith('.md'))).toBe(false);
  await service.dispose();
});

it('cancels redirect bodies before every invalid redirect branch', async () => {
  for (const response of [
    new Response('redirect', { status: 302 }),
    new Response('redirect', { status: 302, headers: { Location: 'https://evil.example/x' } }),
  ]) {
    const cancel = vi.spyOn(response.body!, 'cancel');
    const f = await setup([response]);
    await expect(f.source.refresh(signal())).rejects.toThrow('fetch_failed');
    expect(cancel).toHaveBeenCalledOnce();
  }
});
