import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createTeamScopedResourceReleaser } from '../../../../src/main/ipc/teams/teamScopedResourceReleaser';

import type { TeamScopedResourceReleaserPorts } from '../../../../src/main/ipc/teams/teamScopedResourceReleaser';

const SETTLE_MS = 150;

function createPorts(
  overrides: Partial<TeamScopedResourceReleaserPorts> = {}
): TeamScopedResourceReleaserPorts {
  return {
    suspendTeamWatchers: vi.fn(async () => ['teams-dir-watch']),
    resumeTeamWatchers: vi.fn(async () => undefined),
    releaseTeamLogSourceWatcher: vi.fn(async () => false),
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
      releaseTeamLogSourceWatcher: vi.fn(async () => false),
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
      releaseTeamLogSourceWatcher: vi.fn(async () => true),
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
});
