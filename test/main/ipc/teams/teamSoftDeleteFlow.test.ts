import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamSoftDeleteRequests,
  softDeleteTeamWithBestEffortStop,
} from '@main/ipc/teams/teamSoftDeleteFlow';

import type { TeamSoftDeleteFlowPorts } from '@main/ipc/teams/teamSoftDeleteFlow';

const STOP_TIMEOUT_MS = 5_000;

function createPorts(overrides: Partial<TeamSoftDeleteFlowPorts> = {}): TeamSoftDeleteFlowPorts {
  return {
    stopTeam: vi.fn(async () => undefined),
    softDeleteTeam: vi.fn(async () => undefined),
    invalidateTeamConfig: vi.fn(),
    clearStoppedLaneStopBackoff: vi.fn(),
    logWarning: vi.fn(),
    ...overrides,
  };
}

describe('softDeleteTeamWithBestEffortStop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('soft deletes after a successful stop without warnings', async () => {
    const ports = createPorts();

    await softDeleteTeamWithBestEffortStop('fixteam', ports);

    expect(ports.stopTeam).toHaveBeenCalledWith('fixteam');
    expect(ports.softDeleteTeam).toHaveBeenCalledWith('fixteam');
    expect(ports.invalidateTeamConfig).toHaveBeenCalledWith('fixteam');
    expect(ports.logWarning).not.toHaveBeenCalled();
  });

  it('clears the background lane stop backoff only after the soft delete succeeded', async () => {
    let finishSoftDelete!: () => void;
    const ports = createPorts({
      softDeleteTeam: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSoftDelete = resolve;
          })
      ),
    });

    const flow = softDeleteTeamWithBestEffortStop('fixteam', ports);
    await vi.waitFor(() => expect(ports.softDeleteTeam).toHaveBeenCalledTimes(1));
    // Cleared any earlier, a background pass could queue on the team lock ahead
    // of the soft delete and hold it for minutes.
    expect(ports.clearStoppedLaneStopBackoff).not.toHaveBeenCalled();

    finishSoftDelete();
    await flow;
    expect(ports.clearStoppedLaneStopBackoff).toHaveBeenCalledWith('fixteam');
  });

  it('still reports a finished trash as done when clearing the backoff throws', async () => {
    const ports = createPorts({
      clearStoppedLaneStopBackoff: vi.fn(() => {
        throw new Error('runtime api not ready');
      }),
    });

    await expect(softDeleteTeamWithBestEffortStop('fixteam', ports)).resolves.toBeUndefined();
    expect(ports.invalidateTeamConfig).toHaveBeenCalledWith('fixteam');
    expect(ports.logWarning).toHaveBeenCalledWith(expect.stringContaining('runtime api not ready'));
  });

  it('soft deletes even when the stop rejects because a lane retained ownership', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(async () => {
        throw new Error('OpenCode lane primary did not confirm stop');
      }),
    });

    await softDeleteTeamWithBestEffortStop('fixteam', ports);

    expect(ports.softDeleteTeam).toHaveBeenCalledWith('fixteam');
    expect(ports.invalidateTeamConfig).toHaveBeenCalledWith('fixteam');
    expect(ports.logWarning).toHaveBeenCalledWith(expect.stringContaining('did not confirm stop'));
  });

  it('soft deletes when the stop never settles, without waiting for it', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(() => new Promise<void>(() => undefined)),
    });

    const flow = softDeleteTeamWithBestEffortStop('fixteam', ports);
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await flow;

    expect(ports.softDeleteTeam).toHaveBeenCalledWith('fixteam');
    expect(ports.invalidateTeamConfig).toHaveBeenCalledWith('fixteam');
    expect(ports.logWarning).toHaveBeenCalledWith(
      expect.stringContaining(`did not finish within ${STOP_TIMEOUT_MS}ms`)
    );
  });

  it('does not wait out the timeout when the stop settles first', async () => {
    const ports = createPorts();

    const flow = softDeleteTeamWithBestEffortStop('fixteam', ports);
    await vi.advanceTimersByTimeAsync(0);
    await flow;

    // Nothing is left armed, so the handler cannot keep the process alive for
    // five more seconds after a fast stop.
    expect(vi.getTimerCount()).toBe(0);
    expect(ports.logWarning).not.toHaveBeenCalled();
  });

  it('propagates a soft delete failure and leaves the config cache alone', async () => {
    const ports = createPorts({
      softDeleteTeam: vi.fn(async () => {
        throw new Error('Team not found: fixteam');
      }),
    });

    await expect(softDeleteTeamWithBestEffortStop('fixteam', ports)).rejects.toThrow(
      'Team not found: fixteam'
    );
    expect(ports.invalidateTeamConfig).not.toHaveBeenCalled();
    expect(ports.clearStoppedLaneStopBackoff).not.toHaveBeenCalled();
  });

  it('claims a stop rejection that arrives after the timeout', async () => {
    let rejectStop: ((error: Error) => void) | undefined;
    const ports = createPorts({
      stopTeam: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStop = reject;
          })
      ),
    });

    const flow = softDeleteTeamWithBestEffortStop('fixteam', ports);
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await flow;
    expect(ports.softDeleteTeam).toHaveBeenCalledWith('fixteam');

    // The abandoned stop still rejects later. It must land in the handler this
    // flow attached up front, not in an unhandled rejection.
    rejectStop?.(new Error('late stop failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ports.logWarning).toHaveBeenCalledWith(expect.stringContaining('late stop failure'));
  });
});

describe('createTeamSoftDeleteRequests', () => {
  function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('joins a repeated request for the same team instead of stopping and deleting again', async () => {
    const softDelete = deferred();
    const ports = createPorts({ softDeleteTeam: vi.fn(() => softDelete.promise) });
    const requests = createTeamSoftDeleteRequests();

    const first = requests.softDelete('fixteam', ports);
    const repeated = requests.softDelete('fixteam', ports);
    const other = requests.softDelete('other-team', ports);
    await vi.waitFor(() => expect(ports.softDeleteTeam).toHaveBeenCalledTimes(2));

    expect(repeated).toBe(first);
    expect(ports.stopTeam).toHaveBeenCalledTimes(2);
    expect(ports.stopTeam).toHaveBeenCalledWith('fixteam');
    expect(ports.stopTeam).toHaveBeenCalledWith('other-team');

    softDelete.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(other).resolves.toBeUndefined();

    // Settled requests are forgotten, so the next one runs on its own.
    await requests.softDelete('fixteam', ports);
    expect(ports.stopTeam).toHaveBeenCalledTimes(3);
    expect(ports.softDeleteTeam).toHaveBeenCalledTimes(3);
  });

  it('gives the joined caller the failure too and lets a retry run after it', async () => {
    const softDelete = deferred();
    const ports = createPorts({ softDeleteTeam: vi.fn(() => softDelete.promise) });
    const requests = createTeamSoftDeleteRequests();

    const first = requests.softDelete('fixteam', ports);
    const repeated = requests.softDelete('fixteam', ports);
    await vi.waitFor(() => expect(ports.softDeleteTeam).toHaveBeenCalledTimes(1));
    softDelete.reject(new Error('quiesce timed out'));

    await expect(first).rejects.toThrow('quiesce timed out');
    await expect(repeated).rejects.toThrow('quiesce timed out');

    vi.mocked(ports.softDeleteTeam).mockResolvedValueOnce(undefined);
    await expect(requests.softDelete('fixteam', ports)).resolves.toBeUndefined();
    expect(ports.stopTeam).toHaveBeenCalledTimes(2);
    expect(ports.softDeleteTeam).toHaveBeenCalledTimes(2);
  });
});
