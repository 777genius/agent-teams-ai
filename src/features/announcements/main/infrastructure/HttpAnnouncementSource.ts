import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';

import {
  type Announcement,
  type AnnouncementFeed,
  ANNOUNCEMENTS_MAX_ASSET_BYTES,
  ANNOUNCEMENTS_MAX_BODY_BYTES,
  ANNOUNCEMENTS_MAX_FEED_BYTES,
} from '../../contracts';
import { normalizeAnnouncementFeed } from '../../core/domain';

import type { AnnouncementSource } from '../../core/application/ports';

const MAX_CACHED_FEED_BYTES = 1024 * 1024;

async function readBoundedText(file: string, limit: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const result = await handle.read(bytes, length, bytes.byteLength - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new Error('cache_too_large');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

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
    const file = path.join(this.directory, 'feed.json');
    try {
      const cached = JSON.parse(await readBoundedText(file, MAX_CACHED_FEED_BYTES)) as {
        feed: unknown;
        etag?: string;
      };
      this.feed = normalizeAnnouncementFeed(cached.feed);
      this.etag =
        typeof cached.etag === 'string' && cached.etag.length < 1000 ? cached.etag : undefined;
    } catch {
      /* Cache is disposable; corruption never changes consumption state. */
      this.feed = null;
      this.etag = undefined;
      await fs.unlink(file).catch(() => undefined);
    }
  }
  private async getBytes(
    url: string,
    limit: number,
    kind: 'feed' | 'body' | 'asset',
    signal: AbortSignal
  ): Promise<{ bytes: Buffer; etag?: string; type: string } | null> {
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
            headers: {
              ...(kind === 'feed' && this.etag ? { 'If-None-Match': this.etag } : {}),
              Accept:
                kind === 'feed'
                  ? 'application/json'
                  : kind === 'body'
                    ? 'text/markdown,text/plain'
                    : 'image/png,image/jpeg,image/gif,image/webp,image/avif',
            },
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => undefined);
          if (!location || redirects === 3) throw new Error('fetch_failed');
          const next = new URL(location, target);
          if (
            next.origin !== this.origin ||
            next.username ||
            next.password ||
            !next.pathname.startsWith('/announcements/') ||
            kind === 'asset'
          )
            throw new Error('fetch_failed');
          target = next.href;
        }
        if (!response) throw new Error('fetch_failed');
        const rejectResponse = async (message: string): Promise<never> => {
          await response?.body?.cancel().catch(() => undefined);
          throw new Error(message);
        };
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
          await rejectResponse(response.status === 404 ? 'body_missing' : 'fetch_failed');
        const type = response.headers.get('content-type')?.split(';')[0].trim();
        const allowedTypes =
          kind === 'feed'
            ? ['application/json']
            : kind === 'body'
              ? ['text/markdown', 'text/plain', 'text/x-markdown']
              : ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
        if (!type || !allowedTypes.includes(type)) return rejectResponse('feed_invalid');
        const body = response.body;
        if (!body) return rejectResponse('fetch_failed');
        const reader = body.getReader();
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
          bytes: Buffer.concat(chunks),
          etag: response.headers.get('etag') ?? undefined,
          type,
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
  private async getText(
    url: string,
    limit: number,
    kind: 'feed' | 'body',
    signal: AbortSignal
  ): Promise<{ text: string; etag?: string } | null> {
    const result = await this.getBytes(url, limit, kind, signal);
    return result ? { text: result.bytes.toString('utf8'), etag: result.etag } : null;
  }
  async refresh(signal: AbortSignal): Promise<AnnouncementFeed> {
    const result = await this.getText(this.url, ANNOUNCEMENTS_MAX_FEED_BYTES, 'feed', signal);
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
      const text = await readBoundedText(file, ANNOUNCEMENTS_MAX_BODY_BYTES);
      if (valid(text)) {
        if (!signal.aborted) await fs.utimes(file, new Date(), new Date()).catch(() => undefined);
        return { markdown: text, bodyUrl };
      }
    } catch {
      /* Fetch absent or damaged cached content. */
    }
    await fs.unlink(file).catch(() => undefined);
    const result = await this.getText(bodyUrl, ANNOUNCEMENTS_MAX_BODY_BYTES, 'body', signal);
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
  async asset(
    url: string,
    bodyUrl: string,
    maxBytes: number,
    signal: AbortSignal
  ): Promise<{ dataUrl: string; decodedBytes: number }> {
    const target = new URL(url, this.origin);
    const body = new URL(bodyUrl, this.origin);
    const assetRoot = new URL('assets/', body);
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      target.origin !== this.origin ||
      target.origin !== assetRoot.origin ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      /%2f|%5c|%2e/i.test(target.pathname) ||
      !target.pathname.startsWith(assetRoot.pathname) ||
      target.pathname.length === assetRoot.pathname.length
    )
      throw new Error('asset_invalid');
    const result = await this.getBytes(
      target.href,
      Math.min(ANNOUNCEMENTS_MAX_ASSET_BYTES, maxBytes),
      'asset',
      signal
    );
    if (!result || signal.aborted) throw new Error('asset_invalid');
    return {
      dataUrl: `data:${result.type};base64,${result.bytes.toString('base64')}`,
      decodedBytes: result.bytes.byteLength,
    };
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
