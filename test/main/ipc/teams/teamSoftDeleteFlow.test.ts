import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { softDeleteTeamWithBestEffortStop } from '@main/ipc/teams/teamSoftDeleteFlow';

import type { TeamSoftDeleteFlowPorts } from '@main/ipc/teams/teamSoftDeleteFlow';

const STOP_TIMEOUT_MS = 5_000;

function createPorts(overrides: Partial<TeamSoftDeleteFlowPorts> = {}): TeamSoftDeleteFlowPorts {
  return {
    stopTeam: vi.fn(async () => undefined),
    softDeleteTeam: vi.fn(async () => undefined),
    invalidateTeamConfig: vi.fn(),
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
