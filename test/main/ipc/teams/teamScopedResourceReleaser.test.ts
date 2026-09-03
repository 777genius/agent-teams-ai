import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createTeamScopedResourceReleaser } from '@main/ipc/teams/teamScopedResourceReleaser';

import type { TeamScopedResourceReleaserPorts } from '@main/ipc/teams/teamScopedResourceReleaser';
import type { TeamLogSourceReleasedConsumers } from '@main/services/team/TeamLogSourceTracker';

const SETTLE_MS = 150;

const RELEASED_CONSUMERS: TeamLogSourceReleasedConsumers = {
  releasedWatcher: true,
  consumers: [
    { consumer: 'stall_monitor', count: 1 },
    { consumer: 'task_log_stream', count: 1 },
  ],
};

function createPorts(
  overrides: Partial<TeamScopedResourceReleaserPorts> = {}
): TeamScopedResourceReleaserPorts {
  return {
    suspendTeamWatchers: vi.fn(async () => ['teams-dir-watch']),
    resumeTeamWatchers: vi.fn(async () => undefined),
    releaseTeamLogSourceWatcher: vi.fn(async () => null),
    restoreTeamLogSourceConsumers: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe('createTeamScopedResourceReleaser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the handles to settle only when something was released', async () => {
    const ports = createPorts();
    const releaser = createTeamScopedResourceReleaser(ports);

    const release = releaser.release('fixteam');
    expect(await settled(release)).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await release;

    expect(ports.suspendTeamWatchers).toHaveBeenCalledWith('fixteam');
    expect(ports.releaseTeamLogSourceWatcher).toHaveBeenCalledWith('fixteam');
  });

  it('does not wait at all when nothing was holding the team', async () => {
    const ports = createPorts({
      suspendTeamWatchers: vi.fn(async () => []),
      releaseTeamLogSourceWatcher: vi.fn(async () => null),
    });
    const releaser = createTeamScopedResourceReleaser(ports);

    const release = releaser.release('fixteam');
    expect(await settled(release)).toBe(true);
    await release;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still releases the log-source watcher when suspending the dir watchers throws', async () => {
    const ports = createPorts({
      suspendTeamWatchers: vi.fn(async () => {
        throw new Error('registry is closed');
      }),
      releaseTeamLogSourceWatcher: vi.fn(async () => RELEASED_CONSUMERS),
    });
    const releaser = createTeamScopedResourceReleaser(ports);

    const release = releaser.release('fixteam');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await expect(release).resolves.toBeUndefined();

    // The log-source watcher was released, so the settle still applies.
    expect(ports.releaseTeamLogSourceWatcher).toHaveBeenCalledWith('fixteam');
  });

  it('does not fail the deletion when the log-source release throws', async () => {
    const ports = createPorts({
      releaseTeamLogSourceWatcher: vi.fn(async () => {
        throw new Error('tracker exploded');
      }),
    });
    const releaser = createTeamScopedResourceReleaser(ports);

    const release = releaser.release('fixteam');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await expect(release).resolves.toBeUndefined();
  });

  it('restores the watchers and swallows a failing resume', async () => {
    const resumeTeamWatchers = vi.fn(async () => {
      throw new Error('registry is closed');
    });
    const releaser = createTeamScopedResourceReleaser(createPorts({ resumeTeamWatchers }));

    await expect(releaser.restore('fixteam')).resolves.toBeUndefined();
    expect(resumeTeamWatchers).toHaveBeenCalledWith('fixteam');
  });

  it('re-acquires the log-source consumers when the deletion did not complete', async () => {
    const ports = createPorts({
      releaseTeamLogSourceWatcher: vi.fn(async () => RELEASED_CONSUMERS),
    });
    const releaser = createTeamScopedResourceReleaser(ports);

    const release = releaser.release('fixteam');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await release;
    await releaser.restore('fixteam', { deletionCompleted: false });

    // The team is still there. The stall monitor and the task-log stream keep
    // their own "this team is mine" state and never re-acquire on their own, so
    // without this they own a team whose log-source events have stopped.
    expect(ports.restoreTeamLogSourceConsumers).toHaveBeenCalledWith('fixteam', RELEASED_CONSUMERS);
  });

  it('leaves the log-source consumers released once the deletion completed', async () => {
    const ports = createPorts({
      releaseTeamLogSourceWatcher: vi.fn(async () => RELEASED_CONSUMERS),
    });
    const releaser = createTeamScopedResourceReleaser(ports);

    const release = releaser.release('fixteam');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await release;
    await releaser.restore('fixteam', { deletionCompleted: true });

    expect(ports.resumeTeamWatchers).toHaveBeenCalledWith('fixteam');
    expect(ports.restoreTeamLogSourceConsumers).not.toHaveBeenCalled();
  });

  it('does not re-acquire twice for one release', async () => {
    const ports = createPorts({
      releaseTeamLogSourceWatcher: vi.fn(async () => RELEASED_CONSUMERS),
    });
    const releaser = createTeamScopedResourceReleaser(ports);

    const release = releaser.release('fixteam');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await release;
    await releaser.restore('fixteam', { deletionCompleted: false });
    await releaser.restore('fixteam', { deletionCompleted: false });

    expect(ports.restoreTeamLogSourceConsumers).toHaveBeenCalledTimes(1);
  });

  it('does not re-acquire consumers that were never released', async () => {
    const ports = createPorts({ suspendTeamWatchers: vi.fn(async () => []) });
    const releaser = createTeamScopedResourceReleaser(ports);

    await releaser.release('fixteam');
    await releaser.restore('fixteam', { deletionCompleted: false });

    expect(ports.restoreTeamLogSourceConsumers).not.toHaveBeenCalled();
  });
});
