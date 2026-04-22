import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  teamsBase: '',
}));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBase,
}));

vi.mock('../../../../src/main/services/team/TeamFsWorkerClient', () => ({
  getTeamFsWorkerClient: () => ({
    isAvailable: () => false,
  }),
}));

import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { createPersistedLaunchSummaryProjection } from '../../../../src/main/services/team/TeamLaunchSummaryProjection';

describe('TeamConfigReader', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-config-reader-'));
    hoisted.teamsBase = tempDir;
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    hoisted.teamsBase = '';
  });

  it('uses compact launch summary projection when launch-state.json is oversized', async () => {
    const teamName = 'mixed-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Mixed Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(path.join(teamDir, 'launch-state.json'), 'x'.repeat(40 * 1024), 'utf8');
    await fs.writeFile(
      path.join(teamDir, 'launch-summary.json'),
      JSON.stringify(
        createPersistedLaunchSummaryProjection({
          version: 2,
          teamName,
          updatedAt: '2026-04-22T12:00:00.000Z',
          launchPhase: 'finished',
          expectedMembers: ['alice', 'bob'],
          bootstrapExpectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
            bob: {
              name: 'bob',
              providerId: 'opencode',
              laneId: 'secondary:opencode:bob',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Side lane failed',
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 0,
            failedCount: 1,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'partial_failure',
        } as never),
        null,
        2
      ),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'bootstrap-state.json'),
      JSON.stringify({
        version: 1,
        teamName,
        runId: 'bootstrap-run-1',
        ownerPid: process.pid,
        startedAt: Date.parse('2026-04-22T12:01:00.000Z'),
        updatedAt: Date.parse('2026-04-22T12:01:00.000Z'),
        phase: 'spawning_members',
        members: [{ name: 'alice', status: 'pending' }],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Mixed Team',
      partialLaunchFailure: true,
      expectedMemberCount: 2,
      confirmedMemberCount: 1,
      missingMembers: ['bob'],
      teamLaunchState: 'partial_failure',
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
    });
  });

  it('does not invent a partial-failure summary from artifact counts for mixed-aware teams when canonical launch truth is unavailable', async () => {
    const teamName = 'mixed-aware-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(path.join(teamDir, 'inboxes'), { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Mixed Aware Team',
        leadSessionId: 'lead-session-1',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: tempDir,
        providerId: 'codex',
        createdAt: Date.now(),
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [
          { name: 'alice', providerId: 'codex', role: 'reviewer' },
          { name: 'tom', providerId: 'opencode', role: 'developer' },
        ],
      }),
      'utf8'
    );
    await fs.writeFile(path.join(teamDir, 'inboxes', 'alice.json'), '{}', 'utf8');

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Mixed Aware Team',
      memberCount: 2,
    });
    expect(teams[0]?.partialLaunchFailure).toBeUndefined();
    expect(teams[0]?.teamLaunchState).toBeUndefined();
    expect(teams[0]?.missingMembers).toBeUndefined();
  });

  it('does not let a removed base member hide an active auto-suffixed teammate in team summaries', async () => {
    const teamName = 'suffix-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Suffix Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [
          { name: 'alice', role: 'developer', removedAt: Date.now() - 60_000 },
          { name: 'alice-2', role: 'reviewer' },
        ],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Suffix Team',
      memberCount: 1,
      members: [{ name: 'alice-2', role: 'reviewer' }],
    });
  });

  it('counts only active non-lead teammates for draft team summaries', async () => {
    const teamName = 'draft-summary-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: tempDir,
        displayName: 'Draft Summary Team',
        createdAt: Date.parse('2026-04-22T12:00:00.000Z'),
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', removedAt: Date.now() - 60_000 },
          { name: 'bob', role: 'developer' },
        ],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Draft Summary Team',
      memberCount: 1,
      pendingCreate: true,
    });
  });
});
