export interface AppServerLaunchThrottleClockPort {
  now(): number;
}

export type AppServerLaunchThrottleSleep = (
  durationMs: number,
) => Promise<void>;

export interface AppServerLaunchThrottlePort {
  waitForLaunch(): Promise<void>;
}

export class InMemoryAppServerLaunchThrottle
  implements AppServerLaunchThrottlePort
{
  private readonly minIntervalMs: number;
  private readonly clock: AppServerLaunchThrottleClockPort;
  private readonly sleep: AppServerLaunchThrottleSleep;
  private nextLaunchAtMs = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly minIntervalMs: number;
    readonly clock?: AppServerLaunchThrottleClockPort;
    readonly sleep?: AppServerLaunchThrottleSleep;
  }) {
    this.minIntervalMs = normalizeAppServerLaunchMinIntervalMs(
      options.minIntervalMs,
    );
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? sleepMs;
  }

  async waitForLaunch(): Promise<void> {
    const turn = this.queue.then(() => this.waitInTurn());
    this.queue = turn.catch(() => undefined);
    await turn;
  }

  private async waitInTurn(): Promise<void> {
    if (this.minIntervalMs <= 0) return;

    const delayMs = Math.max(0, this.nextLaunchAtMs - this.clock.now());
    if (delayMs > 0) await this.sleep(delayMs);

    this.nextLaunchAtMs = this.clock.now() + this.minIntervalMs;
  }
}

export function normalizeAppServerLaunchMinIntervalMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

const systemClock: AppServerLaunchThrottleClockPort = {
  now: () => Date.now(),
};

function sleepMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
