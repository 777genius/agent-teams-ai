import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OPENCODE_PROMPT_DELIVERY_CONTINUITY_SCAN_INTERVAL_MS,
  OpenCodePromptDeliveryContinuityScan,
} from '../OpenCodePromptDeliveryContinuityScan';

import type { OpenCodePromptDeliveryContinuityScanPorts } from '../OpenCodePromptDeliveryContinuityScan';
import type { Mock } from 'vitest';

const INTERVAL_MS = 1_000;

function createHarness(
  options: {
    teamNames?: readonly string[];
    enabled?: boolean;
    scanTeam?: (teamName: string) => Promise<unknown>;
  } = {}
): {
  ports: OpenCodePromptDeliveryContinuityScanPorts;
  scanTeam: Mock<(teamName: string) => Promise<unknown>>;
  warn: Mock<(message: string) => void>;
} {
  const scanTeam = vi.fn<(teamName: string) => Promise<unknown>>(
    options.scanTeam ?? (() => Promise.resolve(undefined))
  );
  const warn = vi.fn<(message: string) => void>();
  return {
    ports: {
      isEnabled: () => options.enabled ?? true,
      listLiveTeamNames: () => options.teamNames ?? ['team-a', 'team-b'],
      scanTeam,
      warn,
    },
    scanTeam,
    warn,
  };
}

describe('OpenCodePromptDeliveryContinuityScan', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scans each live team once per interval', async () => {
    vi.useFakeTimers();
    const { ports, scanTeam } = createHarness();
    const scan = new OpenCodePromptDeliveryContinuityScan(ports, INTERVAL_MS);
    scan.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(scanTeam).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(scanTeam.mock.calls.map(([teamName]) => teamName)).toEqual(['team-a', 'team-b']);

    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS);
    expect(scanTeam.mock.calls.map(([teamName]) => teamName)).toEqual([
      'team-a',
      'team-b',
      'team-a',
      'team-b',
      'team-a',
      'team-b',
    ]);
    scan.stop();
  });

  it('skips a scan while the previous one is still running', async () => {
    vi.useFakeTimers();
    let releaseScan: (() => void) | undefined;
    const { ports, scanTeam } = createHarness({
      teamNames: ['team-a'],
      scanTeam: () =>
        new Promise<void>((resolve) => {
          releaseScan = resolve;
        }),
    });
    const scan = new OpenCodePromptDeliveryContinuityScan(ports, INTERVAL_MS);
    scan.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(scanTeam).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(scanTeam).toHaveBeenCalledTimes(1);

    releaseScan?.();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(scanTeam).toHaveBeenCalledTimes(2);
    scan.stop();
  });

  it('keeps scanning other teams while one team scan hangs, without re-entering it', async () => {
    vi.useFakeTimers();
    let releaseHungScan: (() => void) | undefined;
    const { ports, scanTeam, warn } = createHarness({
      teamNames: ['team-a', 'team-b'],
      scanTeam: (teamName) =>
        teamName === 'team-a' && !releaseHungScan
          ? new Promise<void>((resolve) => {
              releaseHungScan = resolve;
            })
          : Promise.resolve(),
    });
    const scan = new OpenCodePromptDeliveryContinuityScan(ports, INTERVAL_MS);
    scan.start();
    const callsFor = (teamName: string): number =>
      scanTeam.mock.calls.filter(([name]) => name === teamName).length;

    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(callsFor('team-a')).toBe(1);
    expect(callsFor('team-b')).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[team-a]'));

    releaseHungScan?.();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(callsFor('team-a')).toBe(2);
    expect(callsFor('team-b')).toBe(3);
    scan.stop();
  });

  it('stops scanning after stop', async () => {
    vi.useFakeTimers();
    const { ports, scanTeam } = createHarness({ teamNames: ['team-a'] });
    const scan = new OpenCodePromptDeliveryContinuityScan(ports, INTERVAL_MS);
    scan.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(scanTeam).toHaveBeenCalledTimes(1);

    scan.stop();
    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
    expect(scanTeam).toHaveBeenCalledTimes(1);
  });

  it('does not scan while the prompt delivery watchdog is disabled', async () => {
    vi.useFakeTimers();
    const { ports, scanTeam } = createHarness({ enabled: false });
    const scan = new OpenCodePromptDeliveryContinuityScan(ports, INTERVAL_MS);
    scan.start();

    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
    expect(scanTeam).not.toHaveBeenCalled();
    scan.stop();
  });

  it('warns and keeps scanning after a per-team scan failure', async () => {
    vi.useFakeTimers();
    const { ports, scanTeam, warn } = createHarness({
      teamNames: ['team-a', 'team-b'],
      scanTeam: async (teamName) => {
        if (teamName === 'team-a') {
          throw new Error('scan exploded');
        }
      },
    });
    const scan = new OpenCodePromptDeliveryContinuityScan(ports, INTERVAL_MS);
    scan.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(scanTeam.mock.calls.map(([teamName]) => teamName)).toEqual(['team-a', 'team-b']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('team-a');

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(scanTeam.mock.calls.map(([teamName]) => teamName)).toEqual([
      'team-a',
      'team-b',
      'team-a',
      'team-b',
    ]);
    scan.stop();
  });

  it('exposes a 30s continuity interval by default', () => {
    expect(OPENCODE_PROMPT_DELIVERY_CONTINUITY_SCAN_INTERVAL_MS).toBe(30_000);
    const { ports } = createHarness();
    const scan = new OpenCodePromptDeliveryContinuityScan(ports);
    scan.stop();
  });
});
