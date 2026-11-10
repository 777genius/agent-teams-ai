import {
  ANNOUNCEMENTS_MAX_ASSET_REQUESTS,
  ANNOUNCEMENTS_MAX_CONCURRENT_ASSETS,
} from '../../contracts';

interface WaitingAsset {
  isValid: () => boolean;
  resolve: (granted: boolean) => void;
}

/** Shares one bounded network budget across article assets and list covers. */
export class AnnouncementAssetScheduler {
  private active = 0;
  private readonly waiting: WaitingAsset[] = [];

  private acquire(isValid: () => boolean): Promise<boolean> {
    if (!isValid()) return Promise.resolve(false);
    if (this.active < ANNOUNCEMENTS_MAX_CONCURRENT_ASSETS) {
      this.active++;
      return Promise.resolve(true);
    }
    if (this.waiting.length >= ANNOUNCEMENTS_MAX_ASSET_REQUESTS) return Promise.resolve(false);
    return new Promise((resolve) => this.waiting.push({ isValid, resolve }));
  }

  private release(): void {
    this.active--;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      if (!waiter.isValid()) {
        waiter.resolve(false);
        continue;
      }
      this.active++;
      waiter.resolve(true);
      break;
    }
  }

  async run<T>(
    isValid: () => boolean,
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T> {
    const granted = await this.acquire(isValid);
    if (!granted) throw new Error('asset_cancelled');
    try {
      if (signal.aborted || !isValid()) throw new Error('asset_cancelled');
      return await operation();
    } finally {
      this.release();
    }
  }
}
