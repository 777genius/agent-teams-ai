import {
  ANNOUNCEMENTS_MAX_ARTICLE_ASSET_BYTES,
  ANNOUNCEMENTS_MAX_ASSET_REQUESTS,
  ANNOUNCEMENTS_MAX_CONCURRENT_ASSETS,
} from '../../contracts';

import type { Announcement } from '../../contracts';
import type {
  AnnouncementAssetResult,
  AnnouncementSource,
  AnnouncementWindowContext,
} from '../../core/application/ports';

interface IssuedDocument {
  item: Announcement;
  documentGeneration: number;
  acceptedBytes: number;
  accepted: Map<string, string>;
  loads: Map<string, AssetLoad>;
  requests: Map<string, string>;
}
interface AssetLoad {
  controller: AbortController;
  consumers: Set<string>;
  promise: Promise<AnnouncementAssetResult>;
}

const MAX_GLOBAL_QUEUED_ASSETS = 64;

export class AnnouncementAssetCapabilities {
  private readonly documents = new Map<number, IssuedDocument>();
  private activeLoads = 0;
  private readonly waiting: Array<{
    document: IssuedDocument;
    resolve: (granted: boolean) => void;
  }> = [];
  constructor(private readonly source: AnnouncementSource) {}

  private isIssued(document: IssuedDocument): boolean {
    for (const current of this.documents.values()) if (current === document) return true;
    return false;
  }

  private acquireSlot(document: IssuedDocument): Promise<boolean> {
    if (this.activeLoads < ANNOUNCEMENTS_MAX_CONCURRENT_ASSETS) {
      this.activeLoads++;
      return Promise.resolve(true);
    }
    if (this.waiting.length >= MAX_GLOBAL_QUEUED_ASSETS) return Promise.resolve(false);
    return new Promise((resolve) => this.waiting.push({ document, resolve }));
  }

  private releaseSlot(): void {
    this.activeLoads--;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      if (!this.isIssued(waiter.document)) {
        waiter.resolve(false);
        continue;
      }
      this.activeLoads++;
      waiter.resolve(true);
      break;
    }
  }

  issue(item: Announcement, context: AnnouncementWindowContext): void {
    this.revokeWindow(context.windowId);
    this.documents.set(context.windowId, {
      item: { ...item },
      documentGeneration: context.documentGeneration ?? context.uiGeneration,
      acceptedBytes: 0,
      accepted: new Map(),
      loads: new Map(),
      requests: new Map(),
    });
  }

  revokeWindow(windowId: number): void {
    const document = this.documents.get(windowId);
    if (!document) return;
    for (const load of document.loads.values()) load.controller.abort();
    this.documents.delete(windowId);
  }

  revokeAnnouncement(windowId: number, id: string): void {
    if (this.documents.get(windowId)?.item.id === id) this.revokeWindow(windowId);
  }

  revokeAll(): void {
    for (const windowId of [...this.documents.keys()]) this.revokeWindow(windowId);
  }

  private exactAssetUrl(item: Announcement, input: string): string | null {
    try {
      const target = new URL(input);
      const body = new URL(item.bodyPath, target.origin);
      const root = new URL('assets/', body);
      if (
        target.origin !== root.origin ||
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        /%2f|%5c|%2e/i.test(target.pathname) ||
        !target.pathname.startsWith(root.pathname) ||
        target.pathname.length === root.pathname.length
      )
        return null;
      return target.href;
    } catch {
      return null;
    }
  }

  async load(
    url: string,
    requestId: string,
    context: AnnouncementWindowContext
  ): Promise<string | null> {
    const document = this.documents.get(context.windowId);
    if (!document) return null;
    if (document.documentGeneration !== (context.documentGeneration ?? context.uiGeneration)) {
      this.revokeWindow(context.windowId);
      return null;
    }
    const exactUrl = this.exactAssetUrl(document.item, url);
    if (
      !exactUrl ||
      document.requests.has(requestId) ||
      document.requests.size >= ANNOUNCEMENTS_MAX_ASSET_REQUESTS
    ) {
      if (document.requests.size >= ANNOUNCEMENTS_MAX_ASSET_REQUESTS)
        this.revokeWindow(context.windowId);
      return null;
    }
    const cached = document.accepted.get(exactUrl);
    if (cached) return cached;
    let load = document.loads.get(exactUrl);
    if (!load) {
      const uniqueCount = document.accepted.size + document.loads.size;
      const remaining = ANNOUNCEMENTS_MAX_ARTICLE_ASSET_BYTES - document.acceptedBytes;
      if (uniqueCount >= ANNOUNCEMENTS_MAX_ASSET_REQUESTS || remaining <= 0) {
        this.revokeWindow(context.windowId);
        return null;
      }
      const controller = new AbortController();
      const promise = (async () => {
        const granted = await this.acquireSlot(document);
        if (!granted) throw new Error('asset_cancelled');
        try {
          if (controller.signal.aborted) throw new Error('asset_cancelled');
          return await this.source.asset(
            exactUrl,
            document.item.bodyPath,
            remaining,
            controller.signal
          );
        } finally {
          this.releaseSlot();
        }
      })();
      load = { controller, consumers: new Set(), promise };
      document.loads.set(exactUrl, load);
    }
    load.consumers.add(requestId);
    document.requests.set(requestId, exactUrl);
    try {
      const result = await load.promise;
      if (
        this.documents.get(context.windowId) !== document ||
        document.documentGeneration !== (context.documentGeneration ?? context.uiGeneration)
      )
        return null;
      if (!document.accepted.has(exactUrl)) {
        if (result.decodedBytes > ANNOUNCEMENTS_MAX_ARTICLE_ASSET_BYTES - document.acceptedBytes) {
          this.revokeWindow(context.windowId);
          return null;
        }
        document.acceptedBytes += result.decodedBytes;
        document.accepted.set(exactUrl, result.dataUrl);
      }
      return document.requests.get(requestId) === exactUrl
        ? document.accepted.get(exactUrl)!
        : null;
    } catch (error) {
      if (error instanceof Error && error.message === 'response_too_large') {
        this.revokeWindow(context.windowId);
      }
      return null;
    } finally {
      document.requests.delete(requestId);
      load.consumers.delete(requestId);
      if (load.consumers.size === 0) load.controller.abort();
      if (document.loads.get(exactUrl) === load) document.loads.delete(exactUrl);
    }
  }

  cancel(
    requestId: string,
    context: Pick<AnnouncementWindowContext, 'windowId' | 'uiGeneration' | 'documentGeneration'>
  ): void {
    const document = this.documents.get(context.windowId);
    if (!document) return;
    if (document.documentGeneration !== (context.documentGeneration ?? context.uiGeneration)) {
      this.revokeWindow(context.windowId);
      return;
    }
    const url = document.requests.get(requestId);
    if (!url) return;
    document.requests.delete(requestId);
    const load = document.loads.get(url);
    load?.consumers.delete(requestId);
    if (load?.consumers.size === 0) load.controller.abort();
  }
}
