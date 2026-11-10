import {
  ANNOUNCEMENTS_MAX_ARTICLE_ASSET_BYTES,
  ANNOUNCEMENTS_MAX_ASSET_REQUESTS,
  ANNOUNCEMENTS_MAX_CONCURRENT_ASSETS,
} from '../contracts';

import type { AnnouncementsApi } from '../contracts';

interface QueuedAsset {
  url: string;
  resolve: (value: string | null) => void;
}

let nextRequestId = 0;

function safeScope(value: string): string {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function requestId(scope: string): string {
  nextRequestId = (nextRequestId + 1) % Number.MAX_SAFE_INTEGER;
  return `article_${scope}_${Date.now().toString(36)}_${nextRequestId.toString(36)}`;
}

function decodedBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) return Infinity;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** One bounded loader per open article; disposing it cancels queued and active IPC work. */
export class AnnouncementAssetLoader {
  private active = 0;
  private requested = 0;
  private acceptedBytes = 0;
  private disposed = false;
  private leases = 0;
  private leaseGeneration = 0;
  private readonly queue: QueuedAsset[] = [];
  private readonly results = new Map<string, Promise<string | null>>();
  private readonly activeRequests = new Set<string>();
  private readonly scope: string;

  constructor(
    private readonly client: AnnouncementsApi,
    articleUrl = ''
  ) {
    this.scope = safeScope(articleUrl);
  }

  load(url: string): Promise<string | null> {
    const existing = this.results.get(url);
    if (existing) return existing;
    if (this.disposed || this.requested >= ANNOUNCEMENTS_MAX_ASSET_REQUESTS)
      return Promise.resolve(null);
    this.requested++;
    const result = new Promise<string | null>((resolve) => this.queue.push({ url, resolve }));
    this.results.set(url, result);
    this.pump();
    return result;
  }

  retain(): void {
    if (this.disposed) return;
    this.leases++;
    this.leaseGeneration++;
  }

  release(): void {
    this.leases = Math.max(0, this.leases - 1);
    const generation = ++this.leaseGeneration;
    queueMicrotask(() => {
      if (this.leases === 0 && this.leaseGeneration === generation) this.dispose();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.queue.splice(0)) item.resolve(null);
    for (const id of this.activeRequests) void this.client.cancelAsset(id).catch(() => undefined);
    this.results.clear();
  }

  private pump(): void {
    while (
      !this.disposed &&
      this.active < ANNOUNCEMENTS_MAX_CONCURRENT_ASSETS &&
      this.queue.length > 0
    ) {
      const item = this.queue.shift();
      if (!item) return;
      this.active++;
      const id = requestId(this.scope);
      this.activeRequests.add(id);
      void this.client
        .loadAsset(item.url, id)
        .then((value) => {
          if (!value || this.disposed) return null;
          const size = decodedBytes(value);
          if (
            !Number.isFinite(size) ||
            this.acceptedBytes + size > ANNOUNCEMENTS_MAX_ARTICLE_ASSET_BYTES
          )
            return null;
          this.acceptedBytes += size;
          return value;
        })
        .catch(() => null)
        .then(item.resolve)
        .finally(() => {
          this.activeRequests.delete(id);
          this.active--;
          this.pump();
        });
    }
  }
}
