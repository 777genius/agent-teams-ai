import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';

import {
  type Announcement,
  type AnnouncementFeed,
  ANNOUNCEMENTS_MAX_BODY_BYTES,
  ANNOUNCEMENTS_MAX_FEED_BYTES,
} from '../../contracts';
import { normalizeAnnouncementFeed } from '../../core/domain';

import type { AnnouncementSource } from '../../core/application/ports';

async function retryDelay(delay: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cancelled = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancelled);
      resolve();
    }, delay);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

export class HttpAnnouncementSource implements AnnouncementSource {
  private feed: AnnouncementFeed | null = null;
  private etag: string | undefined;
  private cacheTail: Promise<unknown> = Promise.resolve();
  private cache<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.cacheTail.then(operation);
    this.cacheTail = task.catch(() => undefined);
    return task;
  }
  private readonly origin: string;
  constructor(
    private readonly url: string,
    private readonly directory: string,
    private readonly request: typeof fetch = fetch,
    private readonly write = atomicWriteAsync
  ) {
    this.origin = new URL(url).origin;
  }
  async drain(): Promise<void> {
    await this.cacheTail;
  }
  current(): AnnouncementFeed | null {
    return this.feed;
  }
  async loadCached(): Promise<void> {
    try {
      const cached = JSON.parse(
        await fs.readFile(path.join(this.directory, 'feed.json'), 'utf8')
      ) as { feed: unknown; etag?: string };
      this.feed = normalizeAnnouncementFeed(cached.feed);
      this.etag =
        typeof cached.etag === 'string' && cached.etag.length < 1000 ? cached.etag : undefined;
    } catch {
      /* Cache is disposable; corruption never changes consumption state. */
    }
  }
  private async get(
    url: string,
    limit: number,
    kind: 'feed' | 'body',
    signal: AbortSignal
  ): Promise<{ text: string; etag?: string } | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) controller.abort();
      const timeout = setTimeout(abort, 10_000);
      try {
        let target = url;
        let response: Response | undefined;
        for (let redirects = 0; redirects < 4; redirects++) {
          response = await this.request(target, {
            signal: controller.signal,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            redirect: 'manual',
            headers:
              kind === 'feed' && this.etag
                ? { 'If-None-Match': this.etag, Accept: 'application/json' }
                : { Accept: kind === 'feed' ? 'application/json' : 'text/markdown,text/plain' },
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          if (!location) throw new Error('fetch_failed');
          const next = new URL(location, target);
          if (
            next.origin !== this.origin ||
            next.username ||
            next.password ||
            !next.pathname.startsWith('/announcements/')
          )
            throw new Error('fetch_failed');
          await response.body?.cancel();
          target = next.href;
        }
        if (!response) throw new Error('fetch_failed');
        if (response.status === 304 && kind === 'feed') {
          if (!this.feed || !this.etag) throw new Error('feed_invalid');
          normalizeAnnouncementFeed(this.feed);
          return null;
        }
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          if (attempt < 2) {
            const retryAfter = response.headers.get('retry-after');
            const seconds = retryAfter === null ? NaN : Number(retryAfter);
            const requested = Number.isFinite(seconds)
              ? seconds * 1000
              : retryAfter
                ? Date.parse(retryAfter) - Date.now()
                : 100 * (attempt + 1);
            if (requested > 2000) throw new Error('fetch_failed');
            const delay = Math.max(0, Number.isFinite(requested) ? requested : 100);
            await retryDelay(delay, controller.signal);
            continue;
          }
        }
        if (!response.ok)
          throw new Error(response.status === 404 ? 'body_missing' : 'fetch_failed');
        const type = response.headers.get('content-type')?.split(';')[0].trim();
        if (
          kind === 'feed'
            ? type !== 'application/json'
            : !['text/markdown', 'text/plain', 'text/x-markdown'].includes(type ?? '')
        )
          throw new Error('feed_invalid');
        if (!response.body) throw new Error('fetch_failed');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > limit) throw new Error('response_too_large');
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        return {
          text: Buffer.concat(chunks).toString('utf8'),
          etag: response.headers.get('etag') ?? undefined,
        };
      } catch (error) {
        if (signal.aborted || !(error instanceof TypeError) || attempt === 2) throw error;
        await retryDelay(100 * (attempt + 1), signal);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
    }
    throw new Error('fetch_failed');
  }
  async refresh(signal: AbortSignal): Promise<AnnouncementFeed> {
    const result = await this.get(this.url, ANNOUNCEMENTS_MAX_FEED_BYTES, 'feed', signal);
    if (signal.aborted) throw new Error('aborted');
    if (result) {
      const feed = normalizeAnnouncementFeed(JSON.parse(result.text) as unknown);
      this.feed = feed;
      this.etag = result.etag;
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.write(
        path.join(this.directory, 'feed.json'),
        JSON.stringify({ feed, etag: this.etag })
      ).catch(() => undefined);
      await this.cache(async () => {
        const retained = new Set(feed.items.map((item) => `${item.id}-${item.bodySha256}.md`));
        for (const name of await fs.readdir(this.directory)) {
          if (/^[a-z0-9-]+-[a-f0-9]{64}\.md$/.test(name) && !retained.has(name))
            await fs.unlink(path.join(this.directory, name));
        }
      }).catch(() => undefined);
    }
    if (!this.feed) throw new Error('feed_invalid');
    return this.feed;
  }
  async body(
    item: Announcement,
    signal: AbortSignal
  ): Promise<{ markdown: string; bodyUrl: string }> {
    const bodyUrl = new URL(item.bodyPath, this.origin).href;
    const file = path.join(this.directory, `${item.id}-${item.bodySha256}.md`);
    const valid = (text: string): boolean =>
      Buffer.byteLength(text) <= ANNOUNCEMENTS_MAX_BODY_BYTES &&
      createHash('sha256').update(text).digest('hex') === item.bodySha256 &&
      !/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text);
    try {
      const text = await fs.readFile(file, 'utf8');
      if (valid(text)) {
        if (!signal.aborted) await fs.utimes(file, new Date(), new Date()).catch(() => undefined);
        return { markdown: text, bodyUrl };
      }
    } catch {
      /* Fetch absent or damaged cached content. */
    }
    const result = await this.get(bodyUrl, ANNOUNCEMENTS_MAX_BODY_BYTES, 'body', signal);
    if (!result || !valid(result.text)) throw new Error('body_hash_mismatch');
    if (signal.aborted) throw new Error('aborted');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.cache(async () => {
      if (
        signal.aborted ||
        (this.feed &&
          !this.feed.items.some(
            (entry) => entry.id === item.id && entry.bodySha256 === item.bodySha256
          ))
      )
        return;
      await this.write(file, result.text);
      await this.trim();
    }).catch(() => undefined);
    return { markdown: result.text, bodyUrl };
  }
  private async trim(): Promise<void> {
    const files = (await fs.readdir(this.directory)).filter((name) =>
      /^[a-z0-9-]+-[a-f0-9]{64}\.md$/.test(name)
    );
    const entries = await Promise.all(
      files.map(async (name) => ({ name, stats: await fs.stat(path.join(this.directory, name)) }))
    );
    entries.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
    let size = 0;
    for (const [index, entry] of entries.entries()) {
      size += entry.stats.size;
      if (index >= 20 || size > 5 * 1024 * 1024)
        await fs.unlink(path.join(this.directory, entry.name));
    }
  }
}
