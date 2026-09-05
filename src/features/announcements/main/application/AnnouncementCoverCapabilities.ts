import {
  ANNOUNCEMENTS_MAX_ARTICLE_ASSET_BYTES,
  ANNOUNCEMENTS_MAX_ASSET_BYTES,
  ANNOUNCEMENTS_MAX_ASSET_REQUESTS,
} from '../../contracts';

import type { Announcement } from '../../contracts';
import type { AnnouncementSource, AnnouncementWindowContext } from '../../core/application/ports';
import type { AnnouncementAssetScheduler } from './AnnouncementAssetScheduler';

interface CoverLoad {
  controller: AbortController;
  consumers: Set<string>;
  promise: Promise<{ dataUrl: string; decodedBytes: number }>;
}

interface CoverScope {
  documentGeneration: number;
  acceptedBytes: number;
  accepted: Map<string, string>;
  loads: Map<string, CoverLoad>;
  requests: Map<string, string>;
}

const coverKey = (item: Announcement): string =>
  `${item.id}:${item.bodySha256}:${item.heroImagePath ?? ''}`;

export class AnnouncementCoverCapabilities {
  private readonly scopes = new Map<number, CoverScope>();

  constructor(
    private readonly source: AnnouncementSource,
    private readonly scheduler: AnnouncementAssetScheduler
  ) {}

  private isIssued(scope: CoverScope): boolean {
    for (const current of this.scopes.values()) if (current === scope) return true;
    return false;
  }

  private scope(context: AnnouncementWindowContext): CoverScope {
    const generation = context.documentGeneration ?? context.uiGeneration;
    let scope = this.scopes.get(context.windowId);
    if (scope?.documentGeneration !== generation) {
      this.revokeWindow(context.windowId);
      scope = undefined;
    }
    if (!scope) {
      scope = {
        documentGeneration: generation,
        acceptedBytes: 0,
        accepted: new Map(),
        loads: new Map(),
        requests: new Map(),
      };
      this.scopes.set(context.windowId, scope);
    }
    return scope;
  }

  revokeWindow(windowId: number): void {
    const scope = this.scopes.get(windowId);
    if (!scope) return;
    for (const load of scope.loads.values()) load.controller.abort();
    this.scopes.delete(windowId);
  }

  revokeAll(): void {
    for (const windowId of [...this.scopes.keys()]) this.revokeWindow(windowId);
  }

  async load(
    item: Announcement,
    requestId: string,
    context: AnnouncementWindowContext
  ): Promise<string | null> {
    const heroImagePath = item.heroImagePath;
    if (!heroImagePath) return null;
    const scope = this.scope(context);
    if (scope.requests.has(requestId) || scope.requests.size >= ANNOUNCEMENTS_MAX_ASSET_REQUESTS) {
      if (scope.requests.size >= ANNOUNCEMENTS_MAX_ASSET_REQUESTS)
        this.revokeWindow(context.windowId);
      return null;
    }
    const key = coverKey(item);
    const cached = scope.accepted.get(key);
    if (cached) return cached;
    let load = scope.loads.get(key);
    if (!load) {
      const remaining = ANNOUNCEMENTS_MAX_ARTICLE_ASSET_BYTES - scope.acceptedBytes;
      if (
        scope.accepted.size + scope.loads.size >= ANNOUNCEMENTS_MAX_ASSET_REQUESTS ||
        remaining <= 0
      )
        return null;
      const controller = new AbortController();
      const maxBytes = Math.min(ANNOUNCEMENTS_MAX_ASSET_BYTES, remaining);
      const promise = this.scheduler.run(
        () => this.isIssued(scope),
        controller.signal,
        () => this.source.asset(heroImagePath, item.bodyPath, maxBytes, controller.signal)
      );
      load = { controller, consumers: new Set(), promise };
      scope.loads.set(key, load);
    }
    load.consumers.add(requestId);
    scope.requests.set(requestId, key);
    try {
      const result = await load.promise;
      if (this.scopes.get(context.windowId) !== scope) return null;
      if (!scope.accepted.has(key)) {
        if (result.decodedBytes > ANNOUNCEMENTS_MAX_ARTICLE_ASSET_BYTES - scope.acceptedBytes) {
          this.revokeWindow(context.windowId);
          return null;
        }
        scope.acceptedBytes += result.decodedBytes;
        scope.accepted.set(key, result.dataUrl);
      }
      return scope.requests.get(requestId) === key ? scope.accepted.get(key)! : null;
    } catch (error) {
      if (error instanceof Error && error.message === 'response_too_large')
        this.revokeWindow(context.windowId);
      return null;
    } finally {
      scope.requests.delete(requestId);
      load.consumers.delete(requestId);
      if (load.consumers.size === 0) load.controller.abort();
      if (scope.loads.get(key) === load) scope.loads.delete(key);
    }
  }

  cancel(
    requestId: string,
    context: Pick<AnnouncementWindowContext, 'windowId' | 'uiGeneration' | 'documentGeneration'>
  ): void {
    const scope = this.scopes.get(context.windowId);
    if (!scope) return;
    if (scope.documentGeneration !== (context.documentGeneration ?? context.uiGeneration)) {
      this.revokeWindow(context.windowId);
      return;
    }
    const key = scope.requests.get(requestId);
    if (!key) return;
    scope.requests.delete(requestId);
    const load = scope.loads.get(key);
    load?.consumers.delete(requestId);
    if (load?.consumers.size === 0) {
      load.controller.abort();
      if (scope.loads.get(key) === load) scope.loads.delete(key);
    }
  }
}
