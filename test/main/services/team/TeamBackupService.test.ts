import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  teamsBase: '',
  backupsBase: '',
  appDataPath: '',
  tasksBase: '',
}));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBase,
  getBackupsBasePath: () => hoisted.backupsBase,
  getAppDataPath: () => hoisted.appDataPath,
  getTasksBasePath: () => hoisted.tasksBase,
}));

import { TeamBackupService } from '../../../../src/main/services/team/TeamBackupService';

describe('TeamBackupService', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-backup-service-'));
    hoisted.teamsBase = path.join(tempDir, 'teams');
    hoisted.backupsBase = path.join(tempDir, 'backups');
    hoisted.appDataPath = path.join(tempDir, 'app-data');
    hoisted.tasksBase = path.join(tempDir, 'tasks');

    await fs.mkdir(hoisted.teamsBase, { recursive: true });
    await fs.mkdir(hoisted.backupsBase, { recursive: true });
    await fs.mkdir(hoisted.appDataPath, { recursive: true });
    await fs.mkdir(hoisted.tasksBase, { recursive: true });
  });

  afterEach(async () => {
    hoisted.teamsBase = '';
    hoisted.backupsBase = '';
    hoisted.appDataPath = '';
    hoisted.tasksBase = '';
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('backs up and restores additive mixed-lane metadata and launch snapshots', async () => {
    const service = new TeamBackupService();
    const teamName = 'mixed-team';
    const teamDir = path.join(hoisted.teamsBase, teamName);
    await fs.mkdir(teamDir, { recursive: true });

    const config = {
      name: 'Mixed Team',
      projectPath: '/tmp/project',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    };
    const teamMeta = {
      version: 1,
      cwd: '/tmp/project',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      fastMode: 'off',
      createdAt: Date.now(),
    };
    const membersMeta = {
      version: 1,
      providerBackendId: 'codex-native',
      members: [
        { name: 'alice', providerId: 'codex', role: 'reviewer' },
        {
          name: 'tom',
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          model: 'minimax-m2.5-free',
          fastMode: 'inherit',
          role: 'developer',
        },
      ],
    };
    const launchState = {
      version: 2,
      teamName,
      updatedAt: '2026-04-22T12:00:00.000Z',
      launchPhase: 'active',
      expectedMembers: ['alice', 'tom'],
      bootstrapExpectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          providerId: 'codex',
          providerBackendId: 'codex-native',
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
        tom: {
          name: 'tom',
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'starting',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
        },
      },
      summary: {
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      teamLaunchState: 'partial_pending',
    };
    const launchSummary = {
      version: 1,
      teamName,
      updatedAt: '2026-04-22T12:00:00.000Z',
      mixedAware: true,
      expectedMemberCount: 2,
      confirmedMemberCount: 1,
      pendingCount: 1,
      failedCount: 0,
      teamLaunchState: 'partial_pending',
      launchUpdatedAt: '2026-04-22T12:00:00.000Z',
    };
    const runtimeLaneDir = path.join(
      teamDir,
      '.opencode-runtime',
      'lanes',
      encodeURIComponent('secondary:opencode:tom')
    );
    const runtimeLaneIndex = {
      version: 1,
      updatedAt: '2026-04-22T12:00:00.000Z',
      lanes: {
        'secondary:opencode:tom': {
          laneId: 'secondary:opencode:tom',
          state: 'active',
          updatedAt: '2026-04-22T12:00:00.000Z',
          diagnostics: [],
        },
      },
    };
    const runtimeManifest = {
      schemaVersion: 1,
      highWatermark: 12,
      activeRunId: 'lane-run-1',
      capabilitySnapshotId: 'cap-1',
    };

    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify(config), 'utf8');
    await fs.writeFile(path.join(teamDir, 'team.meta.json'), JSON.stringify(teamMeta), 'utf8');
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify(membersMeta),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'launch-state.json'),
      JSON.stringify(launchState),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'launch-summary.json'),
      JSON.stringify(launchSummary),
      'utf8'
    );
    await fs.mkdir(runtimeLaneDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, '.opencode-runtime', 'lanes.json'),
      JSON.stringify(runtimeLaneIndex),
      'utf8'
    );
    await fs.writeFile(
      path.join(runtimeLaneDir, 'runtime-store-manifest.json'),
      JSON.stringify(runtimeManifest),
      'utf8'
    );

    await service.initialize();
    await service.backupTeam(teamName);

    await fs.rm(teamDir, { recursive: true, force: true });

    const restored = await service.restoreIfNeeded();
    service.dispose();

    expect(restored).toContain(teamName);

    const restoredMembersMeta = JSON.parse(
      await fs.readFile(path.join(teamDir, 'members.meta.json'), 'utf8')
    );
    const restoredLaunchState = JSON.parse(
      await fs.readFile(path.join(teamDir, 'launch-state.json'), 'utf8')
    );
    const restoredLaunchSummary = JSON.parse(
      await fs.readFile(path.join(teamDir, 'launch-summary.json'), 'utf8')
    );
    const restoredTeamMeta = JSON.parse(
      await fs.readFile(path.join(teamDir, 'team.meta.json'), 'utf8')
    );
    const restoredRuntimeLaneIndex = JSON.parse(
      await fs.readFile(path.join(teamDir, '.opencode-runtime', 'lanes.json'), 'utf8')
    );
    const restoredRuntimeManifest = JSON.parse(
      await fs.readFile(path.join(runtimeLaneDir, 'runtime-store-manifest.json'), 'utf8')
    );

    expect(restoredTeamMeta.providerId).toBe('codex');
    expect(restoredMembersMeta.members).toEqual(membersMeta.members);
    expect(restoredLaunchState.bootstrapExpectedMembers).toEqual(['alice']);
    expect(restoredLaunchState.members.tom.laneKind).toBe('secondary');
    expect(restoredLaunchState.members.tom.laneOwnerProviderId).toBe('opencode');
    expect(restoredLaunchSummary.mixedAware).toBe(true);
    expect(restoredLaunchSummary.teamLaunchState).toBe('partial_pending');
    expect(restoredRuntimeLaneIndex.lanes['secondary:opencode:tom'].state).toBe('active');
    expect(restoredRuntimeManifest.activeRunId).toBe('lane-run-1');
  });
});
