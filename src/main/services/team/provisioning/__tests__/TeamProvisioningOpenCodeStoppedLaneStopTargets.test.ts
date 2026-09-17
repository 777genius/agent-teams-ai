/* eslint-disable sonarjs/publicly-writable-directories -- Test fixtures intentionally use temp paths. */

import { describe, expect, it, vi } from 'vitest';

import {
  collectOpenCodeStoppedLaneStopRunIds,
  isStoppedTeamOpenCodeLaneOwnershipCurrent,
  selectStoppedTeamOpenCodeRuntimeLaneIds,
  shouldSkipStoppedTeamOpenCodeLaneCleanup,
  stopLeftoverOpenCodeSecondaryLaneRuns,
} from '../TeamProvisioningOpenCodeStoppedLaneStopTargets';

describe('TeamProvisioningOpenCodeStoppedLaneStopTargets', () => {
  it('skips leftover cleanup only while a live launch can still deliver', () => {
    expect(
      shouldSkipStoppedTeamOpenCodeLaneCleanup({
        canDeliverToTeamRuntime: true,
        freshness: { version: 1, teamName: 'team', kind: 'launch', runId: 'run-new' },
      })
    ).toBe(true);
    expect(
      shouldSkipStoppedTeamOpenCodeLaneCleanup({
        canDeliverToTeamRuntime: true,
        freshness: { version: 1, teamName: 'team', kind: 'stop', stopId: 'stop-1' },
      })
    ).toBe(false);
    expect(
      shouldSkipStoppedTeamOpenCodeLaneCleanup({
        canDeliverToTeamRuntime: false,
        freshness: { version: 1, teamName: 'team', kind: 'launch', runId: 'run-new' },
      })
    ).toBe(false);
  });

  it('selects active and degraded lanes but not stopped ones', () => {
    expect(
      selectStoppedTeamOpenCodeRuntimeLaneIds({
        lanes: {
          'secondary:opencode:oscar': {
            laneId: 'secondary:opencode:oscar',
            state: 'degraded',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          primary: { laneId: 'primary', state: 'stopped', updatedAt: '2026-01-01T00:00:00.000Z' },
          'secondary:opencode:alice': {
            laneId: 'secondary:opencode:alice',
            state: 'active',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      })
    ).toEqual(['secondary:opencode:alice', 'secondary:opencode:oscar']);
  });

  it('collects leftover run ids from launch state and same-team attribution leases', () => {
    expect(
      collectOpenCodeStoppedLaneStopRunIds({
        teamName: 'mixed-std-20260917',
        laneId: 'secondary:opencode:oscar',
        manifestRunId: 'manifest-run',
        launchStateRunId: 'launch-run',
        attributed: [
          {
            record: {} as never,
            host: null,
            owners: [
              {
                teamId: 'mixed-std-20260917',
                teamName: 'mixed-std-20260917',
                laneId: 'secondary:opencode:oscar',
                memberName: 'oscar',
                runId: 'lease-run',
                sessionId: 'ses_1',
                createdAt: null,
                updatedAt: null,
              },
              {
                teamId: 'other-team',
                teamName: 'other-team',
                laneId: 'secondary:opencode:oscar',
                memberName: 'oscar',
                runId: 'foreign-run',
                sessionId: 'ses_2',
                createdAt: null,
                updatedAt: null,
              },
            ],
          },
        ],
      })
    ).toEqual(['manifest-run', 'launch-run', 'lease-run']);
  });

  it('keeps stopped-team ownership when a leftover lease run is the live target', () => {
    expect(
      isStoppedTeamOpenCodeLaneOwnershipCurrent({
        canDeliverToTeamRuntime: true,
        freshness: { version: 1, teamName: 'team', kind: 'stop', stopId: 'stop-1' },
        expectedRunId: 'manifest-run',
        currentRunId: 'lease-run',
        targetedRunIds: ['manifest-run', 'lease-run'],
      })
    ).toBe(true);
    expect(
      isStoppedTeamOpenCodeLaneOwnershipCurrent({
        canDeliverToTeamRuntime: true,
        freshness: { version: 1, teamName: 'team', kind: 'launch', runId: 'run-new' },
        expectedRunId: 'manifest-run',
        currentRunId: 'manifest-run',
      })
    ).toBe(false);
  });

  it('force-stops leftover same-lane runs before a successor launch', async () => {
    const stop = vi.fn(async () => ({
      runId: 'lease-run',
      teamName: 'team-a',
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));

    await stopLeftoverOpenCodeSecondaryLaneRuns({
      adapter: { stop },
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      nextRunId: 'run-new',
      cwd: '/tmp/project',
      previousLaunchState: {
        members: {
          Bob: {
            name: 'Bob',
            providerId: 'opencode',
            laneId: 'secondary:opencode:bob',
            runtimeRunId: 'run-old',
          },
        },
      } as never,
      attributed: [],
    });

    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-old',
        laneId: 'secondary:opencode:bob',
        force: true,
        reason: 'cleanup',
      })
    );
  });
});

/* eslint-enable sonarjs/publicly-writable-directories -- Re-enable after temp-path fixtures. */
