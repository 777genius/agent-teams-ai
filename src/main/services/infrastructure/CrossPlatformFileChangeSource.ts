import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Service:CrossPlatformFileChangeSource');

export type PollingChangeEventType = 'rename' | 'change';

export interface CloseableWatcher {
  close: () => void | Promise<void>;
}

export interface WatcherLifecycle {
  onError: (error: unknown) => void;
  onClose: () => void;
  isCurrent: () => boolean;
}

export interface CrossPlatformFileChangeSourceOptions {
  name: string;
  pollIntervalMs: number;
  createWatcher?: (lifecycle: WatcherLifecycle) => Promise<CloseableWatcher> | CloseableWatcher;
  collectPollSnapshot: () => Promise<Map<string, string>>;
  emitPolledChange: (eventType: PollingChangeEventType, relativePath: string) => void;
  isOwnerActive: () => boolean;
  isWatchLimitError: (error: unknown) => boolean;
  requestRetry: () => void;
  onWatcherStartError?: (error: unknown) => void;
  onWatcherError?: (error: unknown) => void;
  onPollingError?: (error: unknown) => void;
}

export class CrossPlatformFileChangeSource {
  private watcher: CloseableWatcher | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private pollingGenerationInProgress: number | null = null;
  private pollingPrimed = false;
  private pollSnapshot = new Map<string, string>();
  private closedGeneration: number | null = null;
  private rejectedGeneration: number | null = null;
  private generation = 0;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly options: CrossPlatformFileChangeSourceOptions) {}

  get isActive(): boolean {
    return this.watcher !== null || this.pollingTimer !== null;
  }

  get currentPollingTimer(): NodeJS.Timeout | null {
    return this.pollingTimer;
  }

  get isPollingPrimed(): boolean {
    return this.pollingPrimed;
  }

  async start(): Promise<void> {
    if (this.isActive) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    const createWatcher = this.options.createWatcher;
    if (!createWatcher) {
      this.startPolling();
      return;
    }

    const generation = this.nextGeneration();
    this.closedGeneration = null;
    this.rejectedGeneration = null;
    const startPromise = this.startWatcher(generation, createWatcher);
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    }
  }

  private async startWatcher(
    generation: number,
    createWatcher: NonNullable<CrossPlatformFileChangeSourceOptions['createWatcher']>
  ): Promise<void> {
    try {
      const watcher = await createWatcher({
        onError: (error) => this.handleWatcherError(error, generation),
        onClose: () => this.handleWatcherClose(generation),
        isCurrent: () => this.isCurrentGeneration(generation),
      });

      if (!this.isCurrentGeneration(generation)) {
        await this.closeWatcher(watcher);
        return;
      }

      this.watcher = watcher;
    } catch (error) {
      if (generation !== this.generation || !this.options.isOwnerActive()) {
        return;
      }
      if (this.pollingTimer || this.rejectedGeneration === generation) {
        return;
      }
      if (this.startPollingFallback(error, generation)) {
        return;
      }
      if (this.closedGeneration === generation) {
        return;
      }
      this.rejectedGeneration = generation;
      this.options.onWatcherStartError?.(error);
      this.options.requestRetry();
    }
  }

  startPolling(): void {
    if (this.pollingTimer || !this.options.isOwnerActive()) {
      return;
    }

    const generation = this.nextGeneration();
    this.startPollingForGeneration(generation);
  }

  private startPollingForGeneration(generation: number): void {
    if (this.pollingTimer || generation !== this.generation || !this.options.isOwnerActive()) {
      return;
    }

    const watcher = this.watcher;
    this.watcher = null;

    const runPoll = (): void => {
      void this.pollOnce(generation);
    };

    this.pollingTimer = setInterval(runPoll, this.options.pollIntervalMs);
    this.pollingTimer.unref();
    runPoll();

    if (watcher) {
      void this.closeWatcher(watcher);
    }
  }

  async pollOnce(expectedGeneration = this.generation): Promise<void> {
    if (
      expectedGeneration !== this.generation ||
      !this.options.isOwnerActive() ||
      this.pollingGenerationInProgress !== null
    ) {
      return;
    }

    this.pollingGenerationInProgress = expectedGeneration;
    try {
      await this.pollForChanges(expectedGeneration);
    } catch (error) {
      if (expectedGeneration === this.generation && this.options.isOwnerActive()) {
        this.options.onPollingError?.(error);
      }
    } finally {
      if (this.pollingGenerationInProgress === expectedGeneration) {
        this.pollingGenerationInProgress = null;
      }
    }
  }

  stop(): void {
    this.generation += 1;
    this.startPromise = null;
    this.closedGeneration = null;
    this.rejectedGeneration = null;
    this.pollingGenerationInProgress = null;
    this.pollingPrimed = false;
    this.pollSnapshot.clear();

    const timer = this.pollingTimer;
    this.pollingTimer = null;
    if (timer) {
      clearInterval(timer);
    }

    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) {
      void this.closeWatcher(watcher);
    }
  }

  private handleWatcherError(error: unknown, generation: number): void {
    if (
      generation !== this.generation ||
      !this.options.isOwnerActive() ||
      this.rejectedGeneration === generation
    ) {
      return;
    }

    if (this.startPollingFallback(error, generation)) {
      return;
    }

    if (this.closedGeneration === generation) {
      return;
    }

    this.rejectedGeneration = generation;
    this.options.onWatcherError?.(error);
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) {
      void this.closeWatcher(watcher);
    }
    if (!this.isActive) {
      this.options.requestRetry();
    }
  }

  private handleWatcherClose(generation: number): void {
    if (
      generation !== this.generation ||
      !this.options.isOwnerActive() ||
      this.closedGeneration === generation ||
      this.rejectedGeneration === generation
    ) {
      return;
    }

    this.closedGeneration = generation;
    this.watcher = null;
    if (!this.isActive) {
      this.options.requestRetry();
    }
  }

  private startPollingFallback(error: unknown, generation: number): boolean {
    if (
      generation !== this.generation ||
      !this.options.isOwnerActive() ||
      !this.options.isWatchLimitError(error)
    ) {
      return false;
    }

    this.rejectedGeneration = generation;
    const err = error as NodeJS.ErrnoException;
    logger.warn(
      `${this.options.name} watcher hit ${err.code ?? 'a platform limit'}; falling back to polling`
    );

    const watcher = this.watcher;
    this.watcher = null;
    this.startPollingForGeneration(generation);
    if (watcher) {
      void this.closeWatcher(watcher);
    }
    return true;
  }

  private async pollForChanges(expectedGeneration: number): Promise<void> {
    const nextSnapshot = await this.options.collectPollSnapshot();
    if (expectedGeneration !== this.generation || !this.options.isOwnerActive()) {
      return;
    }

    if (!this.pollingPrimed) {
      logger.info(`${this.options.name} polling baseline captured`);
      this.pollSnapshot = nextSnapshot;
      this.pollingPrimed = true;
      return;
    }

    for (const [relativePath, fingerprint] of nextSnapshot) {
      const previous = this.pollSnapshot.get(relativePath);
      if (previous === undefined) {
        this.options.emitPolledChange('rename', relativePath);
      } else if (previous !== fingerprint) {
        this.options.emitPolledChange('change', relativePath);
      }
    }

    for (const relativePath of this.pollSnapshot.keys()) {
      if (!nextSnapshot.has(relativePath)) {
        this.options.emitPolledChange('rename', relativePath);
      }
    }

    this.pollSnapshot = nextSnapshot;
  }

  private async closeWatcher(watcher: CloseableWatcher): Promise<void> {
    try {
      await watcher.close();
    } catch (error) {
      logger.debug(`${this.options.name} watcher close failed`, error);
    }
  }

  private nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private isCurrentGeneration(generation: number): boolean {
    return (
      generation === this.generation &&
      this.options.isOwnerActive() &&
      !this.pollingTimer &&
      this.closedGeneration !== generation &&
      this.rejectedGeneration !== generation
    );
  }
}
