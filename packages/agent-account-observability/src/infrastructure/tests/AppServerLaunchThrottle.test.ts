import { describe, expect, it } from "vitest";
import {
  InMemoryAppServerLaunchThrottle,
  normalizeAppServerLaunchMinIntervalMs,
} from "../AppServerLaunchThrottle";
import {
  DEFAULT_CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS,
  CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS_ENV,
  SUBSCRIPTION_RUNTIME_CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS_ENV,
  resolveCodexAppServerLaunchMinIntervalMs,
} from "../JsonRpcLineClient";

describe("InMemoryAppServerLaunchThrottle", () => {
  it("starts the first app-server immediately and delays the next launch", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const throttle = new InMemoryAppServerLaunchThrottle({
      minIntervalMs: 5_000,
      clock: { now: () => now },
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
        now += durationMs;
      },
    });

    await throttle.waitForLaunch();
    now += 2_000;
    await throttle.waitForLaunch();

    expect(sleeps).toEqual([3_000]);
    expect(now).toBe(6_000);
  });

  it("serializes concurrent launch requests through the same interval", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const throttle = new InMemoryAppServerLaunchThrottle({
      minIntervalMs: 1_000,
      clock: { now: () => now },
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
        now += durationMs;
      },
    });

    await Promise.all([
      throttle.waitForLaunch(),
      throttle.waitForLaunch(),
      throttle.waitForLaunch(),
    ]);

    expect(sleeps).toEqual([1_000, 1_000]);
    expect(now).toBe(2_000);
  });

  it("can be disabled with a zero interval", async () => {
    const sleeps: number[] = [];
    const throttle = new InMemoryAppServerLaunchThrottle({
      minIntervalMs: 0,
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
      },
    });

    await throttle.waitForLaunch();
    await throttle.waitForLaunch();

    expect(sleeps).toEqual([]);
  });

  it("normalizes and resolves configured launch intervals", () => {
    expect(normalizeAppServerLaunchMinIntervalMs(1200.8)).toBe(1_200);
    expect(normalizeAppServerLaunchMinIntervalMs(Number.NaN)).toBe(0);
    expect(
      resolveCodexAppServerLaunchMinIntervalMs({
        [CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS_ENV]: "2500",
      }),
    ).toBe(2_500);
    expect(
      resolveCodexAppServerLaunchMinIntervalMs({
        [SUBSCRIPTION_RUNTIME_CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS_ENV]: "0",
      }),
    ).toBe(0);
    expect(
      resolveCodexAppServerLaunchMinIntervalMs({
        [CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS_ENV]: "invalid",
      }),
    ).toBe(DEFAULT_CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS);
  });
});
