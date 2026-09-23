import { describe, expect, it } from 'vitest';

import {
  applyStoppedTeamRuntimeResources,
  projectStoppedTeamRuntimeResources,
  shouldStripStoppedTeamRuntimeResources,
} from '../TeamProvisioningStoppedTeamRuntimeProjection';

import type { TeamAgentRuntimeSnapshot } from '@shared/types';

function snapshotWithResources(): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'mixed-v2150-20260917',
    updatedAt: '2026-09-17T06:34:00.000Z',
    runId: null,
    members: {
      alice: {
        memberName: 'alice',
        alive: false,
        restartable: false,
        rssBytes: 270 * 1024 * 1024,
        cpuPercent: 1.2,
        resourceHistory: [{ timestamp: '2026-09-17T06:34:00.000Z', rssBytes: 270 * 1024 * 1024 }],
        updatedAt: '2026-09-17T06:34:00.000Z',
      },
    },
  };
}

describe('TeamProvisioningStoppedTeamRuntimeProjection', () => {
  it('strips leftover resource metrics only after a durable stop while idle and untracked', () => {
    expect(
      shouldStripStoppedTeamRuntimeResources({
        isTeamAlive: false,
        hasProvisioningRun: false,
        freshnessKind: 'stop',
      })
    ).toBe(true);
    expect(
      shouldStripStoppedTeamRuntimeResources({
        isTeamAlive: false,
        hasProvisioningRun: false,
        freshnessKind: 'launch',
      })
    ).toBe(false);
    expect(
      shouldStripStoppedTeamRuntimeResources({
        isTeamAlive: false,
        hasProvisioningRun: false,
        freshnessKind: null,
      })
    ).toBe(false);
    expect(
      shouldStripStoppedTeamRuntimeResources({ isTeamAlive: true, hasProvisioningRun: false })
    ).toBe(false);
    expect(
      shouldStripStoppedTeamRuntimeResources({ isTeamAlive: false, hasProvisioningRun: true })
    ).toBe(false);
  });

  it('omits stale RSS after stop without rewriting idle members that already have none', () => {
    const idle: TeamAgentRuntimeSnapshot = {
      teamName: 'mixed-v2150-20260917',
      updatedAt: '2026-09-17T06:34:00.000Z',
      runId: null,
      members: {
        oscar: {
          memberName: 'oscar',
          alive: false,
          restartable: false,
          updatedAt: '2026-09-17T06:34:00.000Z',
        },
      },
    };

    expect(projectStoppedTeamRuntimeResources(idle)).toBe(idle);

    const projected = projectStoppedTeamRuntimeResources(snapshotWithResources());
    expect(projected.members.alice.rssBytes).toBeUndefined();
    expect(projected.members.alice.cpuPercent).toBeUndefined();
    expect(projected.members.alice.resourceHistory).toBeUndefined();
    expect(projected.members.alice.alive).toBe(false);
  });

  it('forces leftover OpenCode host liveness offline after an explicit stop', () => {
    const snapshot: TeamAgentRuntimeSnapshot = {
      teamName: 'mixed-v2150-20260917',
      updatedAt: '2026-09-17T07:44:00.000Z',
      runId: null,
      members: {
        oscar: {
          memberName: 'oscar',
          alive: true,
          restartable: false,
          runtimeModel: 'opencode/big-pickle',
          updatedAt: '2026-09-17T07:44:00.000Z',
        },
      },
    };

    const projected = applyStoppedTeamRuntimeResources({
      snapshot,
      isTeamAlive: false,
      hasProvisioningRun: false,
      freshnessKind: 'stop',
    });
    expect(projected.members.oscar.alive).toBe(false);
    expect(projected.members.oscar.rssBytes).toBeUndefined();
    expect(projected).not.toBe(snapshot);
  });

  it('keeps live resource metrics while a launch run is still tracked', () => {
    const live = snapshotWithResources();
    expect(
      applyStoppedTeamRuntimeResources({
        snapshot: live,
        isTeamAlive: true,
        hasProvisioningRun: false,
        freshnessKind: 'stop',
      })
    ).toBe(live);
    expect(
      applyStoppedTeamRuntimeResources({
        snapshot: live,
        isTeamAlive: false,
        hasProvisioningRun: true,
        freshnessKind: 'stop',
      })
    ).toBe(live);
  });

  it('keeps leftover metrics after a main restart when freshness is still launch', () => {
    const live = snapshotWithResources();
    expect(
      applyStoppedTeamRuntimeResources({
        snapshot: live,
        isTeamAlive: false,
        hasProvisioningRun: false,
        freshnessKind: 'launch',
      })
    ).toBe(live);
  });
});
