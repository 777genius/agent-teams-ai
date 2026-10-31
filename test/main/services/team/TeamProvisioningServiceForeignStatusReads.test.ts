import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/tmux-installer/main', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  killTmuxPaneForCurrentPlatformSync: vi.fn(),
}));

import { buildOpenCodeAppProfileScope } from '../../../../src/main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { claimTeamForThisProfile } from '../../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { createPersistedLaunchSnapshot } from '../../../../src/main/services/team/TeamLaunchStateEvaluator';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'TEST-foreign-status-reads-'));
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'user-data-a'));
});

afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await rm(root, { recursive: true, force: true });
});

const WORK_STARTED_AT = '2026-10-30T10:00:00.000Z';
const LAST_SEEN_AT = '2026-10-30T10:30:00.000Z';

/**
 * A team whose app went away mid-work: launch-state.json still reports bob
 * alive, and his task still has an open work interval. Nothing runs here.
 */
async function writeCrashedTeam(teamName: string, ownerUserData?: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify({
      name: teamName,
      projectPath: root,
      leadSessionId: 'lead-session',
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'bob', role: 'developer' },
      ],
    })}\n`
  );
  await writeFile(
    path.join(teamDir, 'launch-state.json'),
    JSON.stringify(
      createPersistedLaunchSnapshot({
        teamName,
        leadSessionId: 'lead-session',
        launchPhase: 'finished',
        expectedMembers: ['bob'],
        members: {
          bob: {
            name: 'bob',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            runtimeLastSeenAt: LAST_SEEN_AT,
            lastEvaluatedAt: LAST_SEEN_AT,
          },
        },
        updatedAt: LAST_SEEN_AT,
      }),
      null,
      2
    )
  );
  const taskDir = path.join(getTasksBasePath(), teamName);
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, 'task-1.json'),
    JSON.stringify(
      {
        id: 'task-1',
        subject: 'Build the thing',
        owner: 'bob',
        status: 'in_progress',
        workIntervals: [{ startedAt: WORK_STARTED_AT }],
        historyEvents: [],
      },
      null,
      2
    )
  );
  if (ownerUserData) {
    await claimTeamForThisProfile({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      reason: 'launch',
      profileScope: buildOpenCodeAppProfileScope(ownerUserData, path.join(root, 'claude')),
    });
  }
}

/** Every file under the team's directory and its task directory, byte for byte. */
async function snapshotTeamFiles(teamName: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, label: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, `${label}/${entry.name}`);
      } else {
        files[`${label}/${entry.name}`] = (await readFile(entryPath)).toString('base64');
      }
    }
  };
  await walk(path.join(getTeamsBasePath(), teamName), 'teams');
  await walk(path.join(getTasksBasePath(), teamName), 'tasks');
  return files;
}

async function readTask(teamName: string): Promise<{ workIntervals: Record<string, string>[] }> {
  return JSON.parse(
    await readFile(path.join(getTasksBasePath(), teamName, 'task-1.json'), 'utf8')
  ) as { workIntervals: Record<string, string>[] };
}

describe('TeamProvisioningService status reads of teams this profile does not manage', () => {
  it('reports statuses of another profile and of a native session without touching their files', async () => {
    await writeCrashedTeam('other-profile', path.join(root, 'user-data-b'));
    await writeCrashedTeam('session-native');
    const before = {
      'other-profile': await snapshotTeamFiles('other-profile'),
      'session-native': await snapshotTeamFiles('session-native'),
    };
    const service = new TeamProvisioningService();

    for (const teamName of ['other-profile', 'session-native'] as const) {
      const statuses = await service.getMemberSpawnStatuses(teamName);
      expect(statuses.expectedMembers).toEqual(['bob']);
      // Reported as the owner persisted it, with the live check's warning attached;
      // only the team's owner may reconcile it, and it may well be running there.
      expect(statuses.statuses.bob).toMatchObject({
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        runtimeDiagnostic: 'runtime process not found',
      });
      // The background work-sync pass reads through the runtime snapshot.
      const snapshot = await service.getTeamAgentRuntimeSnapshot(teamName);
      expect(snapshot.teamName).toBe(teamName);
      // A second read must not repair anything the first one skipped either.
      await service.getMemberSpawnStatuses(teamName);

      expect(await snapshotTeamFiles(teamName)).toEqual(before[teamName]);
      expect((await readTask(teamName)).workIntervals).toEqual([{ startedAt: WORK_STARTED_AT }]);
    }
  });

  it('still repairs and reconciles a crashed team of this profile', async () => {
    await writeCrashedTeam('own-crashed', path.join(root, 'user-data-a'));
    expect(await snapshotTeamFiles('own-crashed')).toHaveProperty(['teams/launch-state.json']);
    const service = new TeamProvisioningService();

    await service.getMemberSpawnStatuses('own-crashed');

    // The persisted-launch reconcile clears the stale snapshot and the crash
    // repair closes the work interval nobody is running any more.
    expect(await snapshotTeamFiles('own-crashed')).not.toHaveProperty(['teams/launch-state.json']);
    const [interval] = (await readTask('own-crashed')).workIntervals;
    expect(interval.startedAt).toBe(WORK_STARTED_AT);
    expect(interval.completedAt).toEqual(expect.any(String));
  });
});
