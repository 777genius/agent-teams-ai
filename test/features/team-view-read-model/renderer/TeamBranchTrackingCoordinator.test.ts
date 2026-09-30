import {
  TeamBranchTrackingCoordinator,
  type TeamBranchTrackingRendererPorts,
} from '@features/team-view-read-model/renderer';
import { describe, expect, it, vi } from 'vitest';

function createHarness() {
  const setTracking = vi
    .fn<(projectPath: string, enabled: boolean) => Promise<void>>()
    .mockResolvedValue(undefined);
  const ports: TeamBranchTrackingRendererPorts = { setTracking };
  return {
    coordinator: new TeamBranchTrackingCoordinator(ports),
    setTracking,
  };
}

describe('TeamBranchTrackingCoordinator', () => {
  it('enables the first registration once and disables only after the final release', () => {
    const harness = createHarness();
    const first = harness.coordinator.register(['/sandbox/repo/']);
    const second = harness.coordinator.register(['/sandbox/repo']);

    expect(harness.setTracking).toHaveBeenCalledTimes(1);
    expect(harness.setTracking).toHaveBeenCalledWith('/sandbox/repo/', true);

    first.dispose();
    expect(harness.setTracking).toHaveBeenCalledTimes(1);

    second.dispose();
    expect(harness.setTracking).toHaveBeenNthCalledWith(2, '/sandbox/repo/', false);
  });

  it('releases removed paths and acquires added paths without bouncing retained paths', () => {
    const harness = createHarness();
    const registration = harness.coordinator.register(['/sandbox/first', '/sandbox/shared']);

    registration.update(['/sandbox/shared', '/sandbox/second']);

    expect(harness.setTracking.mock.calls).toEqual([
      ['/sandbox/first', true],
      ['/sandbox/shared', true],
      ['/sandbox/first', false],
      ['/sandbox/second', true],
    ]);

    registration.dispose();
    expect(harness.setTracking.mock.calls.slice(-2)).toEqual([
      ['/sandbox/shared', false],
      ['/sandbox/second', false],
    ]);
  });

  it('deduplicates each normalized path set and pins the first exact path until zero', () => {
    const harness = createHarness();
    const first = harness.coordinator.register([
      ' C:\\Workspace\\Project\\ ',
      'c:/workspace/project',
      '',
      '   ',
    ]);
    const second = harness.coordinator.register(['c:/workspace/project/']);

    expect(harness.setTracking.mock.calls).toEqual([['C:\\Workspace\\Project\\', true]]);

    first.update(['c:/workspace/project']);
    first.dispose();
    second.dispose();

    expect(harness.setTracking.mock.calls).toEqual([
      ['C:\\Workspace\\Project\\', true],
      ['C:\\Workspace\\Project\\', false],
    ]);

    const next = harness.coordinator.register(['c:/workspace/project']);
    expect(harness.setTracking).toHaveBeenLastCalledWith('c:/workspace/project', true);
    next.dispose();
  });

  it('contains rejected and synchronous request failures without corrupting reference counts', async () => {
    const setTracking = vi
      .fn<(projectPath: string, enabled: boolean) => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error('synchronous enable failure');
      })
      .mockRejectedValue(new Error('request failure'));
    const coordinator = new TeamBranchTrackingCoordinator({ setTracking });

    const first = coordinator.register(['/sandbox/failing']);
    const second = coordinator.register(['/sandbox/failing']);
    first.dispose();
    second.dispose();
    await Promise.resolve();

    expect(setTracking.mock.calls).toEqual([
      ['/sandbox/failing', true],
      ['/sandbox/failing', false],
    ]);

    const retryAfterZero = coordinator.register(['/sandbox/failing']);
    await Promise.resolve();
    expect(setTracking).toHaveBeenNthCalledWith(3, '/sandbox/failing', true);
    retryAfterZero.dispose();
    await Promise.resolve();
  });

  it('keeps empty registrations inert and disposal idempotent', () => {
    const harness = createHarness();
    const registration = harness.coordinator.register(['', '   ']);

    registration.update([]);
    registration.dispose();
    registration.dispose();
    registration.update(['/sandbox/ignored-after-dispose']);

    expect(harness.setTracking).not.toHaveBeenCalled();
  });
});
