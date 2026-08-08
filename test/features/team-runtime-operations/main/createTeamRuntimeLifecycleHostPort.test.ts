import { createTeamRuntimeLifecycleHostPort } from '@features/team-runtime-operations/main';
import { describe, expect, it } from 'vitest';

describe('createTeamRuntimeLifecycleHostPort', () => {
  it('contains the legacy retry name at the host adapter and exposes only neutral operations', async () => {
    const spawnStatuses = Promise.resolve({
      statuses: {},
      runId: 'runtime-run',
      updatedAt: '2026-07-28T00:00:00.000Z',
    });
    const restart = Promise.resolve();
    const retry = Promise.resolve({
      attempted: ['worker'],
      confirmed: ['worker'],
      pending: [],
      failed: [],
      skipped: [],
    });
    const skip = Promise.resolve();
    const receivers: unknown[] = [];
    const source = {
      getMemberSpawnStatuses(teamName: string) {
        receivers.push(this);
        expect(teamName).toBe('sandbox-team');
        return spawnStatuses;
      },
      restartMember(teamName: string, memberName: string) {
        receivers.push(this);
        expect([teamName, memberName]).toEqual(['sandbox-team', 'worker']);
        return restart;
      },
      retryFailedOpenCodeSecondaryLanes(teamName: string) {
        receivers.push(this);
        expect(teamName).toBe('sandbox-team');
        return retry;
      },
      skipMemberForLaunch(teamName: string, memberName: string) {
        receivers.push(this);
        expect([teamName, memberName]).toEqual(['sandbox-team', 'worker']);
        return skip;
      },
    };
    const lifecycle = createTeamRuntimeLifecycleHostPort(source);

    expect(lifecycle.getMemberSpawnStatuses('sandbox-team')).toBe(spawnStatuses);
    expect(lifecycle.restartMember('sandbox-team', 'worker')).toBe(restart);
    expect(lifecycle.retryFailedRuntimeLanes('sandbox-team')).toBe(retry);
    expect('retryFailedOpenCodeSecondaryLanes' in lifecycle).toBe(false);
    expect(lifecycle.skipMemberForLaunch('sandbox-team', 'worker')).toBe(skip);
    await expect(Promise.all([spawnStatuses, restart, retry, skip])).resolves.toBeDefined();
    expect(receivers).toEqual([source, source, source, source]);
  });

  it('preserves synchronous throws and rejected promise identity', async () => {
    const synchronousFailure = new Error('synchronous retry failure');
    const rejectedFailure = new Error('rejected retry failure');
    const rejectedRetry = Promise.reject(rejectedFailure);
    const baseSource = {
      getMemberSpawnStatuses: () =>
        Promise.resolve({
          statuses: {},
          runId: 'runtime-run',
          updatedAt: '2026-07-28T00:00:00.000Z',
        }),
      restartMember: () => Promise.resolve(),
      retryFailedOpenCodeSecondaryLanes: () =>
        Promise.resolve({
          attempted: [],
          confirmed: [],
          pending: [],
          failed: [],
          skipped: [],
        }),
      skipMemberForLaunch: () => Promise.resolve(),
    };
    const throwingLifecycle = createTeamRuntimeLifecycleHostPort({
      ...baseSource,
      retryFailedOpenCodeSecondaryLanes() {
        throw synchronousFailure;
      },
    });
    const rejectingLifecycle = createTeamRuntimeLifecycleHostPort({
      ...baseSource,
      retryFailedOpenCodeSecondaryLanes() {
        return rejectedRetry;
      },
    });

    expect(() => throwingLifecycle.retryFailedRuntimeLanes('sandbox-team')).toThrow(
      synchronousFailure
    );
    const retry = rejectingLifecycle.retryFailedRuntimeLanes('sandbox-team');
    expect(retry).toBe(rejectedRetry);
    await expect(retry).rejects.toBe(rejectedFailure);
  });
});
