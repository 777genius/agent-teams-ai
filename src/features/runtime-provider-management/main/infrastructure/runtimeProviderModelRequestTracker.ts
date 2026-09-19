import type { RuntimeProviderManagementModelsResponse } from '../../contracts';

export interface ModelResponseInFlightEntry {
  controller: AbortController;
  refresh?: boolean;
  hasUngroupedSubscriber: boolean;
  requestGroups: Set<string>;
  promise: Promise<RuntimeProviderManagementModelsResponse>;
}

interface ActiveModelRequestGroup {
  cacheKey: string;
  entry: ModelResponseInFlightEntry;
}

export class RuntimeProviderModelRequestTracker {
  private readonly inFlight = new Map<string, ModelResponseInFlightEntry>();
  private readonly lifecycleEntries = new Set<ModelResponseInFlightEntry>();
  private readonly activeGroups = new Map<string, ActiveModelRequestGroup>();
  private readonly generations = new Map<string, number>();

  clear(abortInFlight: boolean): void {
    if (abortInFlight) {
      const entries = new Set(this.lifecycleEntries);
      for (const { entry } of this.activeGroups.values()) entries.add(entry);
      for (const entry of entries) entry.controller.abort();
      this.activeGroups.clear();
    }
    this.inFlight.clear();
    this.generations.clear();
  }

  reuseRefresh(
    cacheKey: string,
    requestGroupId: string | null
  ): Promise<RuntimeProviderManagementModelsResponse> | null {
    const current = this.inFlight.get(cacheKey);
    if (!current || current.controller.signal.aborted) return null;
    if (
      current.refresh !== true &&
      !(requestGroupId && current.requestGroups.has(requestGroupId))
    ) {
      return null;
    }
    this.register(current, cacheKey, requestGroupId);
    return current.promise;
  }

  beginRefresh(cacheKey: string): void {
    this.generations.set(cacheKey, this.getGeneration(cacheKey) + 1);
    this.discard(cacheKey);
  }

  getGeneration(cacheKey: string): number {
    return this.generations.get(cacheKey) ?? 0;
  }

  isGenerationCurrent(cacheKey: string, generation: number): boolean {
    return generation === this.getGeneration(cacheKey);
  }

  releaseSuperseded(requestGroupId: string, nextCacheKey: string): void {
    const previous = this.activeGroups.get(requestGroupId);
    if (!previous || previous.cacheKey === nextCacheKey) return;
    this.activeGroups.delete(requestGroupId);
    this.releaseSubscriber(previous.entry, requestGroupId);
  }

  releaseForCacheHit(requestGroupId: string, cacheKey: string): void {
    const activeRequest = this.activeGroups.get(requestGroupId);
    if (!activeRequest || activeRequest.cacheKey !== cacheKey) return;
    this.activeGroups.delete(requestGroupId);
    this.releaseSubscriber(activeRequest.entry, requestGroupId);
  }

  register(
    entry: ModelResponseInFlightEntry,
    cacheKey: string,
    requestGroupId: string | null
  ): void {
    if (requestGroupId) {
      const previous = this.activeGroups.get(requestGroupId);
      if (previous && previous.entry !== entry) {
        this.releaseSubscriber(previous.entry, requestGroupId);
      }
      entry.requestGroups.add(requestGroupId);
      this.activeGroups.set(requestGroupId, { cacheKey, entry });
    } else {
      entry.hasUngroupedSubscriber = true;
    }
  }

  get(cacheKey: string): ModelResponseInFlightEntry | undefined {
    return this.inFlight.get(cacheKey);
  }

  set(cacheKey: string, entry: ModelResponseInFlightEntry): void {
    this.inFlight.set(cacheKey, entry);
    this.lifecycleEntries.add(entry);
  }

  discard(cacheKey: string): void {
    this.inFlight.delete(cacheKey);
  }

  cleanup(cacheKey: string, entry: ModelResponseInFlightEntry): void {
    if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey);
    this.lifecycleEntries.delete(entry);
    for (const requestGroupId of entry.requestGroups) {
      if (this.activeGroups.get(requestGroupId)?.entry === entry) {
        this.activeGroups.delete(requestGroupId);
      }
    }
  }

  cancel(requestGroupId: string): void {
    const activeRequest = this.activeGroups.get(requestGroupId);
    if (!activeRequest) return;
    this.activeGroups.delete(requestGroupId);
    this.releaseSubscriber(activeRequest.entry, requestGroupId);
  }

  private releaseSubscriber(entry: ModelResponseInFlightEntry, requestGroupId: string): void {
    entry.requestGroups.delete(requestGroupId);
    if (!entry.hasUngroupedSubscriber && entry.requestGroups.size === 0) {
      entry.controller.abort();
    }
  }
}
