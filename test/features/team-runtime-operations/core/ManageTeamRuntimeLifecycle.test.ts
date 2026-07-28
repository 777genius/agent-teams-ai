import { ManageTeamRuntimeLifecycle } from '@features/team-runtime-operations/core/application/use-cases/ManageTeamRuntimeLifecycle';
import { describe, expect, it, vi } from 'vitest';

import type {
  TeamRuntimeEffectsPort,
  TeamRuntimeFeedPort,
  TeamRuntimeLifecycleCommandPort,
  TeamRuntimeStopPort,
} from '@features/team-runtime-operations/core/application/ports/TeamRuntimeOperationPorts';

function dependencies() {
  const lifecycle: TeamRuntimeLifecycleCommandPort = {
    restartMember: vi.fn(() => Promise.resolve()),
    retryFailedRuntimeLanes: vi.fn(() =>
      Promise.resolve({
        attempted: ['worker'],
        confirmed: ['worker'],
        pending: [],
        failed: [],
        skipped: [],
      })
    ),
    skipMemberForLaunch: vi.fn(() => Promise.resolve()),
  };
  const runtime: TeamRuntimeStopPort = {
    stopTeam: vi.fn(() => Promise.resolve()),
  };
  const feed: TeamRuntimeFeedPort = {
    invalidateMessageFeed: vi.fn(),
  };
  const effects: TeamRuntimeEffectsPort = {
    addStopBreadcrumb: vi.fn(),
  };
  return { lifecycle, runtime, feed, effects };
}

describe('ManageTeamRuntimeLifecycle', () => {
  it('invalidates the message feed after restart success or failure', async () => {
    const ports = dependencies();
    const failure = new Error('restart failed');
    vi.mocked(ports.lifecycle.restartMember).mockResolvedValueOnce().mockRejectedValueOnce(failure);
    const useCase = new ManageTeamRuntimeLifecycle(
      ports.lifecycle,
      ports.runtime,
      ports.feed,
      ports.effects
    );

    await expect(useCase.restartMember('team', 'worker')).resolves.toBeUndefined();
    await expect(useCase.restartMember('team', 'worker')).rejects.toBe(failure);
    expect(ports.feed.invalidateMessageFeed).toHaveBeenCalledTimes(2);
  });

  it('forwards the provider-neutral lane retry result by identity', async () => {
    const ports = dependencies();
    const useCase = new ManageTeamRuntimeLifecycle(
      ports.lifecycle,
      ports.runtime,
      ports.feed,
      ports.effects
    );
    const expected = await ports.lifecycle.retryFailedRuntimeLanes('preview');
    vi.mocked(ports.lifecycle.retryFailedRuntimeLanes).mockResolvedValueOnce(expected);

    await expect(useCase.retryFailedRuntimeLanes('team')).resolves.toBe(expected);
    expect(ports.lifecycle.retryFailedRuntimeLanes).toHaveBeenLastCalledWith('team');
  });

  it('records the stop breadcrumb before delegating to the existing process owner', async () => {
    const order: string[] = [];
    const ports = dependencies();
    vi.mocked(ports.effects.addStopBreadcrumb).mockImplementation(() => order.push('breadcrumb'));
    vi.mocked(ports.runtime.stopTeam).mockImplementation(async () => {
      order.push('stop');
    });
    const useCase = new ManageTeamRuntimeLifecycle(
      ports.lifecycle,
      ports.runtime,
      ports.feed,
      ports.effects
    );

    await useCase.stopTeam('team');

    expect(order).toEqual(['breadcrumb', 'stop']);
  });
});
