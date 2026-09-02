import type { RuntimeProviderManagementModelsResponse } from '../../contracts';

export interface ModelResponseInFlightEntry {
  controller: AbortController;
  hasUngroupedSubscriber: boolean;
  requestGroups: Set<string>;
  promise: Promise<RuntimeProviderManagementModelsResponse>;
}

export class RuntimeProviderModelRequestTracker {
  private readonly inFlight = new Map<string, ModelResponseInFlightEntry>();
  private readonly activeGroups = new Map<string, string>();

  clear(abortInFlight: boolean): void {
    if (abortInFlight) {
      for (const entry of this.inFlight.values()) entry.controller.abort();
    }
    this.inFlight.clear();
    this.activeGroups.clear();
  }

  releaseSuperseded(requestGroupId: string, nextCacheKey: string): void {
    const previousCacheKey = this.activeGroups.get(requestGroupId);
    if (!previousCacheKey || previousCacheKey === nextCacheKey) return;
    this.activeGroups.delete(requestGroupId);
    this.releaseSubscriber(previousCacheKey, requestGroupId);
  }

  releaseActiveGroup(requestGroupId: string, cacheKey: string): void {
    if (this.activeGroups.get(requestGroupId) === cacheKey) {
      this.activeGroups.delete(requestGroupId);
    }
  }

  register(
    entry: ModelResponseInFlightEntry,
    cacheKey: string,
    requestGroupId: string | null
  ): void {
    if (requestGroupId) {
      entry.requestGroups.add(requestGroupId);
      this.activeGroups.set(requestGroupId, cacheKey);
    } else {
      entry.hasUngroupedSubscriber = true;
    }
  }

  get(cacheKey: string): ModelResponseInFlightEntry | undefined {
    return this.inFlight.get(cacheKey);
  }

  set(cacheKey: string, entry: ModelResponseInFlightEntry): void {
    this.inFlight.set(cacheKey, entry);
  }

  discard(cacheKey: string): void {
    this.inFlight.delete(cacheKey);
  }

  cleanup(cacheKey: string, entry: ModelResponseInFlightEntry): void {
    if (this.inFlight.get(cacheKey) !== entry) return;
    this.inFlight.delete(cacheKey);
    for (const requestGroupId of entry.requestGroups) {
      this.releaseActiveGroup(requestGroupId, cacheKey);
    }
  }

  cancel(requestGroupId: string): void {
    const cacheKey = this.activeGroups.get(requestGroupId);
    if (!cacheKey) return;
    this.activeGroups.delete(requestGroupId);
    this.releaseSubscriber(cacheKey, requestGroupId);
  }

  private releaseSubscriber(cacheKey: string, requestGroupId: string): void {
    const entry = this.inFlight.get(cacheKey);
    if (!entry) return;
    entry.requestGroups.delete(requestGroupId);
    if (!entry.hasUngroupedSubscriber && entry.requestGroups.size === 0) {
      entry.controller.abort();
    }
  }
}
