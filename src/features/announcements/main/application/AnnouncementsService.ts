import {
  consumeAnnouncement,
  createAnnouncementState,
  dismissAnnouncement,
  selectAutoAnnouncement,
  visibleAnnouncements,
} from '../../core/domain';

import { AnnouncementUsageTracker } from './AnnouncementUsageTracker';

import type {
  Announcement,
  AnnouncementDocument,
  AnnouncementsSnapshot,
  AnnouncementState,
  AnnouncementSummary,
  ClaimAnnouncementInput,
  PreparedAnnouncement,
} from '../../contracts';
import type {
  AnnouncementClock,
  AnnouncementOwner,
  AnnouncementRepository,
  AnnouncementSource,
  AnnouncementWindowContext,
} from '../../core/application/ports';

const summarize = (item: Announcement): AnnouncementSummary => ({
  id: item.id,
  title: item.title,
  publishedAt: item.publishedAt,
  validUntil: item.validUntil,
  status: item.status,
});

export interface AnnouncementsServiceOptions {
  repository: AnnouncementRepository;
  owner: AnnouncementOwner;
  source: AnnouncementSource;
  clock: AnnouncementClock;
  origin: AnnouncementState['origin'];
  firstOpenedAt?: string;
  networkEnabled: boolean;
  diagnostic?: (reason: string) => void;
}

export class AnnouncementsService {
  private readonly tracker: AnnouncementUsageTracker;
  private state: AnnouncementState | null = null;
  private owned = false;
  private releasing = false;
  private previousHeartbeat: number | null = null;
  private storageFailed = false;
  private stopped = false;
  private initialized = false;
  private suspended = false;
  private generation = 0;
  private controller = new AbortController();
  private listeners = new Set<(snapshot: AnnouncementsSnapshot) => void>();
  private prepared = new Map<
    number,
    { generation: number; uiGeneration: number; document: PreparedAnnouncement }
  >();
  private validatedAt: number | null = null;
  private validatedMono: number | null = null;
  private fresh = false;
  private lastRefreshAttempt = -Infinity;
  private refreshTask: Promise<AnnouncementsSnapshot> | null = null;
  private lifecycleTail: Promise<unknown> = Promise.resolve();
  private mutationTail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheckpoint = 0;
  private firstOpenedAt?: string;
  private lastOwnerAttempt = -Infinity;
  private lastReportedStatus: string | null = null;
  private nextRefreshAt = 0;
  private failedBodyKey: string | null = null;

  constructor(private readonly options: AnnouncementsServiceOptions) {
    this.tracker = new AnnouncementUsageTracker(options.clock);
    this.firstOpenedAt = options.firstOpenedAt;
  }
  private lifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.catch(() => undefined);
    return result;
  }
  private mutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.catch(() => undefined);
    return result;
  }
  async initialize(): Promise<void> {
    if (this.initialized || this.stopped) return;
    this.initialized = true;
    await this.options.source.loadCached();
    this.lastCheckpoint = this.options.clock.monotonic();
    this.timer = setInterval(() => {
      void this.heartbeat();
    }, 5000);
    this.timer.unref?.();
    if (this.tracker.hasWindows()) await this.lifecycle(() => this.acquire());
    this.emit();
  }
  registerWindow(id: number, openedAt?: string): void {
    if (this.stopped) return;
    this.firstOpenedAt ??= openedAt ?? new Date(this.options.clock.now()).toISOString();
    this.tracker.register(id);
    if (this.initialized) void this.lifecycle(() => this.acquire());
  }
  unregisterWindow(id: number): Promise<void> {
    this.tracker.unregister(id);
    this.prepared.delete(id);
    return this.lifecycle(async () => {
      if (!this.tracker.hasWindows()) await this.release();
    });
  }
  private async acquire(): Promise<void> {
    if (this.owned || this.stopped || !this.tracker.hasWindows()) return;
    this.lastOwnerAttempt = this.options.clock.monotonic();
    try {
      this.owned = await this.options.owner.acquire();
    } catch {
      this.storageFailed = true;
      this.emit();
      return;
    }
    if (!this.owned) {
      this.emit();
      return;
    }
    this.generation++;
    this.controller = new AbortController();
    this.lastRefreshAttempt = -Infinity;
    try {
      this.state = await this.options.repository.initialize(
        createAnnouncementState(
          this.options.origin,
          new Date(this.options.clock.now()).toISOString(),
          this.firstOpenedAt ?? null
        )
      );
      this.storageFailed = false;
      this.tracker.takePending();
      this.tracker.setEnabled(true);
      this.lastCheckpoint = this.options.clock.monotonic();
    } catch {
      this.storageFailed = true;
      this.state = null;
    }
    await this.refresh();
    this.emit();
  }
  private async release(): Promise<void> {
    if (!this.owned) return;
    this.releasing = true;
    this.tracker.setEnabled(false);
    this.generation++;
    this.controller.abort();
    await this.refreshTask;
    this.prepared.clear();
    this.fresh = false;
    await this.mutationTail;
    await this.checkpoint();
    await this.options.repository.drain();
    // A body can be awaiting its atomic rename before it enters the mutation queue.
    // Abort prevents later continuations from writing; drain finishes writes already started.
    await this.options.source.drain();
    try {
      await this.options.owner.release();
      this.owned = false;
    } catch {
      this.storageFailed = true;
    }
    this.state = null;
    this.releasing = false;
    this.emit();
  }
  private async checkpoint(): Promise<void> {
    const elapsed = this.tracker.takePending();
    if (!elapsed || !this.owned || this.storageFailed || !this.state) return;
    try {
      this.state = await this.options.repository.update((state) => ({
        ...state,
        accumulatedOpenMs: state.accumulatedOpenMs + elapsed,
      }));
    } catch {
      this.storageFailed = true;
      this.fresh = false;
    }
    this.lastCheckpoint = this.options.clock.monotonic();
  }
  private async heartbeat(): Promise<void> {
    if (this.stopped) return;
    this.tracker.tick();
    const mono = this.options.clock.monotonic();
    if (this.previousHeartbeat !== null && mono - this.previousHeartbeat > 15_000) {
      this.fresh = false;
      this.lastRefreshAttempt = -Infinity;
      this.nextRefreshAt = mono;
    }
    this.previousHeartbeat = mono;
    if (!this.owned && this.tracker.hasWindows() && mono - this.lastOwnerAttempt >= 30_000)
      void this.lifecycle(() => this.acquire());
    if (this.owned && mono - this.lastCheckpoint >= 30_000)
      await this.mutation(() => this.checkpoint());
    if (this.owned && !this.suspended && mono >= this.nextRefreshAt) void this.refresh();
    this.emit();
  }
  foreground(): void {
    if (this.stopped) return;
    if (!this.owned) void this.lifecycle(() => this.acquire());
    else if (!this.isFresh()) void this.refresh();
    this.emit();
  }
  async suspend(): Promise<void> {
    if (this.suspended) return;
    this.suspended = true;
    this.previousHeartbeat = null;
    this.tracker.suspend();
    this.fresh = false;
    this.generation++;
    this.controller.abort();
    await this.refreshTask;
    this.prepared.clear();
    await this.mutation(() => this.checkpoint());
    this.emit();
  }
  resume(): void {
    if (!this.suspended || this.stopped) return;
    this.suspended = false;
    this.controller = new AbortController();
    this.tracker.resume();
    const mono = this.options.clock.monotonic();
    this.previousHeartbeat = mono;
    this.nextRefreshAt = mono;
    const pendingRefresh = this.refreshTask;
    const generation = this.generation;
    void (async () => {
      await pendingRefresh;
      if (this.suspended || this.stopped || !this.owned || generation !== this.generation) return;
      this.lastRefreshAttempt = -Infinity;
      await this.refresh();
    })().catch(() => undefined);
    this.emit();
  }
  private isFresh(): boolean {
    if (!this.fresh || this.validatedAt === null || this.validatedMono === null || this.suspended)
      return false;
    const wallAge = this.options.clock.now() - this.validatedAt;
    const monoAge = this.options.clock.monotonic() - this.validatedMono;
    if (
      monoAge < 0 ||
      wallAge < 0 ||
      Math.abs(wallAge - monoAge) > 15_000 ||
      monoAge > 20 * 60_000
    ) {
      this.fresh = false;
      return false;
    }
    return true;
  }
  private effectiveState(): AnnouncementState | null {
    return this.state
      ? {
          ...this.state,
          accumulatedOpenMs: this.state.accumulatedOpenMs + this.tracker.pendingMs(),
        }
      : null;
  }
  private snapshot(): AnnouncementsSnapshot {
    const feed = this.options.source.current();
    const state = this.effectiveState();
    const ready = this.owned && !this.storageFailed && this.isFresh();
    return {
      status: !this.owned
        ? 'writer_busy'
        : this.storageFailed
          ? 'state_unavailable'
          : !this.options.networkEnabled || feed?.autoShowEnabled === false
            ? 'disabled'
            : !this.isFresh()
              ? 'offline'
              : 'ready',
      revision: feed?.revision ?? null,
      items: feed
        ? visibleAnnouncements(feed, this.options.clock.now()).map((item) => summarize(item))
        : [],
      candidateId:
        ready && feed && state
          ? (selectAutoAnnouncement(feed, state, this.options.clock.now())?.id ?? null)
          : null,
      checkedAt: this.validatedAt === null ? null : new Date(this.validatedAt).toISOString(),
      autoShowEnabled: ready && (feed?.autoShowEnabled ?? false),
    };
  }
  async getSnapshot(): Promise<AnnouncementsSnapshot> {
    return this.snapshot();
  }
  subscribe(listener: (snapshot: AnnouncementsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    const value = this.snapshot();
    if (value.status !== this.lastReportedStatus) {
      this.lastReportedStatus = value.status;
      this.options.diagnostic?.(value.status);
    }
    for (const listener of this.listeners) listener(value);
  }
  async refresh(): Promise<AnnouncementsSnapshot> {
    if (this.refreshTask) return this.refreshTask;
    const mono = this.options.clock.monotonic();
    if (
      !this.owned ||
      this.releasing ||
      this.stopped ||
      this.suspended ||
      !this.options.networkEnabled ||
      mono - this.lastRefreshAttempt < 5000
    )
      return this.snapshot();
    if (mono >= this.nextRefreshAt) this.failedBodyKey = null;
    this.lastRefreshAttempt = mono;
    this.nextRefreshAt = mono + 15 * 60_000 + Math.floor(Math.random() * 30_000);
    const generation = this.generation;
    this.refreshTask = (async () => {
      try {
        await this.options.source.refresh(this.controller.signal);
        if (generation === this.generation && !this.stopped) {
          this.validatedAt = this.options.clock.now();
          this.validatedMono = this.options.clock.monotonic();
          this.fresh = true;
          this.prepared.clear();
        }
      } catch {
        if (generation === this.generation) this.fresh = false;
      }
      this.emit();
      return this.snapshot();
    })().finally(() => {
      this.refreshTask = null;
    });
    return this.refreshTask;
  }
  private candidate(context: AnnouncementWindowContext) {
    if (
      !this.owned ||
      this.releasing ||
      this.stopped ||
      this.storageFailed ||
      !this.isFresh() ||
      !this.tracker.ownsWindow(context.windowId) ||
      !context.isReady()
    )
      return null;
    const state = this.effectiveState();
    const feed = this.options.source.current();
    const item =
      feed && state ? selectAutoAnnouncement(feed, state, this.options.clock.now()) : null;
    return item && this.failedBodyKey !== `${feed?.revision}:${item.id}:${item.bodySha256}`
      ? item
      : null;
  }
  async prepareAuto(context: AnnouncementWindowContext): Promise<PreparedAnnouncement | null> {
    const item = this.candidate(context);
    const feed = this.options.source.current();
    if (!item || !feed) return null;
    const generation = this.generation;
    try {
      const body = await this.options.source.body(item, this.controller.signal);
      const current = this.candidate(context);
      if (
        generation !== this.generation ||
        current?.id !== item.id ||
        current.bodySha256 !== item.bodySha256 ||
        this.options.source.current()?.revision !== feed.revision
      )
        return null;
      const document = {
        announcement: { ...summarize(item), bodySha256: item.bodySha256 },
        ...body,
        revision: feed.revision,
      };
      this.prepared.set(context.windowId, {
        generation,
        uiGeneration: context.uiGeneration,
        document,
      });
      return document;
    } catch {
      this.failedBodyKey = `${feed.revision}:${item.id}:${item.bodySha256}`;
      this.fresh = false;
      this.lastRefreshAttempt = -Infinity;
      void this.refresh();
      this.emit();
      return null;
    }
  }
  claimAuto(
    input: ClaimAnnouncementInput,
    context: AnnouncementWindowContext
  ): Promise<AnnouncementDocument | null> {
    return this.mutation(async () => {
      const prepared = this.prepared.get(context.windowId);
      this.prepared.delete(context.windowId);
      const item = this.candidate(context);
      if (
        !prepared ||
        !item ||
        prepared.generation !== this.generation ||
        prepared.uiGeneration !== context.uiGeneration ||
        item.id !== input.id ||
        item.bodySha256 !== input.bodySha256 ||
        prepared.document.announcement.id !== input.id ||
        prepared.document.announcement.bodySha256 !== input.bodySha256 ||
        prepared.document.revision !== input.revision ||
        this.options.source.current()?.revision !== input.revision
      )
        return null;
      const generation = this.generation;
      await this.checkpoint();
      const rechecked = this.candidate(context);
      if (
        this.storageFailed ||
        generation !== this.generation ||
        rechecked?.id !== item.id ||
        rechecked.bodySha256 !== item.bodySha256 ||
        this.options.source.current()?.revision !== input.revision
      )
        return null;
      try {
        this.state = await this.options.repository.update((state) =>
          consumeAnnouncement(state, item)
        );
      } catch {
        this.storageFailed = true;
        this.fresh = false;
        this.emit();
        return null;
      }
      this.options.diagnostic?.('claim_committed');
      this.emit();
      const currentFeed = this.options.source.current();
      const stillPublished = currentFeed?.items.some(
        (entry) =>
          entry.id === item.id &&
          entry.bodySha256 === item.bodySha256 &&
          entry.status === 'published' &&
          Date.parse(entry.publishedAt) <= this.options.clock.now() &&
          this.options.clock.now() < Date.parse(entry.validUntil)
      );
      return generation === this.generation &&
        context.isReady() &&
        this.isFresh() &&
        currentFeed?.revision === input.revision &&
        stillPublished
        ? {
            announcement: summarize(item),
            markdown: prepared.document.markdown,
            bodyUrl: prepared.document.bodyUrl,
          }
        : null;
    });
  }
  async openManual(id: string): Promise<AnnouncementDocument | null> {
    if (!this.owned || this.releasing || this.stopped) return null;
    const feed = this.options.source.current();
    const item =
      feed && visibleAnnouncements(feed, this.options.clock.now()).find((entry) => entry.id === id);
    if (!item) return null;
    const generation = this.generation;
    try {
      const body = await this.options.source.body(item, this.controller.signal);
      return await this.mutation(async () => {
        const current = this.options.source.current();
        if (
          !this.owned ||
          this.releasing ||
          this.stopped ||
          generation !== this.generation ||
          !current ||
          !visibleAnnouncements(current, this.options.clock.now()).some(
            (entry) => entry.id === id && entry.bodySha256 === item.bodySha256
          )
        )
          return null;
        if (!this.storageFailed && this.state) {
          try {
            this.state = await this.options.repository.update((state) =>
              consumeAnnouncement(state, item)
            );
          } catch {
            this.storageFailed = true;
            this.fresh = false;
          }
        }
        this.emit();
        const latest = this.options.source.current();
        if (
          !this.owned ||
          this.releasing ||
          this.stopped ||
          generation !== this.generation ||
          !latest ||
          !visibleAnnouncements(latest, this.options.clock.now()).some(
            (entry) => entry.id === id && entry.bodySha256 === item.bodySha256
          )
        )
          return null;
        return { announcement: summarize(item), ...body };
      });
    } catch {
      return null;
    }
  }
  async loadAsset(url: string): Promise<string | null> {
    if (!this.owned || this.releasing || this.stopped) return null;
    const generation = this.generation;
    try {
      const dataUrl = await this.options.source.asset(url, this.controller.signal);
      return this.owned && !this.releasing && !this.stopped && generation === this.generation
        ? dataUrl
        : null;
    } catch {
      return null;
    }
  }
  dismiss(id: string): Promise<{ saved: boolean }> {
    return this.mutation(async () => {
      if (!this.owned || this.releasing || this.stopped || this.storageFailed || !this.state)
        return { saved: false };
      if (this.state.dismissedIds.includes(id)) return { saved: true };
      try {
        this.state = await this.options.repository.update((state) =>
          dismissAnnouncement(state, id)
        );
        return { saved: true };
      } catch {
        this.storageFailed = true;
        this.fresh = false;
        this.emit();
        return { saved: false };
      }
    });
  }
  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.lifecycle(() => this.release());
    this.listeners.clear();
  }
}
