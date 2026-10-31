import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOpenCodeAppProfileScope } from '../../../../../src/main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import {
  claimTeamForThisProfile,
  createTeamProfileOwnership,
} from '../../../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { ActiveTeamRegistry } from '../../../../../src/main/services/team/stallMonitor/ActiveTeamRegistry';
import { TeamTaskStallMonitor } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallMonitor';
import { TeamTaskStallNotifier } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallNotifier';
import { TeamDataService } from '../../../../../src/main/services/team/TeamDataService';
import { TeamTaskReader } from '../../../../../src/main/services/team/TeamTaskReader';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '../../../../../src/main/utils/pathDecoder';

import type { TaskStallEvaluation } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';
import type { TeamTask } from '../../../../../src/shared/types';

/** alice runs on OpenCode and gets a direct nudge; bob's stall goes to the lead. */
const OPENCODE_OWNER = 'alice';
const CLAUDE_OWNER = 'bob';

let root: string;
let deadPid: number;

function profileScope(profile: 'a' | 'b'): string {
  return buildOpenCodeAppProfileScope(
    path.join(root, `user-data-${profile}`),
    path.join(root, 'claude')
  );
}

function teamFile(teamName: string, ...segments: string[]): string {
  return path.join(getTeamsBasePath(), teamName, ...segments);
}

function tasksDir(teamName: string): string {
  return path.join(getTasksBasePath(), teamName);
}

function ownerInboxFile(teamName: string): string {
  return teamFile(teamName, 'inboxes', `${OPENCODE_OWNER}.json`);
}

async function claimTeam(teamName: string, profile: 'a' | 'b'): Promise<void> {
  await claimTeamForThisProfile({
    teamsBasePath: getTeamsBasePath(),
    teamName,
    reason: 'launch',
    profileScope: profileScope(profile),
  });
}

/**
 * A running team: a live lead process, a teammate process that already exited
 * without a stoppedAt, and two tasks that stay in progress.
 */
async function writeRunningTeam(teamName: string, owner: 'a' | 'b' | null): Promise<void> {
  await mkdir(teamFile(teamName), { recursive: true });
  await writeFile(
    teamFile(teamName, 'config.json'),
    `${JSON.stringify({
      name: teamName,
      projectPath: root,
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: OPENCODE_OWNER, role: 'developer', providerId: 'opencode' },
        { name: CLAUDE_OWNER, role: 'developer' },
      ],
    })}\n`
  );
  await writeFile(
    teamFile(teamName, 'processes.json'),
    `${JSON.stringify(
      [
        { id: 'lead', label: 'lead', pid: process.pid, registeredAt: '2026-10-30T10:00:00.000Z' },
        { id: 'gone', label: 'alice', pid: deadPid, registeredAt: '2026-10-30T10:00:00.000Z' },
      ],
      null,
      2
    )}\n`
  );
  await mkdir(tasksDir(teamName), { recursive: true });
  for (const [id, taskOwner] of [
    ['1', OPENCODE_OWNER],
    ['2', CLAUDE_OWNER],
  ]) {
    await writeFile(
      path.join(tasksDir(teamName), `${id}.json`),
      `${JSON.stringify(
        {
          id,
          subject: `Ship ${teamName} part ${id}`,
          owner: taskOwner,
          status: 'in_progress',
          createdAt: '2026-10-30T10:00:00.000Z',
          updatedAt: '2026-10-30T10:00:00.000Z',
        },
        null,
        2
      )}\n`
    );
  }
  if (owner) {
    await claimTeam(teamName, owner);
  }
}

/** processes.json and every task file of the team, byte for byte. */
async function readTeamBytes(teamName: string): Promise<Map<string, Buffer>> {
  const bytes = new Map<string, Buffer>();
  bytes.set('processes.json', await readFile(teamFile(teamName, 'processes.json')));
  for (const name of (await readdir(tasksDir(teamName))).sort()) {
    bytes.set(`tasks/${name}`, await readFile(path.join(tasksDir(teamName), name)));
  }
  return bytes;
}

function expectSameBytes(after: Map<string, Buffer>, before: Map<string, Buffer>): void {
  expect([...after.keys()]).toEqual([...before.keys()]);
  for (const [name, content] of before) {
    expect(after.get(name)?.equals(content), name).toBe(true);
  }
}

async function readProcessRows(teamName: string): Promise<{ id: string; stoppedAt?: string }[]> {
  return JSON.parse(await readFile(teamFile(teamName, 'processes.json'), 'utf8')) as {
    id: string;
    stoppedAt?: string;
  }[];
}

/**
 * Real TeamDataService, ownership, registry, notifier and inbox writer under a
 * temp Claude root. Only stall detection is stubbed: every in-progress task is
 * reported as stalled, so whatever the monitor scans gets alerts. The lead
 * alert is observed at sendSystemNotificationToLead; the OpenCode owner nudge
 * really writes the owner's inbox file.
 */
function createHarness(options: { beforeSnapshot?: (teamName: string) => Promise<void> } = {}) {
  const teamDataService = new TeamDataService();
  const ownership = createTeamProfileOwnership({ isTrackedInThisProcess: () => false });
  teamDataService.setTeamProfileOwnership((teamName) => ownership.isManagedByThisProfile(teamName));
  const leadAlert = vi
    .spyOn(teamDataService, 'sendSystemNotificationToLead')
    .mockResolvedValue({ deliveredToInbox: true, messageId: 'lead-alert' });
  const tracker = {
    enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
    disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
  };
  const registry = new ActiveTeamRegistry(teamDataService, tracker as never);
  const taskReader = new TeamTaskReader();
  const snapshotSource = {
    getSnapshot: vi.fn(async (teamName: string) => {
      await options.beforeSnapshot?.(teamName);
      const tasks = await taskReader.getTasks(teamName);
      return {
        teamName,
        inProgressTasks: tasks.filter((task) => task.status === 'in_progress'),
        reviewOpenTasks: [],
        allTasksById: new Map(tasks.map((task) => [task.id, task] as const)),
        providerByMemberName: new Map([[OPENCODE_OWNER, 'opencode']]),
      };
    }),
  };
  const policy = {
    evaluateWork: ({ task }: { task: TeamTask }): TaskStallEvaluation => ({
      status: 'alert',
      taskId: task.id,
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: `${task.id}:work:epoch`,
      reason: 'Potential work stall.',
    }),
    evaluateReview: vi.fn(),
    evaluatePendingPickup: vi.fn(),
  };
  const journal = {
    reconcileScan: async ({ evaluations }: { evaluations: TaskStallEvaluation[] }) => evaluations,
    markAlerted: vi.fn(async () => undefined),
  };
  const relay = vi.fn(async () => ({ lastDelivery: { delivered: true, accepted: true } }));
  const monitor = new TeamTaskStallMonitor(
    registry,
    snapshotSource as never,
    policy as never,
    journal as never,
    new TeamTaskStallNotifier(teamDataService, { relayOpenCodeMemberInboxMessages: relay })
  );
  const runScan = (): Promise<void> =>
    (monitor as unknown as { runScan(): Promise<void> }).runScan();
  return { teamDataService, registry, tracker, snapshotSource, relay, leadAlert, monitor, runScan };
}

type Harness = ReturnType<typeof createHarness>;

/**
 * Reconciles before start so the activation has settled when the scans run.
 * The first scan only starts the startup clock; the second one may alert.
 */
async function startAndScanTwice(
  harness: Harness,
  beforeSecondScan?: () => Promise<void> | void
): Promise<void> {
  await harness.registry.reconcile();
  harness.monitor.start();
  try {
    await harness.runScan();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await beforeSecondScan?.();
    await harness.runScan();
  } finally {
    await harness.monitor.stop();
  }
}

function expectNothingSentTo(harness: Harness, teamName: string): void {
  expect(existsSync(teamFile(teamName, 'inboxes'))).toBe(false);
  expect(harness.relay).not.toHaveBeenCalledWith(teamName, expect.anything(), expect.anything());
  expect(harness.leadAlert).not.toHaveBeenCalledWith(expect.objectContaining({ teamName }));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'TEST-stall-monitor-profile-ownership-'));
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'user-data-a'));
  vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
  vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');
  vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'true');
  vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', 'true');
  vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', 'true');
  const exited = spawnSync(process.execPath, ['-e', '']);
  if (typeof exited.pid !== 'number') {
    throw new Error('could not obtain the pid of an exited process');
  }
  deadPid = exited.pid;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  TeamTaskReader.invalidateAllTasksCache();
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await rm(root, { recursive: true, force: true });
});

describe('task stall monitor and teams of other profiles', () => {
  it('alerts its own team and leaves teams of other profiles byte for byte', async () => {
    await writeRunningTeam('own', 'a');
    await writeRunningTeam('other-profile', 'b');
    await writeRunningTeam('native-session', null);
    const before = new Map([
      ['other-profile', await readTeamBytes('other-profile')],
      ['native-session', await readTeamBytes('native-session')],
    ]);
    const harness = createHarness();

    await startAndScanTwice(harness);

    const ownerInbox = JSON.parse(await readFile(ownerInboxFile('own'), 'utf8')) as {
      messageKind?: string;
    }[];
    expect(ownerInbox.map((message) => message.messageKind)).toEqual(['task_stall_remediation']);
    expect(harness.relay).toHaveBeenCalledWith('own', OPENCODE_OWNER, expect.anything());
    expect(harness.leadAlert).toHaveBeenCalledTimes(1);
    expect(harness.leadAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'own',
        taskRefs: [expect.objectContaining({ taskId: '2', teamName: 'own' })],
      })
    );
    // Listing the own team still settles its exited teammate process.
    const ownRows = await readProcessRows('own');
    expect(ownRows.find((row) => row.id === 'gone')?.stoppedAt).toEqual(expect.any(String));
    expect(ownRows.find((row) => row.id === 'lead')?.stoppedAt).toBeUndefined();

    for (const [teamName, teamBytes] of before) {
      expectNothingSentTo(harness, teamName);
      expectSameBytes(await readTeamBytes(teamName), teamBytes);
      expect(harness.tracker.enableTracking).not.toHaveBeenCalledWith(teamName, 'stall_monitor');
      expect(harness.snapshotSource.getSnapshot).not.toHaveBeenCalledWith(teamName);
    }
    expect(harness.tracker.enableTracking).toHaveBeenCalledWith('own', 'stall_monitor');
  });

  it('does not activate a team of another profile from a lead-activity event', async () => {
    await writeRunningTeam('other-profile', 'b');
    const before = await readTeamBytes('other-profile');
    const harness = createHarness();

    harness.monitor.noteTeamChange({
      type: 'lead-activity',
      teamName: 'other-profile',
      detail: 'active',
    });
    await startAndScanTwice(harness);

    expect(harness.tracker.enableTracking).not.toHaveBeenCalled();
    expect(harness.snapshotSource.getSnapshot).not.toHaveBeenCalled();
    expectNothingSentTo(harness, 'other-profile');
    expectSameBytes(await readTeamBytes('other-profile'), before);
  });

  it('writes nothing when another profile takes the team over during the scan', async () => {
    await writeRunningTeam('own', 'a');
    let takeOverOnSnapshot = false;
    const harness = createHarness({
      beforeSnapshot: async (teamName) => {
        if (takeOverOnSnapshot) {
          await claimTeam(teamName, 'b');
        }
      },
    });

    // The registry still lists the team for the second scan; the takeover lands
    // after that check and before the notifier writes.
    await startAndScanTwice(harness, () => {
      takeOverOnSnapshot = true;
    });

    expect(harness.snapshotSource.getSnapshot).toHaveBeenCalledTimes(1);
    expectNothingSentTo(harness, 'own');
  });

  it('stops scanning a team that another profile took over since the last reconcile', async () => {
    await writeRunningTeam('own', 'a');
    const harness = createHarness();

    await startAndScanTwice(harness, () => claimTeam('own', 'b'));

    expect(harness.tracker.enableTracking).toHaveBeenCalledWith('own', 'stall_monitor');
    expect(harness.snapshotSource.getSnapshot).not.toHaveBeenCalled();
    expectNothingSentTo(harness, 'own');
  });

  it('settles exited processes in the health tick and alive-team count only for its own team', async () => {
    await writeRunningTeam('own', 'a');
    await writeRunningTeam('other-profile', 'b');
    const before = await readTeamBytes('other-profile');
    const { teamDataService } = createHarness();
    teamDataService.trackProcessHealthForTeam('own');
    teamDataService.trackProcessHealthForTeam('other-profile');

    await (
      teamDataService as unknown as { processHealthTick(): Promise<void> }
    ).processHealthTick();

    expect((await readProcessRows('own')).find((row) => row.id === 'gone')?.stoppedAt).toEqual(
      expect.any(String)
    );
    expectSameBytes(await readTeamBytes('other-profile'), before);
    // Counting live processes still reads the other profile's team.
    await expect(teamDataService.listAliveProcessTeams()).resolves.toEqual([
      'other-profile',
      'own',
    ]);
    expectSameBytes(await readTeamBytes('other-profile'), before);
  });
});
