// @vitest-environment node
import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

interface SmokePackagedAppInternals {
  terminateChild(
    child: { exitCode: number | null; signalCode: string | null; kill: () => void },
    exitPromise: Promise<unknown>,
    platform: string
  ): Promise<void>;
  waitForProcessClose(
    child: { exitCode: number | null; signalCode: string | null },
    exitPromise: Promise<unknown>,
    timeoutMs: number
  ): Promise<boolean>;
}

interface SmokePackagedAppModule {
  default?: { _internal?: SmokePackagedAppInternals };
  _internal?: SmokePackagedAppInternals;
}

const requireFromTest: (id: string) => unknown = createRequire(import.meta.url);
const smokePackagedApp = requireFromTest(
  '../../../scripts/electron-builder/smokePackagedApp.cjs'
) as SmokePackagedAppModule;
const smokePackagedAppInternals =
  smokePackagedApp._internal ?? smokePackagedApp.default?._internal;
if (!smokePackagedAppInternals) {
  throw new Error('smokePackagedApp internals were not exported');
}
const { terminateChild, waitForProcessClose } = smokePackagedAppInternals;

describe('smokePackagedApp shutdown handling', () => {
  it('reports successful process closure before the timeout', async () => {
    let resolveExit!: (value: unknown) => void;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const child = { exitCode: null, signalCode: null };

    const closed = waitForProcessClose(child, exitPromise, 1_000);
    resolveExit({ code: 0, signal: null });

    await expect(closed).resolves.toBe(true);
  });

  it('reports shutdown timeout instead of treating it as success', async () => {
    vi.useFakeTimers();
    try {
      const exitPromise = new Promise(() => undefined);
      const child = {
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
      };

      const termination = terminateChild(child, exitPromise, 'linux');
      const rejection = expect(termination).rejects.toThrow('Timed out after 5000ms');
      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
