import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import type {
  OpenCodeTeamRuntimeMessageInput,
  OpenCodeTeamRuntimeMessageResult,
} from '../../../../src/main/services/team/runtime';
import {
  TeamRuntimeAdapterRegistry,
  type TeamLaunchRuntimeAdapter,
  type TeamRuntimeLaunchInput,
  type TeamRuntimeMemberLaunchEvidence,
  type TeamRuntimeMemberSpec,
  type TeamRuntimeLaunchResult,
  type TeamRuntimePrepareResult,
  type TeamRuntimeReconcileInput,
  type TeamRuntimeReconcileResult,
  type TeamRuntimeStopInput,
  type TeamRuntimeStopResult,
} from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import {
  encodePath,
  extractBaseDir,
  getProjectsBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { createPersistedLaunchSnapshot } from '../../../../src/main/services/team/TeamLaunchStateEvaluator';
import {
  readOpenCodeRuntimeLaneIndex,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const LAUNCH_MATRIX_SAFE_E2E_TIMEOUT_MS = 60_000;

describe('Team agent launch matrix safe e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-launch-matrix-e2e-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await removeTempDirWithRetries(tempDir);
  });

  it('launches a pure OpenCode team through the runtime adapter and exposes live members', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const progressEvents: TeamProvisioningProgress[] = [];

    const { runId } = await svc.createTeam(
      {
        teamName: 'pure-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [
          { name: 'alice', role: 'Developer', providerId: 'opencode' },
          { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
        ],
      },
      (progress) => progressEvents.push(progress)
    );

    expect(runId).toBe(adapter.launchInputs[0]?.runId);
    expect(adapter.launchInputs).toHaveLength(1);
    expect(adapter.launchInputs[0]?.expectedMembers.map((member) => member.name)).toEqual([
      'alice',
      'bob',
    ]);
    expect(progressEvents.at(-1)).toMatchObject({
      state: 'ready',
      message: 'OpenCode team launch is ready',
    });

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot('pure-opencode-safe-e2e');
    expect(runtimeSnapshot.members.alice).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: 'opencode/big-pickle',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: 'opencode/big-pickle',
    });

    await expect(
      fs.readFile(path.join(getTeamsBasePath(), 'pure-opencode-safe-e2e', 'launch-state.json'), {
        encoding: 'utf8',
      })
    ).resolves.toContain('"teamLaunchState": "clean_success"');
  });

  it('keeps failed OpenCode runtime adapter launches out of alive teams', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter('partial_failure');
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const progressEvents: TeamProvisioningProgress[] = [];

    await svc.createTeam(
      {
        teamName: 'failed-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      (progress) => progressEvents.push(progress)
    );

    expect(progressEvents.at(-1)).toMatchObject({
      state: 'failed',
      message: 'OpenCode team launch failed readiness gate',
    });
    expect(svc.isTeamAlive('failed-opencode-safe-e2e')).toBe(false);

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot('failed-opencode-safe-e2e');
    expect(runtimeSnapshot.members.alice).toMatchObject({
      alive: false,
      providerId: 'opencode',
      runtimeModel: 'opencode/big-pickle',
    });
  });

  it('launches an existing pure OpenCode team config through the runtime adapter', async () => {
    await writeOpenCodeTeamConfig({
      teamName: 'existing-opencode-safe-e2e',
      projectPath,
      members: ['alice', 'bob'],
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const progressEvents: TeamProvisioningProgress[] = [];

    const { runId } = await svc.launchTeam(
      {
        teamName: 'existing-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      (progress) => progressEvents.push(progress)
    );

    expect(runId).toBe(adapter.launchInputs[0]?.runId);
    expect(adapter.launchInputs[0]?.expectedMembers.map((member) => member.name)).toEqual([
      'alice',
      'bob',
    ]);
    expect(progressEvents.at(-1)).toMatchObject({
      state: 'ready',
      message: 'OpenCode team launch is ready',
    });

    const statuses = await svc.getMemberSpawnStatuses('existing-opencode-safe-e2e');
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
  });

  it('keeps permission-pending OpenCode members pending instead of reading the team as fully ready', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending');
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const progressEvents: TeamProvisioningProgress[] = [];

    await svc.createTeam(
      {
        teamName: 'permission-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: false,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      (progress) => progressEvents.push(progress)
    );

    expect(progressEvents.at(-1)).toMatchObject({
      state: 'ready',
      message: 'OpenCode team launch is waiting for runtime evidence or permissions',
      messageSeverity: 'warning',
    });
    expect(svc.isTeamAlive('permission-opencode-safe-e2e')).toBe(true);

    const statuses = await svc.getMemberSpawnStatuses('permission-opencode-safe-e2e');
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      runtimeAlive: false,
      pendingPermissionRequestIds: ['perm-alice'],
    });
    expect(statuses.summary?.pendingCount).toBe(1);
  });

  it('preserves mixed OpenCode per-member outcomes after a partial runtime adapter launch', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter('partial_failure', {
      alice: 'confirmed',
      bob: 'permission',
      tom: 'failed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await svc.createTeam(
      {
        teamName: 'mixed-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: false,
        members: [
          { name: 'alice', role: 'Developer', providerId: 'opencode' },
          { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
          { name: 'tom', role: 'Developer', providerId: 'opencode' },
        ],
      },
      () => undefined
    );

    expect(svc.isTeamAlive('mixed-opencode-safe-e2e')).toBe(false);

    const statuses = await svc.getMemberSpawnStatuses('mixed-opencode-safe-e2e');
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      runtimeAlive: false,
      pendingPermissionRequestIds: ['perm-bob'],
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      runtimeAlive: false,
      hardFailure: true,
      hardFailureReason: 'fake_open_code_launch_failure',
    });
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 1,
    });
  });

  it('stops a pure OpenCode runtime adapter team and clears alive tracking', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await svc.createTeam(
      {
        teamName: 'stoppable-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    expect(svc.isTeamAlive('stoppable-opencode-safe-e2e')).toBe(true);

    svc.stopTeam('stoppable-opencode-safe-e2e');

    await waitForCondition(() => adapter.stopInputs.length === 1);
    await waitForCondition(() => !svc.isTeamAlive('stoppable-opencode-safe-e2e'));
    expect(adapter.stopInputs[0]).toMatchObject({
      teamName: 'stoppable-opencode-safe-e2e',
      providerId: 'opencode',
      reason: 'user_requested',
      force: true,
    });
  });

  it('stops one pure OpenCode runtime adapter team without disconnecting another team', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await svc.createTeam(
      {
        teamName: 'pure-opencode-stop-isolated-a-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await svc.createTeam(
      {
        teamName: 'pure-opencode-stop-isolated-b-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
      },
      () => undefined
    );

    expect(svc.isTeamAlive('pure-opencode-stop-isolated-a-safe-e2e')).toBe(true);
    expect(svc.isTeamAlive('pure-opencode-stop-isolated-b-safe-e2e')).toBe(true);

    svc.stopTeam('pure-opencode-stop-isolated-a-safe-e2e');

    await waitForCondition(() => adapter.stopInputs.length === 1);
    await waitForCondition(() => !svc.isTeamAlive('pure-opencode-stop-isolated-a-safe-e2e'));
    expect(svc.isTeamAlive('pure-opencode-stop-isolated-b-safe-e2e')).toBe(true);
    expect(adapter.stopInputs[0]).toMatchObject({
      teamName: 'pure-opencode-stop-isolated-a-safe-e2e',
      providerId: 'opencode',
      reason: 'user_requested',
    });

    const survivingStatuses = await svc.getMemberSpawnStatuses(
      'pure-opencode-stop-isolated-b-safe-e2e'
    );
    expect(survivingStatuses.teamLaunchState).toBe('clean_success');
    expect(survivingStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    const survivingSnapshot = await svc.getTeamAgentRuntimeSnapshot(
      'pure-opencode-stop-isolated-b-safe-e2e'
    );
    expect(survivingSnapshot.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: 'opencode/big-pickle',
    });
  });

  it('lists only still-running OpenCode runtime adapter teams after one team stops', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await svc.createTeam(
      {
        teamName: 'pure-opencode-alive-list-a-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await svc.createTeam(
      {
        teamName: 'pure-opencode-alive-list-b-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
      },
      () => undefined
    );

    expect(svc.getAliveTeams().sort()).toEqual([
      'pure-opencode-alive-list-a-safe-e2e',
      'pure-opencode-alive-list-b-safe-e2e',
    ]);

    svc.stopTeam('pure-opencode-alive-list-a-safe-e2e');

    await waitForCondition(() => !svc.isTeamAlive('pure-opencode-alive-list-a-safe-e2e'));
    expect(svc.getAliveTeams()).toEqual(['pure-opencode-alive-list-b-safe-e2e']);
    const statuses = await svc.getMemberSpawnStatuses('pure-opencode-alive-list-b-safe-e2e');
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('reports pure OpenCode runtime state as alive before stop and offline after stop', async () => {
    const teamName = 'pure-opencode-runtime-state-stop-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const { runId } = await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    const runningState = await svc.getRuntimeState(teamName);
    expect(runningState).toMatchObject({
      teamName,
      isAlive: true,
      runId,
      progress: {
        state: 'ready',
        message: 'OpenCode team launch is ready',
      },
    });

    svc.stopTeam(teamName);

    await waitForCondition(() => !svc.isTeamAlive(teamName));
    const stoppedState = await svc.getRuntimeState(teamName);
    expect(stoppedState).toMatchObject({
      teamName,
      isAlive: false,
    });
  });

  it('stops the stale pure OpenCode primary runtime before same-team relaunch', async () => {
    const teamName = 'pure-opencode-relaunch-stops-stale-runtime-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const first = await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    expect(svc.isTeamAlive(teamName)).toBe(true);
    expect(adapter.stopInputs).toHaveLength(0);
    const firstSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(firstSnapshot).toMatchObject({
      runId: first.runId,
      members: {
        alice: {
          alive: true,
          providerId: 'opencode',
          runtimeModel: 'opencode/big-pickle',
        },
      },
    });

    const second = await svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );

    expect(second.runId).not.toBe(first.runId);
    expect(adapter.launchInputs.map((input) => input.runId)).toEqual([first.runId, second.runId]);
    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: first.runId,
      teamName,
      laneId: 'primary',
      providerId: 'opencode',
      reason: 'user_requested',
      force: true,
    });
    expect(svc.isTeamAlive(teamName)).toBe(true);

    const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(snapshot).toMatchObject({
      runId: second.runId,
      members: {
        alice: {
          alive: true,
          providerId: 'opencode',
          runtimeModel: 'opencode/big-pickle',
        },
      },
    });

    svc.stopTeam(teamName);

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs[1]).toMatchObject({
      runId: second.runId,
      teamName,
      laneId: 'primary',
      providerId: 'opencode',
      reason: 'user_requested',
      force: true,
    });
    await waitForCondition(() => !svc.isTeamAlive(teamName));
  });

  it('relaunches one pure OpenCode team without stopping another live OpenCode team', async () => {
    const relaunchTeamName = 'pure-opencode-relaunch-isolated-a-safe-e2e';
    const survivingTeamName = 'pure-opencode-relaunch-isolated-b-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const relaunchFirst = await svc.createTeam(
      {
        teamName: relaunchTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    const surviving = await svc.createTeam(
      {
        teamName: survivingTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
      },
      () => undefined
    );

    const relaunchSecond = await svc.launchTeam(
      {
        teamName: relaunchTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );

    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: relaunchFirst.runId,
      teamName: relaunchTeamName,
      laneId: 'primary',
      providerId: 'opencode',
    });
    expect(svc.getAliveTeams().sort()).toEqual([relaunchTeamName, survivingTeamName].sort());

    const relaunchedSnapshot = await svc.getTeamAgentRuntimeSnapshot(relaunchTeamName);
    expect(relaunchedSnapshot).toMatchObject({
      runId: relaunchSecond.runId,
      members: {
        alice: {
          alive: true,
          providerId: 'opencode',
          runtimeModel: 'opencode/big-pickle',
        },
      },
    });
    const survivingSnapshot = await svc.getTeamAgentRuntimeSnapshot(survivingTeamName);
    expect(survivingSnapshot).toMatchObject({
      runId: surviving.runId,
      members: {
        bob: {
          alive: true,
          providerId: 'opencode',
          runtimeModel: 'opencode/big-pickle',
        },
      },
    });
  });

  it('serializes same-team pure OpenCode relaunch behind an in-flight launch before replacing the current run', async () => {
    const teamName = 'pure-opencode-relaunch-queued-safe-e2e';
    const adapter = new BlockingOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const firstPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
    expect(firstRunId).toBeTruthy();

    const secondPromise = svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );
    await Promise.resolve();
    expect(adapter.pendingLaunchInputs).toHaveLength(1);
    expect(adapter.stopInputs).toHaveLength(0);

    adapter.releaseLaunches();
    await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
    const second = await secondPromise;
    const secondRunId = second.runId;
    expect(secondRunId).toBeTruthy();
    expect(secondRunId).not.toBe(firstRunId);

    expect(svc.isTeamAlive(teamName)).toBe(true);
    expect(svc.getAliveTeams()).toEqual([teamName]);
    expect(adapter.launchInputs.map((input) => input.runId)).toEqual([firstRunId, secondRunId]);
    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: firstRunId,
      teamName,
      laneId: 'primary',
      providerId: 'opencode',
      reason: 'user_requested',
      force: true,
    });
    const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(snapshot).toMatchObject({
      runId: secondRunId,
      members: {
        alice: {
          alive: true,
          providerId: 'opencode',
          runtimeModel: 'opencode/big-pickle',
        },
      },
    });
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          primary: { state: 'active' },
        },
      }
    );
  });

  it('keeps relaunch waiting while the previous same-team OpenCode runtime stop is slow', async () => {
    const teamName = 'pure-opencode-relaunch-slow-stop-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const firstPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
    expect(firstRunId).toBeTruthy();
    adapter.releaseLaunches();
    await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
    await waitForCondition(() => adapter.launchInputs.length === 1);
    expect(svc.isTeamAlive(teamName)).toBe(true);

    const secondPromise = svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );

    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: firstRunId,
      teamName,
      laneId: 'primary',
      cwd: projectPath,
      reason: 'user_requested',
      force: true,
    });
    await expect(svc.getProvisioningStatus(firstRunId!)).resolves.toMatchObject({
      runId: firstRunId,
      teamName,
      state: 'disconnected',
      message: 'Stopping OpenCode team through runtime adapter',
    });
    expect(adapter.pendingLaunchInputs).toHaveLength(1);
    expect(adapter.launchInputs).toHaveLength(1);
    expect(svc.getAliveTeams()).toEqual([]);

    adapter.releaseStops();
    const second = await secondPromise;
    expect(second.runId).toBeTruthy();
    expect(second.runId).not.toBe(firstRunId);
    await waitForCondition(() => adapter.launchInputs.length === 2);

    expect(svc.isTeamAlive(teamName)).toBe(true);
    expect(svc.getAliveTeams()).toEqual([teamName]);
    await expect(svc.getProvisioningStatus(second.runId)).resolves.toMatchObject({
      runId: second.runId,
      teamName,
      state: 'ready',
      message: 'OpenCode team launch is ready',
    });
    const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(snapshot).toMatchObject({
      runId: second.runId,
      members: {
        alice: {
          alive: true,
          providerId: 'opencode',
          runtimeModel: 'opencode/big-pickle',
        },
      },
    });
  });

  it('serializes manual stop and same-team OpenCode relaunch behind a slow runtime stop', async () => {
    const teamName = 'pure-opencode-stop-then-relaunch-slow-stop-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const firstPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
    expect(firstRunId).toBeTruthy();
    adapter.releaseLaunches();
    await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
    await waitForCondition(() => adapter.launchInputs.length === 1);
    expect(svc.getAliveTeams()).toEqual([teamName]);

    svc.stopTeam(teamName);
    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: firstRunId,
      teamName,
      laneId: 'primary',
      cwd: projectPath,
      reason: 'user_requested',
      force: true,
    });
    expect(svc.getAliveTeams()).toEqual([]);

    const secondPromise = svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );
    await Promise.resolve();
    expect(adapter.pendingLaunchInputs).toHaveLength(1);
    expect(adapter.launchInputs).toHaveLength(1);

    adapter.releaseStops();
    const second = await secondPromise;
    expect(second.runId).toBeTruthy();
    expect(second.runId).not.toBe(firstRunId);
    await waitForCondition(() => adapter.launchInputs.length === 2);

    expect(svc.getAliveTeams()).toEqual([teamName]);
    await expect(svc.getProvisioningStatus(second.runId)).resolves.toMatchObject({
      runId: second.runId,
      teamName,
      state: 'ready',
      message: 'OpenCode team launch is ready',
    });
  });

  it('keeps slow OpenCode stop scoped to one team while another team relaunches', async () => {
    const stoppingTeamName = 'pure-opencode-cross-team-slow-stop-a-safe-e2e';
    const relaunchTeamName = 'pure-opencode-cross-team-slow-stop-b-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const stoppingCreate = svc.createTeam(
      {
        teamName: stoppingTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    adapter.releaseLaunches();
    const stopping = await stoppingCreate;

    const relaunchFirst = await svc.createTeam(
      {
        teamName: relaunchTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.launchInputs.length === 2);
    expect(svc.getAliveTeams().sort()).toEqual([relaunchTeamName, stoppingTeamName].sort());

    svc.stopTeam(stoppingTeamName);
    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: stopping.runId,
      teamName: stoppingTeamName,
      laneId: 'primary',
      reason: 'user_requested',
    });
    expect(svc.isTeamAlive(stoppingTeamName)).toBe(false);
    expect(svc.isTeamAlive(relaunchTeamName)).toBe(true);

    const relaunchSecondPromise = svc.launchTeam(
      {
        teamName: relaunchTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );
    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs[1]).toMatchObject({
      runId: relaunchFirst.runId,
      teamName: relaunchTeamName,
      laneId: 'primary',
      reason: 'user_requested',
    });
    expect(adapter.launchInputs).toHaveLength(2);

    adapter.releaseStops();
    const relaunchSecond = await relaunchSecondPromise;
    await waitForCondition(() => adapter.launchInputs.length === 3);
    expect(relaunchSecond.runId).not.toBe(relaunchFirst.runId);
    expect(svc.isTeamAlive(stoppingTeamName)).toBe(false);
    expect(svc.isTeamAlive(relaunchTeamName)).toBe(true);
  });

  it('dedupes duplicate manual OpenCode stops while the runtime stop is still pending', async () => {
    const teamName = 'pure-opencode-duplicate-stop-slow-stop-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const createPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const runId = adapter.pendingLaunchInputs[0]?.runId;
    expect(runId).toBeTruthy();
    adapter.releaseLaunches();
    await expect(createPromise).resolves.toEqual({ runId });
    await waitForCondition(() => adapter.launchInputs.length === 1);

    svc.stopTeam(teamName);
    svc.stopTeam(teamName);

    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId,
      teamName,
      laneId: 'primary',
      reason: 'user_requested',
    });
    expect(svc.getAliveTeams()).toEqual([]);
    await Promise.resolve();
    expect(adapter.stopInputs).toHaveLength(1);

    adapter.releaseStops();
    await waitForCondition(() => {
      const status = (svc as any).runtimeAdapterProgressByRunId.get(runId);
      return status?.state === 'disconnected' && status.message === 'OpenCode team stopped';
    });
    expect(adapter.stopInputs).toHaveLength(1);
    expect(svc.isTeamAlive(teamName)).toBe(false);
  });

  it('does not resurrect a same-team OpenCode relaunch after stopAllTeams during slow replacement stop', async () => {
    const teamName = 'pure-opencode-relaunch-stop-all-during-slow-stop-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const firstPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
    expect(firstRunId).toBeTruthy();
    adapter.releaseLaunches();
    await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
    await waitForCondition(() => adapter.launchInputs.length === 1);

    const relaunchPromise = svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );
    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: firstRunId,
      teamName,
      laneId: 'primary',
      reason: 'user_requested',
    });
    expect(adapter.launchInputs).toHaveLength(1);

    svc.stopAllTeams();
    adapter.releaseStops();
    const relaunch = await relaunchPromise;

    expect(relaunch.runId).toBeTruthy();
    expect(relaunch.runId).not.toBe(firstRunId);
    expect(adapter.launchInputs).toHaveLength(1);
    await expect(svc.getProvisioningStatus(relaunch.runId)).resolves.toMatchObject({
      runId: relaunch.runId,
      teamName,
      state: 'cancelled',
      message: 'Provisioning cancelled by user',
    });
    expect(svc.isTeamAlive(teamName)).toBe(false);
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
  });

  it('allows a fresh OpenCode launch after stopAllTeams cancelled a queued same-team relaunch', async () => {
    const teamName = 'pure-opencode-launch-after-stop-all-cancelled-relaunch-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const firstPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const firstRunId = adapter.pendingLaunchInputs[0]?.runId;
    expect(firstRunId).toBeTruthy();
    adapter.releaseLaunches();
    await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
    await waitForCondition(() => adapter.launchInputs.length === 1);

    const cancelledRelaunchPromise = svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );
    await waitForCondition(() => adapter.stopInputs.length === 1);
    svc.stopAllTeams();
    adapter.releaseStops();
    const cancelledRelaunch = await cancelledRelaunchPromise;

    expect(adapter.launchInputs).toHaveLength(1);
    await expect(svc.getProvisioningStatus(cancelledRelaunch.runId)).resolves.toMatchObject({
      runId: cancelledRelaunch.runId,
      teamName,
      state: 'cancelled',
    });
    expect(svc.isTeamAlive(teamName)).toBe(false);

    const freshLaunch = await svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );

    expect(freshLaunch.runId).toBeTruthy();
    expect(freshLaunch.runId).not.toBe(firstRunId);
    expect(freshLaunch.runId).not.toBe(cancelledRelaunch.runId);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    expect(adapter.launchInputs[1]).toMatchObject({
      runId: freshLaunch.runId,
      teamName,
      providerId: 'opencode',
      cwd: projectPath,
    });
    await expect(svc.getProvisioningStatus(freshLaunch.runId)).resolves.toMatchObject({
      runId: freshLaunch.runId,
      teamName,
      state: 'ready',
      message: 'OpenCode team launch is ready',
    });
    expect(svc.isTeamAlive(teamName)).toBe(true);
    const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(snapshot).toMatchObject({
      runId: freshLaunch.runId,
      members: {
        alice: {
          alive: true,
          providerId: 'opencode',
          runtimeModel: 'opencode/big-pickle',
        },
      },
    });
  });

  it('stopAllTeams does not double-stop an already stopping OpenCode team and still stops live siblings', async () => {
    const stoppingTeamName = 'pure-opencode-stop-all-already-stopping-a-safe-e2e';
    const liveTeamName = 'pure-opencode-stop-all-already-stopping-b-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const stoppingCreate = svc.createTeam(
      {
        teamName: stoppingTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const stoppingRunId = adapter.pendingLaunchInputs[0]?.runId;
    expect(stoppingRunId).toBeTruthy();
    adapter.releaseLaunches();
    await expect(stoppingCreate).resolves.toEqual({ runId: stoppingRunId });

    const live = await svc.createTeam(
      {
        teamName: liveTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.launchInputs.length === 2);
    expect(svc.getAliveTeams().sort()).toEqual([liveTeamName, stoppingTeamName].sort());

    svc.stopTeam(stoppingTeamName);
    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: stoppingRunId,
      teamName: stoppingTeamName,
      laneId: 'primary',
      reason: 'user_requested',
    });
    expect(svc.isTeamAlive(stoppingTeamName)).toBe(false);
    expect(svc.isTeamAlive(liveTeamName)).toBe(true);

    svc.stopAllTeams();
    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: stoppingRunId,
          teamName: stoppingTeamName,
          laneId: 'primary',
          reason: 'user_requested',
        }),
        expect.objectContaining({
          runId: live.runId,
          teamName: liveTeamName,
          laneId: 'primary',
          reason: 'user_requested',
        }),
      ])
    );
    expect(adapter.stopInputs.filter((input) => input.teamName === stoppingTeamName)).toHaveLength(
      1
    );
    expect(svc.getAliveTeams()).toEqual([]);

    adapter.releaseStops();
    await waitForCondition(() => !svc.isTeamAlive(liveTeamName));
    expect(svc.isTeamAlive(stoppingTeamName)).toBe(false);
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), stoppingTeamName)).resolves
      .toMatchObject({
        lanes: {},
      });
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), liveTeamName)).resolves
      .toMatchObject({
        lanes: {},
      });
  });

  it('cancels an in-flight pure OpenCode runtime adapter launch without letting late success resurrect it', async () => {
    const teamName = 'pure-opencode-cancel-inflight-runtime-safe-e2e';
    const adapter = new BlockingOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const createPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const runId = adapter.pendingLaunchInputs[0]?.runId;
    expect(runId).toBeTruthy();

    await svc.cancelProvisioning(runId!);

    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId,
      teamName,
      laneId: 'primary',
      providerId: 'opencode',
      reason: 'user_requested',
      force: true,
    });
    await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
      runId,
      teamName,
      state: 'cancelled',
      message: 'Provisioning cancelled by user',
    });
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseLaunches();
    await expect(createPromise).resolves.toEqual({ runId });
    await waitForCondition(() => adapter.launchInputs.length === 1);

    expect(svc.isTeamAlive(teamName)).toBe(false);
    expect(svc.getAliveTeams()).not.toContain(teamName);
    const state = await svc.getRuntimeState(teamName);
    expect(state).toMatchObject({
      teamName,
      isAlive: false,
      runId: null,
    });
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('clean_success');
  });

  it('shows cancelled status immediately when manual cancel waits on a slow OpenCode stop', async () => {
    const teamName = 'pure-opencode-cancel-slow-stop-status-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const createPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const runId = adapter.pendingLaunchInputs[0]?.runId;
    expect(runId).toBeTruthy();

    const cancelPromise = svc.cancelProvisioning(runId!);

    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId,
      teamName,
      laneId: 'primary',
      cwd: projectPath,
      reason: 'user_requested',
      force: true,
    });
    await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
      runId,
      teamName,
      state: 'cancelled',
      message: 'Provisioning cancelled by user',
    });
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseLaunches();
    await expect(createPromise).resolves.toEqual({ runId });
    await waitForCondition(() => adapter.launchInputs.length === 1);
    await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
      runId,
      teamName,
      state: 'cancelled',
    });

    adapter.releaseStops();
    await expect(cancelPromise).resolves.toBeUndefined();
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
    expect(svc.getAliveTeams()).not.toContain(teamName);
  });

  it('cancels one in-flight pure OpenCode launch without cancelling another OpenCode team', async () => {
    const cancelledTeamName = 'pure-opencode-cancel-inflight-isolated-a-safe-e2e';
    const survivingTeamName = 'pure-opencode-cancel-inflight-isolated-b-safe-e2e';
    const adapter = new BlockingOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const cancelledPromise = svc.createTeam(
      {
        teamName: cancelledTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    const survivingPromise = svc.createTeam(
      {
        teamName: survivingTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
      },
      () => undefined
    );

    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
    const cancelledRunId = adapter.pendingLaunchInputs.find(
      (input) => input.teamName === cancelledTeamName
    )?.runId;
    const survivingRunId = adapter.pendingLaunchInputs.find(
      (input) => input.teamName === survivingTeamName
    )?.runId;
    expect(cancelledRunId).toBeTruthy();
    expect(survivingRunId).toBeTruthy();

    await svc.cancelProvisioning(cancelledRunId!);

    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: cancelledRunId,
      teamName: cancelledTeamName,
      laneId: 'primary',
      providerId: 'opencode',
      reason: 'user_requested',
      force: true,
    });
    expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
    expect(svc.isTeamAlive(survivingTeamName)).toBe(false);

    adapter.releaseLaunches();

    await expect(cancelledPromise).resolves.toEqual({ runId: cancelledRunId });
    await expect(survivingPromise).resolves.toEqual({ runId: survivingRunId });
    await waitForCondition(() => adapter.launchInputs.length === 2);

    expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
    expect(svc.isTeamAlive(survivingTeamName)).toBe(true);
    expect(svc.getAliveTeams()).toEqual([survivingTeamName]);
    await expect(svc.getProvisioningStatus(cancelledRunId!)).resolves.toMatchObject({
      runId: cancelledRunId,
      teamName: cancelledTeamName,
      state: 'cancelled',
    });
    const survivingState = await svc.getRuntimeState(survivingTeamName);
    expect(survivingState).toMatchObject({
      teamName: survivingTeamName,
      isAlive: true,
      runId: survivingRunId,
      progress: {
        state: 'ready',
        message: 'OpenCode team launch is ready',
      },
    });
    const cancelledStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
    expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
    const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
    expect(survivingStatuses.teamLaunchState).toBe('clean_success');
    expect(survivingStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('manual cancel with slow OpenCode stop stays scoped while another in-flight team succeeds', async () => {
    const cancelledTeamName = 'pure-opencode-cancel-slow-stop-isolated-a-safe-e2e';
    const survivingTeamName = 'pure-opencode-cancel-slow-stop-isolated-b-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const cancelledPromise = svc.createTeam(
      {
        teamName: cancelledTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    const survivingPromise = svc.createTeam(
      {
        teamName: survivingTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
      },
      () => undefined
    );

    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
    const cancelledRunId = adapter.pendingLaunchInputs.find(
      (input) => input.teamName === cancelledTeamName
    )?.runId;
    const survivingRunId = adapter.pendingLaunchInputs.find(
      (input) => input.teamName === survivingTeamName
    )?.runId;
    expect(cancelledRunId).toBeTruthy();
    expect(survivingRunId).toBeTruthy();

    const cancelPromise = svc.cancelProvisioning(cancelledRunId!);

    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: cancelledRunId,
      teamName: cancelledTeamName,
      laneId: 'primary',
      cwd: projectPath,
      reason: 'user_requested',
      force: true,
    });
    await expect(svc.getProvisioningStatus(cancelledRunId!)).resolves.toMatchObject({
      runId: cancelledRunId,
      teamName: cancelledTeamName,
      state: 'cancelled',
    });
    await expect(svc.getProvisioningStatus(survivingRunId!)).resolves.toMatchObject({
      runId: survivingRunId,
      teamName: survivingTeamName,
      state: 'spawning',
    });
    expect(svc.getAliveTeams()).toEqual([]);

    adapter.releaseLaunches();
    await expect(cancelledPromise).resolves.toEqual({ runId: cancelledRunId });
    await expect(survivingPromise).resolves.toEqual({ runId: survivingRunId });
    await waitForCondition(() => adapter.launchInputs.length === 2);

    expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
    expect(svc.isTeamAlive(survivingTeamName)).toBe(true);
    expect(svc.getAliveTeams()).toEqual([survivingTeamName]);
    await expect(svc.getProvisioningStatus(cancelledRunId!)).resolves.toMatchObject({
      state: 'cancelled',
    });
    await expect(svc.getProvisioningStatus(survivingRunId!)).resolves.toMatchObject({
      state: 'ready',
      message: 'OpenCode team launch is ready',
    });

    adapter.releaseStops();
    await expect(cancelPromise).resolves.toBeUndefined();
    const cancelledStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
    expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
    const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
    expect(survivingStatuses.teamLaunchState).toBe('clean_success');
    expect(survivingStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('rejects cancel for a ready pure OpenCode runtime adapter team without stopping it', async () => {
    const teamName = 'pure-opencode-cancel-ready-reject-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const { runId } = await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    await expect(svc.cancelProvisioning(runId)).rejects.toThrow(
      'Provisioning cannot be cancelled in current state'
    );
    expect(adapter.stopInputs).toEqual([]);
    expect(svc.isTeamAlive(teamName)).toBe(true);
    const state = await svc.getRuntimeState(teamName);
    expect(state).toMatchObject({
      teamName,
      isAlive: true,
      runId,
      progress: {
        state: 'ready',
        message: 'OpenCode team launch is ready',
      },
    });
  });

  it('does not stop a live OpenCode team when cancelling an unknown run id', async () => {
    const teamName = 'pure-opencode-cancel-unknown-run-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    await expect(svc.cancelProvisioning('missing-run-id')).rejects.toThrow('Unknown runId');

    expect(adapter.stopInputs).toHaveLength(0);
    expect(svc.isTeamAlive(teamName)).toBe(true);
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('stopAllTeams cancels an in-flight pure OpenCode runtime adapter launch without late success resurrecting it', async () => {
    const teamName = 'pure-opencode-stop-all-inflight-runtime-safe-e2e';
    const adapter = new BlockingOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const createPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const runId = adapter.pendingLaunchInputs[0]?.runId;
    expect(runId).toBeTruthy();

    svc.stopAllTeams();

    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId,
      teamName,
      laneId: 'primary',
      providerId: 'opencode',
      reason: 'user_requested',
      force: true,
    });
    await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
      runId,
      teamName,
      state: 'cancelled',
      message: 'Provisioning cancelled by user',
    });
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseLaunches();
    await expect(createPromise).resolves.toEqual({ runId });
    await waitForCondition(() => adapter.launchInputs.length === 1);

    expect(svc.isTeamAlive(teamName)).toBe(false);
    expect(svc.getAliveTeams()).not.toContain(teamName);
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('clean_success');
    expect(statuses.statuses.alice?.launchState).not.toBe('confirmed_alive');
  });

  it('allows a fresh OpenCode launch after stopAllTeams cancelled an in-flight create', async () => {
    const teamName = 'pure-opencode-launch-after-stop-all-cancelled-create-safe-e2e';
    const adapter = new BlockingOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const createPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const cancelledRunId = adapter.pendingLaunchInputs[0]?.runId;
    expect(cancelledRunId).toBeTruthy();

    svc.stopAllTeams();

    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: cancelledRunId,
      teamName,
      laneId: 'primary',
      providerId: 'opencode',
      reason: 'user_requested',
      force: true,
    });
    await expect(svc.getProvisioningStatus(cancelledRunId!)).resolves.toMatchObject({
      runId: cancelledRunId,
      teamName,
      state: 'cancelled',
    });

    adapter.releaseLaunches();
    await expect(createPromise).resolves.toEqual({ runId: cancelledRunId });
    await waitForCondition(() => adapter.launchInputs.length === 1);
    expect(svc.isTeamAlive(teamName)).toBe(false);

    const freshLaunch = await svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );

    expect(freshLaunch.runId).toBeTruthy();
    expect(freshLaunch.runId).not.toBe(cancelledRunId);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    expect(adapter.launchInputs[1]).toMatchObject({
      runId: freshLaunch.runId,
      teamName,
      providerId: 'opencode',
      cwd: projectPath,
    });
    await expect(svc.getProvisioningStatus(freshLaunch.runId)).resolves.toMatchObject({
      runId: freshLaunch.runId,
      teamName,
      state: 'ready',
      message: 'OpenCode team launch is ready',
    });
    expect(svc.isTeamAlive(teamName)).toBe(true);
  });

  it('shows cancelled status immediately when stopAllTeams waits on a slow OpenCode stop', async () => {
    const teamName = 'pure-opencode-stop-all-slow-stop-status-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const createPromise = svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 1);
    const runId = adapter.pendingLaunchInputs[0]?.runId;
    expect(runId).toBeTruthy();

    svc.stopAllTeams();

    await waitForCondition(() => adapter.stopInputs.length === 1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId,
      teamName,
      laneId: 'primary',
      cwd: projectPath,
      reason: 'user_requested',
      force: true,
    });
    await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
      runId,
      teamName,
      state: 'cancelled',
      message: 'Provisioning cancelled by user',
    });
    expect(svc.getAliveTeams()).not.toContain(teamName);

    adapter.releaseLaunches();
    await expect(createPromise).resolves.toEqual({ runId });
    await waitForCondition(() => adapter.launchInputs.length === 1);
    await expect(svc.getProvisioningStatus(runId!)).resolves.toMatchObject({
      runId,
      teamName,
      state: 'cancelled',
    });
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseStops();
    await waitForCondition(() => adapter.stopInputs.length === 1);
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
  });

  it('shows cancelled status immediately for multiple teams when OpenCode stops are slow', async () => {
    const firstTeamName = 'pure-opencode-stop-all-slow-stop-multi-a-safe-e2e';
    const secondTeamName = 'pure-opencode-stop-all-slow-stop-multi-b-safe-e2e';
    const adapter = new BlockingStopOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const firstPromise = svc.createTeam(
      {
        teamName: firstTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    const secondPromise = svc.createTeam(
      {
        teamName: secondTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
    const firstRunId = adapter.pendingLaunchInputs.find(
      (input) => input.teamName === firstTeamName
    )?.runId;
    const secondRunId = adapter.pendingLaunchInputs.find(
      (input) => input.teamName === secondTeamName
    )?.runId;
    expect(firstRunId).toBeTruthy();
    expect(secondRunId).toBeTruthy();

    svc.stopAllTeams();

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.teamName).sort()).toEqual([
      firstTeamName,
      secondTeamName,
    ]);
    expect(adapter.stopInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: firstRunId,
          teamName: firstTeamName,
          laneId: 'primary',
          cwd: projectPath,
          reason: 'user_requested',
          force: true,
        }),
        expect.objectContaining({
          runId: secondRunId,
          teamName: secondTeamName,
          laneId: 'primary',
          cwd: projectPath,
          reason: 'user_requested',
          force: true,
        }),
      ])
    );
    await expect(svc.getProvisioningStatus(firstRunId!)).resolves.toMatchObject({
      runId: firstRunId,
      teamName: firstTeamName,
      state: 'cancelled',
    });
    await expect(svc.getProvisioningStatus(secondRunId!)).resolves.toMatchObject({
      runId: secondRunId,
      teamName: secondTeamName,
      state: 'cancelled',
    });
    expect(svc.getAliveTeams()).toEqual([]);

    adapter.releaseLaunches();
    await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
    await expect(secondPromise).resolves.toEqual({ runId: secondRunId });
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await expect(svc.getProvisioningStatus(firstRunId!)).resolves.toMatchObject({
      state: 'cancelled',
    });
    await expect(svc.getProvisioningStatus(secondRunId!)).resolves.toMatchObject({
      state: 'cancelled',
    });
    expect(svc.getAliveTeams()).toEqual([]);

    adapter.releaseStops();
    await waitForCondition(() => adapter.stopInputs.length === 2);
    await expect(
      readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), firstTeamName)
    ).resolves.toMatchObject({
      lanes: {},
    });
    await expect(
      readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), secondTeamName)
    ).resolves.toMatchObject({
      lanes: {},
    });
  });

  it('stopAllTeams cancels multiple in-flight pure OpenCode launches without cross-team resurrection', async () => {
    const firstTeamName = 'pure-opencode-stop-all-inflight-multi-a-safe-e2e';
    const secondTeamName = 'pure-opencode-stop-all-inflight-multi-b-safe-e2e';
    const adapter = new BlockingOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const firstPromise = svc.createTeam(
      {
        teamName: firstTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    const secondPromise = svc.createTeam(
      {
        teamName: secondTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'bob', role: 'Reviewer', providerId: 'opencode' }],
      },
      () => undefined
    );
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
    const firstRunId = adapter.pendingLaunchInputs.find(
      (input) => input.teamName === firstTeamName
    )?.runId;
    const secondRunId = adapter.pendingLaunchInputs.find(
      (input) => input.teamName === secondTeamName
    )?.runId;
    expect(firstRunId).toBeTruthy();
    expect(secondRunId).toBeTruthy();

    svc.stopAllTeams();

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.teamName).sort()).toEqual([
      firstTeamName,
      secondTeamName,
    ]);
    expect(adapter.stopInputs.map((input) => input.laneId)).toEqual(['primary', 'primary']);
    await expect(svc.getProvisioningStatus(firstRunId!)).resolves.toMatchObject({
      runId: firstRunId,
      teamName: firstTeamName,
      state: 'cancelled',
    });
    await expect(svc.getProvisioningStatus(secondRunId!)).resolves.toMatchObject({
      runId: secondRunId,
      teamName: secondTeamName,
      state: 'cancelled',
    });

    adapter.releaseLaunches();
    await expect(firstPromise).resolves.toEqual({ runId: firstRunId });
    await expect(secondPromise).resolves.toEqual({ runId: secondRunId });
    await waitForCondition(() => adapter.launchInputs.length === 2);

    expect(svc.getAliveTeams()).toEqual([]);
    await expect(
      readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), firstTeamName)
    ).resolves.toMatchObject({
      lanes: {},
    });
    await expect(
      readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), secondTeamName)
    ).resolves.toMatchObject({
      lanes: {},
    });
  });

  it('stops pure OpenCode and mixed secondary runtime teams during stopAllTeams', async () => {
    const pureTeamName = 'pure-opencode-stop-all-safe-e2e';
    const mixedTeamName = 'mixed-opencode-stop-all-safe-e2e';
    await writeMixedTeamConfig({ teamName: mixedTeamName, projectPath });
    await writeTeamMeta(mixedTeamName, projectPath);
    await writeMembersMeta(mixedTeamName);
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await svc.createTeam(
      {
        teamName: pureTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    const mixedRun = createMixedLiveRun({ teamName: mixedTeamName, projectPath });
    mixedRun.child = { kill: () => undefined };
    trackLiveRun(svc, mixedRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(mixedRun);
    await waitForCondition(() => adapter.launchInputs.length === 3);
    await waitForCondition(() =>
      mixedRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    expect(svc.getAliveTeams().sort()).toEqual([mixedTeamName, pureTeamName].sort());

    svc.stopAllTeams();

    await waitForCondition(() => adapter.stopInputs.length === 3);
    await waitForCondition(() => svc.getAliveTeams().length === 0);
    expect(adapter.stopInputs.map((input) => input.teamName).sort()).toEqual([
      mixedTeamName,
      mixedTeamName,
      pureTeamName,
    ]);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'primary',
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
  });

  it('stopAllTeams stops in-flight mixed OpenCode secondary lanes without late failure degrading launch state', async () => {
    const teamName = 'mixed-opencode-stop-all-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new RejectingBlockingOpenCodeRuntimeAdapter('late fake shutdown bridge failure');
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    run.child = { kill: () => undefined };
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopAllTeams();

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.rejectedLaunchCount === 2);

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({ hardFailure: false });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom).toMatchObject({ hardFailure: false });
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
  });

  it('allows fresh mixed OpenCode secondary lanes after stopAllTeams cancelled in-flight handoff', async () => {
    const teamName = 'mixed-opencode-fresh-after-stop-all-cancelled-handoff-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const cancelledRun = createMixedLiveRun({ teamName, projectPath });
    cancelledRun.child = { kill: () => undefined };
    trackLiveRun(svc, cancelledRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopAllTeams();

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );

    const freshRun = createMixedLiveRun({ teamName, projectPath });
    freshRun.runId = `${cancelledRun.runId}-fresh`;
    freshRun.detectedSessionId = 'lead-session-fresh';
    freshRun.child = { kill: () => undefined };
    trackLiveRun(svc, freshRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    const snapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(snapshot).toMatchObject({
      runId: freshRun.runId,
      members: {
        bob: {
          alive: true,
          providerId: 'opencode',
          laneKind: 'secondary',
        },
        tom: {
          alive: true,
          providerId: 'opencode',
          laneKind: 'secondary',
        },
      },
    });
  });

  it('stopAllTeams stops in-flight mixed OpenCode secondary lanes for multiple teams', async () => {
    const firstTeamName = 'mixed-opencode-stop-all-inflight-multi-a-safe-e2e';
    const secondTeamName = 'mixed-opencode-stop-all-inflight-multi-b-safe-e2e';
    await writeMixedTeamConfig({ teamName: firstTeamName, projectPath });
    await writeTeamMeta(firstTeamName, projectPath);
    await writeMembersMeta(firstTeamName);
    await writeMixedTeamConfig({ teamName: secondTeamName, projectPath });
    await writeTeamMeta(secondTeamName, projectPath);
    await writeMembersMeta(secondTeamName);
    const adapter = new RejectingBlockingOpenCodeRuntimeAdapter('late fake multi shutdown failure');
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const firstRun = createMixedLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createMixedLiveRun({ teamName: secondTeamName, projectPath });
    firstRun.child = { kill: () => undefined };
    secondRun.child = { kill: () => undefined };
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(firstRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(secondRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 4);

    svc.stopAllTeams();

    await waitForCondition(() => adapter.stopInputs.length === 4);
    expect(adapter.stopInputs.map((input) => input.teamName).sort()).toEqual([
      firstTeamName,
      firstTeamName,
      secondTeamName,
      secondTeamName,
    ]);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:bob',
      'secondary:opencode:tom',
      'secondary:opencode:tom',
    ]);
    expect(svc.getAliveTeams()).toEqual([]);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.rejectedLaunchCount === 4);

    await expect(
      readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), firstTeamName)
    ).resolves.toMatchObject({
      lanes: {},
    });
    await expect(
      readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), secondTeamName)
    ).resolves.toMatchObject({
      lanes: {},
    });
    const firstStatuses = await svc.getMemberSpawnStatuses(firstTeamName);
    const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
    expect(firstStatuses.teamLaunchState).not.toBe('partial_failure');
    expect(secondStatuses.teamLaunchState).not.toBe('partial_failure');
    expect(firstStatuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(firstStatuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    expect(secondStatuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(secondStatuses.statuses.tom?.launchState).not.toBe('failed_to_start');
  });

  it('recovers mixed Codex/OpenCode launch truth from persisted state after service restart', async () => {
    const teamName = 'mixed-persisted-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['perm-tom'],
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.tom).toMatchObject({
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['perm-tom'],
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.providerBackendId).toBe('codex-native');
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      laneKind: 'primary',
      runtimeModel: 'gpt-5.4-mini',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('recovers mixed Anthropic/OpenCode launch truth from persisted state after service restart', async () => {
    const teamName = 'mixed-persisted-anthropic-opencode-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('does not resurrect removed OpenCode secondary teammates in mixed Anthropic launch recovery', async () => {
    const teamName = 'mixed-anthropic-removed-opencode-stale-state-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic', removedMembers: ['tom'] });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'stale removed OpenCode lane failure',
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 0,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toBeUndefined();

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toBeUndefined();
  });

  it('keeps active suffixed OpenCode secondary teammates in mixed Anthropic recovery', async () => {
    const teamName = 'mixed-anthropic-suffixed-opencode-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      primaryProviderId: 'anthropic',
      removedMembers: ['bob', 'tom'],
      extraMembers: [
        {
          name: 'bob-2',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
        },
      ],
    });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        'bob-2': mixedMemberState({
          name: 'bob-2',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob-2',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses.tom).toBeUndefined();
    expect(statuses.statuses['bob-2']).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toBeUndefined();
    expect(runtimeSnapshot.members.tom).toBeUndefined();
    expect(runtimeSnapshot.members['bob-2']).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
  });

  it('ignores stale active OpenCode lane index entries for removed teammates in mixed Anthropic recovery', async () => {
    const teamName = 'mixed-anthropic-removed-stale-lane-index-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      primaryProviderId: 'anthropic',
      removedMembers: ['bob', 'tom'],
    });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses.tom).toBeUndefined();

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toBeUndefined();
    expect(runtimeSnapshot.members.tom).toBeUndefined();
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );
  });

  it('recovers pure Anthropic status and model metadata from persisted state after service restart', async () => {
    const teamName = 'pure-persisted-anthropic-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 0,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'sonnet',
    });
  });

  it('recovers pure Anthropic partial failure from persisted state after service restart', async () => {
    const teamName = 'pure-persisted-anthropic-failure-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Anthropic pane exited before bootstrap',
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Anthropic pane exited before bootstrap',
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'sonnet',
    });
  });

  it('does not resurrect removed pure Anthropic teammates from stale persisted launch state', async () => {
    const teamName = 'pure-anthropic-removed-member-stale-state-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
    await writePureAnthropicTeamLaunchState({
      teamName,
      expectedMembers: ['alice', 'bob'],
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'stale removed member failure',
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toBeUndefined();

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toBeUndefined();
  });

  it('keeps active suffixed pure Anthropic teammates when the removed base member is stale', async () => {
    const teamName = 'pure-anthropic-suffixed-active-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName, {
      removedMembers: ['bob'],
      extraMembers: [{ name: 'bob-2', providerId: 'anthropic', model: 'sonnet' }],
    });
    await writePureAnthropicTeamLaunchState({
      teamName,
      expectedMembers: ['alice', 'bob-2'],
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        'bob-2': mixedMemberState({
          name: 'bob-2',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses['bob-2']).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toBeUndefined();
    expect(runtimeSnapshot.members['bob-2']).toMatchObject({
      providerId: 'anthropic',
      runtimeModel: 'sonnet',
    });
  });

  it('filters removed pure Anthropic teammates from bootstrap-only launch recovery', async () => {
    const teamName = 'pure-anthropic-removed-bootstrap-state-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
    await writeBootstrapState(teamName, [
      {
        name: 'alice',
        status: 'bootstrap_confirmed',
        lastAttemptAt: Date.parse('2026-04-23T10:00:00.000Z'),
        lastObservedAt: Date.parse('2026-04-23T10:00:05.000Z'),
      },
      {
        name: 'bob',
        status: 'failed',
        lastAttemptAt: Date.parse('2026-04-23T10:00:00.000Z'),
        lastObservedAt: Date.parse('2026-04-23T10:00:04.000Z'),
        failureReason: 'stale removed bootstrap failure',
      },
    ]);

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toBeUndefined();
  });

  it('recovers pure Anthropic runtime-pending bootstrap from persisted state after service restart', async () => {
    const teamName = 'pure-persisted-anthropic-bootstrap-pending-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('recovers pure Anthropic runtime-pending permission from persisted state after service restart', async () => {
    const teamName = 'pure-persisted-anthropic-permission-pending-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['perm-bob'],
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      runtimeAlive: false,
      pendingPermissionRequestIds: ['perm-bob'],
      hardFailure: false,
    });
  });

  it('keeps active pure Anthropic starting teammates pending after service restart', async () => {
    const teamName = 'pure-active-anthropic-starting-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.launchPhase).toBe('active');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      hardFailure: false,
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'anthropic',
      alive: false,
      runtimeModel: 'sonnet',
    });
  });

  it('fails finished pure Anthropic starting teammates after service restart', async () => {
    const teamName = 'pure-finished-anthropic-never-spawned-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'finished',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.launchPhase).toBe('finished');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      hardFailure: true,
      hardFailureReason: 'Teammate was never spawned during launch.',
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'anthropic',
      alive: false,
      runtimeModel: 'sonnet',
    });
  });

  it('keeps active pure Anthropic missing member state pending after service restart', async () => {
    const teamName = 'pure-active-anthropic-missing-state-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      expectedMembers: ['alice', 'bob'],
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.launchPhase).toBe('active');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      hardFailure: false,
    });
  });

  it('fails finished pure Anthropic missing member state after service restart', async () => {
    const teamName = 'pure-finished-anthropic-missing-state-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'finished',
      expectedMembers: ['alice', 'bob'],
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.launchPhase).toBe('finished');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      hardFailure: true,
      hardFailureReason: 'Teammate was never spawned during launch.',
    });
  });

  it('recovers legacy pure Anthropic partial launch marker without leaving missing teammates joining', async () => {
    const teamName = 'legacy-pure-anthropic-partial-marker-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writeLegacyPartialLaunchState({
      teamName,
      expectedMembers: ['alice', 'bob'],
      confirmedMembers: ['alice'],
      missingMembers: ['bob'],
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.launchPhase).toBe('reconciled');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Legacy partial launch marker reported teammate missing.',
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'anthropic',
      alive: false,
      runtimeModel: 'sonnet',
    });
  });

  it('keeps finished pure Anthropic runtime-pending bootstrap teammates pending after service restart', async () => {
    const teamName = 'pure-finished-anthropic-bootstrap-pending-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'finished',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.launchPhase).toBe('finished');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('keeps finished pure Anthropic runtime-pending permission teammates pending after service restart', async () => {
    const teamName = 'pure-finished-anthropic-permission-pending-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'finished',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['perm-bob'],
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.launchPhase).toBe('finished');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      agentToolAccepted: true,
      runtimeAlive: false,
      pendingPermissionRequestIds: ['perm-bob'],
      hardFailure: false,
    });
  });

  it('recovers mixed Anthropic and Gemini failure with split OpenCode lane truth after service restart', async () => {
    const teamName = 'mixed-persisted-anthropic-gemini-failure-opencode-split-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        reviewer: mixedMemberState({
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'gemini',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Gemini pane exited before bootstrap',
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['perm-tom'],
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'reviewer', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Gemini pane exited before bootstrap',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      hardFailure: false,
      pendingPermissionRequestIds: ['perm-tom'],
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.reviewer).toMatchObject({
      providerId: 'gemini',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'gemini-2.5-flash',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('recovers mixed Gemini failure and split OpenCode lane truth after service restart', async () => {
    const teamName = 'mixed-persisted-gemini-failure-opencode-split-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, includeGeminiPrimary: true });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName, { includeGeminiPrimary: true });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        reviewer: mixedMemberState({
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'gemini',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Gemini pane exited before bootstrap',
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['perm-tom'],
        }),
      },
    });

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'reviewer', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Gemini pane exited before bootstrap',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      hardFailure: false,
      pendingPermissionRequestIds: ['perm-tom'],
    });

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.reviewer).toMatchObject({
      providerId: 'gemini',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'gemini-2.5-flash',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('exposes shared OpenCode side-lane runtime memory in the team runtime snapshot', async () => {
    const teamName = 'mixed-opencode-runtime-memory-safe-e2e';
    const sharedHostPid = 24_242;
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      ]);
    (svc as any).readProcessRssBytesByPid = async () =>
      new Map([[sharedHostPid, 183.9 * 1024 * 1024]]);

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/minimax-m2.5-free',
      rssBytes: 183.9 * 1024 * 1024,
    });
    expect(runtimeSnapshot.members.bob.providerBackendId).toBeUndefined();
  });

  it('keeps OpenCode side-lane pid and memory visible after mixed failure recovery', async () => {
    const teamName = 'mixed-gemini-failure-opencode-memory-safe-e2e';
    const sharedHostPid = 31_313;
    const sharedRssBytes = 211.4 * 1024 * 1024;
    await writeMixedTeamConfig({ teamName, projectPath, includeGeminiPrimary: true });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName, { includeGeminiPrimary: true });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        reviewer: mixedMemberState({
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'gemini',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Gemini pane exited before bootstrap',
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['perm-tom'],
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/minimax-m2.5-free',
          },
        ],
        [
          'tom',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/nemotron-3-super-free',
          },
        ],
      ]);
    (svc as any).readProcessRssBytesByPid = async () => new Map([[sharedHostPid, sharedRssBytes]]);

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

    expect(runtimeSnapshot.members.reviewer).toMatchObject({
      providerId: 'gemini',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'gemini-2.5-flash',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/minimax-m2.5-free',
      rssBytes: sharedRssBytes,
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/nemotron-3-super-free',
      rssBytes: sharedRssBytes,
    });
  });

  it('keeps OpenCode side-lane pid and memory visible after Anthropic mixed recovery', async () => {
    const teamName = 'mixed-anthropic-opencode-memory-safe-e2e';
    const sharedHostPid = 41_414;
    const sharedRssBytes = 207.6 * 1024 * 1024;
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['perm-tom'],
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/minimax-m2.5-free',
          },
        ],
        [
          'tom',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/nemotron-3-super-free',
          },
        ],
      ]);
    (svc as any).readProcessRssBytesByPid = async () => new Map([[sharedHostPid, sharedRssBytes]]);

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/minimax-m2.5-free',
      rssBytes: sharedRssBytes,
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/nemotron-3-super-free',
      rssBytes: sharedRssBytes,
    });
  });

  it('keeps OpenCode side-lane pid and memory visible after Anthropic and Gemini mixed failure recovery', async () => {
    const teamName = 'mixed-anthropic-gemini-failure-opencode-memory-safe-e2e';
    const sharedHostPid = 51_515;
    const sharedRssBytes = 219.2 * 1024 * 1024;
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        reviewer: mixedMemberState({
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'gemini',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Gemini pane exited before bootstrap',
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['perm-tom'],
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/minimax-m2.5-free',
          },
        ],
        [
          'tom',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/nemotron-3-super-free',
          },
        ],
      ]);
    (svc as any).readProcessRssBytesByPid = async () => new Map([[sharedHostPid, sharedRssBytes]]);

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.reviewer).toMatchObject({
      providerId: 'gemini',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'gemini-2.5-flash',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/minimax-m2.5-free',
      rssBytes: sharedRssBytes,
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/nemotron-3-super-free',
      rssBytes: sharedRssBytes,
    });
  });

  it('infers OpenCode runtime provider from model after restart when provider metadata is missing', async () => {
    const teamName = 'mixed-opencode-model-inference-safe-e2e';
    const sharedHostPid = 24_243;
    await writeMixedTeamConfigWithoutOpenCodeProviderMetadata({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    const restartedService = new TeamProvisioningService();
    (restartedService as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      ]);
    (restartedService as any).readProcessRssBytesByPid = async () =>
      new Map([[sharedHostPid, 188.4 * 1024 * 1024]]);

    const runtimeSnapshot = await restartedService.getTeamAgentRuntimeSnapshot(teamName);

    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/minimax-m2.5-free',
      rssBytes: 188.4 * 1024 * 1024,
    });
    expect(runtimeSnapshot.members.bob.providerBackendId).toBeUndefined();
  });

  it('clears stale never-spawned OpenCode side-lane failures when live runtime metadata proves the member is alive', async () => {
    const teamName = 'mixed-opencode-stale-failure-clears-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Teammate was never spawned during launch.',
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            model: 'opencode/minimax-m2.5-free',
            livenessKind: 'runtime_process',
          },
        ],
      ]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 1,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      hardFailure: false,
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(statuses.statuses.bob.hardFailureReason).toBeUndefined();
    expect(statuses.statuses.bob.error).toBeUndefined();
  });

  it('promotes starting OpenCode side-lane members to runtime-pending when live metadata sees the process', async () => {
    const teamName = 'mixed-opencode-starting-promotes-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            model: 'opencode/minimax-m2.5-free',
            livenessKind: 'runtime_process',
          },
        ],
      ]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 1,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      livenessSource: 'process',
      hardFailure: false,
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
  });

  it('does not clear definitive OpenCode side-lane failures from unrelated live runtime metadata', async () => {
    const teamName = 'mixed-opencode-definitive-failure-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'OpenCode raw model id "minimax-m2.5-free" was not found.',
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      ]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      failedCount: 1,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      runtimeAlive: false,
      hardFailure: true,
      hardFailureReason: 'OpenCode raw model id "minimax-m2.5-free" was not found.',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
  });

  it('runs mixed live secondary OpenCode lanes and preserves primary Codex status', async () => {
    const teamName = 'mixed-live-lanes-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'permission',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    const initialSnapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(initialSnapshot).toMatchObject({
      teamName,
      launchPhase: 'active',
      teamLaunchState: 'partial_pending',
    });
    expect(initialSnapshot.members.alice).toMatchObject({
      providerId: 'codex',
      laneKind: 'primary',
      launchState: 'confirmed_alive',
    });
    expect(initialSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      launchState: 'starting',
    });

    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_permission'
    );

    expect(adapter.launchInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(adapter.launchInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          laneId: 'secondary:opencode:bob',
          model: 'opencode/minimax-m2.5-free',
          expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
        }),
        expect.objectContaining({
          laneId: 'secondary:opencode:tom',
          model: 'opencode/nemotron-3-super-free',
          expectedMembers: [expect.objectContaining({ name: 'tom', providerId: 'opencode' })],
        }),
      ])
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      runtimeAlive: false,
      pendingPermissionRequestIds: ['perm-tom'],
    });
  });

  it('keeps mixed launch pending while Codex primary is still joining and OpenCode lanes are ready', async () => {
    const teamName = 'mixed-codex-starting-opencode-ready-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);
    run.memberSpawnStatuses.set('alice', {
      status: 'starting',
      launchState: 'starting',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
  });

  it('keeps Anthropic mixed launch pending while primary is still joining and OpenCode lanes are ready', async () => {
    const teamName = 'mixed-anthropic-starting-opencode-ready-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);
    run.memberSpawnStatuses.set('alice', {
      status: 'starting',
      launchState: 'starting',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
  });

  it('keeps Anthropic mixed launch pending while primary awaits permission and OpenCode lanes are ready', async () => {
    const teamName = 'mixed-anthropic-permission-opencode-ready-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);
    run.memberSpawnStatuses.set('alice', {
      status: 'online',
      launchState: 'runtime_pending_permission',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: false,
      hardFailure: false,
      pendingPermissionRequestIds: ['perm-alice'],
      lastRuntimeAliveAt: '2026-04-23T10:00:00.000Z',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      pendingPermissionRequestIds: ['perm-alice'],
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
  });

  it('keeps Anthropic primary online while mixed OpenCode lanes split ready and bootstrap pending', async () => {
    const teamName = 'mixed-anthropic-opencode-split-bootstrap-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'launching',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_bootstrap'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      alive: true,
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      alive: true,
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      alive: false,
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('keeps mixed Anthropic launch partial when Gemini primary fails and OpenCode lanes split ready and bootstrap pending', async () => {
    const teamName = 'mixed-anthropic-gemini-failed-opencode-split-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'launching',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const reviewer = {
      name: 'reviewer',
      role: 'Reviewer',
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
    };
    run.expectedMembers = ['alice', 'reviewer'];
    run.effectiveMembers = [...run.effectiveMembers, reviewer];
    run.allEffectiveMembers = [
      ...run.effectiveMembers,
      ...run.allEffectiveMembers.filter(
        (member: { providerId?: string }) => member.providerId === 'opencode'
      ),
    ];
    run.memberSpawnStatuses.set('reviewer', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Gemini pane exited before bootstrap',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_bootstrap'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 1,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Gemini pane exited before bootstrap',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      alive: true,
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.reviewer).toMatchObject({
      providerId: 'gemini',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'gemini-2.5-flash',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      alive: true,
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneKind: 'secondary',
      alive: false,
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('keeps OpenCode side-lane pid and memory visible during mixed Anthropic launch when Gemini failed and a sibling lane is still bootstrapping', async () => {
    const teamName = 'mixed-anthropic-gemini-bootstrap-memory-safe-e2e';
    const sharedHostPid = 52_525;
    const sharedRssBytes = 221.7 * 1024 * 1024;
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'launching',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const reviewer = {
      name: 'reviewer',
      role: 'Reviewer',
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
    };
    run.expectedMembers = ['alice', 'reviewer'];
    run.effectiveMembers = [...run.effectiveMembers, reviewer];
    run.allEffectiveMembers = [
      ...run.effectiveMembers,
      ...run.allEffectiveMembers.filter(
        (member: { providerId?: string }) => member.providerId === 'opencode'
      ),
    ];
    run.memberSpawnStatuses.set('reviewer', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Gemini pane exited before bootstrap',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_bootstrap'
    );

    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/minimax-m2.5-free',
          },
        ],
        [
          'tom',
          {
            alive: true,
            metricsPid: sharedHostPid,
            model: 'opencode/nemotron-3-super-free',
          },
        ],
      ]);
    (svc as any).readProcessRssBytesByPid = async () => new Map([[sharedHostPid, sharedRssBytes]]);

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);

    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.reviewer).toMatchObject({
      providerId: 'gemini',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'gemini-2.5-flash',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/minimax-m2.5-free',
      rssBytes: sharedRssBytes,
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      alive: true,
      restartable: false,
      pid: sharedHostPid,
      runtimeModel: 'opencode/nemotron-3-super-free',
      rssBytes: sharedRssBytes,
    });
  });

  it('keeps mixed launch partial when Gemini primary fails and OpenCode lanes split ready and pending', async () => {
    const teamName = 'mixed-gemini-failed-opencode-split-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, includeGeminiPrimary: true });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'permission',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    const reviewer = {
      name: 'reviewer',
      role: 'Reviewer',
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
    };
    run.expectedMembers = ['alice', 'reviewer'];
    run.effectiveMembers = [...run.effectiveMembers, reviewer];
    run.allEffectiveMembers = [
      ...run.effectiveMembers,
      ...run.allEffectiveMembers.filter(
        (member: { providerId?: string }) => member.providerId === 'opencode'
      ),
    ];
    run.memberSpawnStatuses.set('reviewer', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Gemini pane exited before bootstrap',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_permission'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Gemini pane exited before bootstrap',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      hardFailure: false,
      pendingPermissionRequestIds: ['perm-tom'],
    });
  });

  it('keeps Codex primary online when a mixed OpenCode secondary lane fails', async () => {
    const teamName = 'mixed-live-secondary-failure-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'failed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'fake_open_code_launch_failure',
    });
  });

  it('keeps Anthropic primary online when a mixed OpenCode secondary lane fails', async () => {
    const teamName = 'mixed-anthropic-secondary-failure-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'failed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'fake_open_code_launch_failure',
    });

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      alive: true,
      runtimeModel: 'haiku',
    });
  });

  it('does not expose removed OpenCode secondary teammates from live mixed Anthropic launch status', async () => {
    const teamName = 'mixed-anthropic-live-removed-secondary-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      primaryProviderId: 'anthropic',
      removedMembers: ['bob'],
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'tom']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 0,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toBeUndefined();

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
    expect(runtimeSnapshot.members.bob).toBeUndefined();
  });

  it('does not re-add removed OpenCode secondary teammates from stale live runtime metadata in mixed Anthropic status', async () => {
    const teamName = 'mixed-anthropic-stale-live-metadata-removed-secondary-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      primaryProviderId: 'anthropic',
      removedMembers: ['bob'],
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob',
          {
            alive: true,
            metricsPid: 44_001,
            model: 'opencode/minimax-m2.5-free',
          },
        ],
        [
          'tom',
          {
            alive: true,
            metricsPid: 44_002,
            model: 'opencode/nemotron-3-super-free',
          },
        ],
      ]);
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'tom']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toBeUndefined();

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
    expect(runtimeSnapshot.members.bob).toBeUndefined();
  });

  it('does not expose removed pure Anthropic teammates from live launch status', async () => {
    const teamName = 'pure-anthropic-live-removed-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toBeUndefined();

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toBeUndefined();
  });

  it('does not re-add removed pure Anthropic teammates from stale live runtime metadata', async () => {
    const teamName = 'pure-anthropic-stale-live-metadata-removed-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'alice',
          {
            alive: true,
            model: 'haiku',
          },
        ],
        [
          'bob',
          {
            alive: true,
            model: 'sonnet',
          },
        ],
      ]);
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toBeUndefined();

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toBeUndefined();
  });

  it('does not map stale base Anthropic runtime metadata onto an active suffixed Anthropic teammate', async () => {
    const teamName = 'pure-anthropic-stale-base-runtime-suffixed-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName, {
      removedMembers: ['bob'],
      extraMembers: [{ name: 'bob-2', providerId: 'anthropic', model: 'sonnet' }],
    });
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      expectedMembers: ['alice', 'bob-2'],
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        'bob-2': mixedMemberState({
          name: 'bob-2',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, model: 'haiku' }],
        ['bob', { alive: true, model: 'sonnet' }],
      ]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses['bob-2']).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      runtimeAlive: false,
      hardFailure: false,
    });
  });

  it('does not map stale base OpenCode runtime metadata onto an active suffixed teammate in mixed Anthropic recovery', async () => {
    const teamName = 'mixed-anthropic-stale-base-runtime-suffixed-opencode-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      primaryProviderId: 'anthropic',
      removedMembers: ['bob'],
      extraMembers: [
        {
          name: 'bob-2',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
        },
      ],
    });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        'bob-2': mixedMemberState({
          name: 'bob-2',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob-2',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, model: 'haiku' }],
        ['bob', { alive: true, model: 'opencode/minimax-m2.5-free' }],
      ]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses['bob-2']).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      runtimeAlive: false,
      hardFailure: false,
    });
  });

  it('maps suffixed Anthropic runtime metadata onto the canonical pure Anthropic teammate', async () => {
    const teamName = 'pure-anthropic-suffixed-runtime-canonical-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      expectedMembers: ['alice', 'bob'],
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, model: 'haiku', livenessKind: 'confirmed_bootstrap' }],
        ['bob-2', { alive: true, model: 'sonnet', livenessKind: 'runtime_process' }],
      ]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      hardFailure: false,
      livenessSource: 'process',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'anthropic',
      alive: true,
      runtimeModel: 'sonnet',
    });
    expect(runtimeSnapshot.members['bob-2']).toBeUndefined();
  });

  it('maps suffixed OpenCode runtime metadata onto the canonical mixed Anthropic teammate', async () => {
    const teamName = 'mixed-anthropic-suffixed-runtime-canonical-opencode-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, model: 'haiku', livenessKind: 'confirmed_bootstrap' }],
        [
          'bob-2',
          {
            alive: true,
            model: 'opencode/minimax-m2.5-free',
            livenessKind: 'runtime_process',
          },
        ],
      ]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      hardFailure: false,
      livenessSource: 'process',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      alive: true,
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members['bob-2']).toBeUndefined();
  });

  it('maps suffixed lead inbox heartbeat onto the canonical pure Anthropic teammate', async () => {
    const teamName = 'pure-anthropic-suffixed-heartbeat-canonical-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: '2026-04-23T10:00:10.000Z',
        messageId: 'msg-bob-2-heartbeat',
      },
    ]);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.memberSpawnStatuses.set('bob', {
      status: 'spawning',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    trackLiveRun(svc, run);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      livenessSource: 'heartbeat',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('does not map stale base lead inbox heartbeat onto an active suffixed pure Anthropic teammate', async () => {
    const teamName = 'pure-anthropic-stale-base-heartbeat-suffixed-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName, {
      removedMembers: ['bob'],
      extraMembers: [{ name: 'bob-2', providerId: 'anthropic', model: 'sonnet' }],
    });
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      expectedMembers: ['alice', 'bob-2'],
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        'bob-2': mixedMemberState({
          name: 'bob-2',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob',
        text: 'heartbeat',
        timestamp: '2026-04-23T10:00:10.000Z',
        messageId: 'msg-stale-bob-heartbeat',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses['bob-2']).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('maps suffixed lead inbox heartbeat onto the canonical mixed Anthropic OpenCode teammate', async () => {
    const teamName = 'mixed-anthropic-suffixed-heartbeat-canonical-opencode-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: '2026-04-23T10:00:10.000Z',
        messageId: 'msg-mixed-bob-2-heartbeat',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      livenessSource: 'heartbeat',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('does not map stale base lead inbox heartbeat onto an active suffixed mixed Anthropic teammate', async () => {
    const teamName = 'mixed-anthropic-stale-base-heartbeat-suffixed-opencode-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      primaryProviderId: 'anthropic',
      removedMembers: ['bob'],
      extraMembers: [
        {
          name: 'bob-2',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
        },
      ],
    });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        'bob-2': mixedMemberState({
          name: 'bob-2',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob-2',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob',
        text: 'heartbeat',
        timestamp: '2026-04-23T10:00:10.000Z',
        messageId: 'msg-mixed-stale-bob-heartbeat',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses['bob-2']).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('maps suffixed lead inbox bootstrap failure onto the canonical pure Anthropic teammate', async () => {
    const teamName = 'pure-anthropic-suffixed-failure-canonical-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: '2026-04-23T10:00:00.000Z',
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: '2026-04-23T10:00:10.000Z',
        messageId: 'msg-bob-2-bootstrap-failed',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Bootstrap failed: unsupported model',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('does not map stale base lead inbox bootstrap failure onto an active suffixed pure Anthropic teammate', async () => {
    const teamName = 'pure-anthropic-stale-base-failure-suffixed-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName, {
      removedMembers: ['bob'],
      extraMembers: [{ name: 'bob-2', providerId: 'anthropic', model: 'sonnet' }],
    });
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      expectedMembers: ['alice', 'bob-2'],
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        'bob-2': mixedMemberState({
          name: 'bob-2',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob',
        text: 'Bootstrap failed: unsupported model',
        timestamp: '2026-04-23T10:00:10.000Z',
        messageId: 'msg-stale-bob-bootstrap-failed',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses['bob-2']).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('maps suffixed lead inbox bootstrap failure onto the canonical mixed Anthropic OpenCode teammate', async () => {
    const teamName = 'mixed-anthropic-suffixed-failure-canonical-opencode-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: '2026-04-23T10:00:00.000Z',
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: '2026-04-23T10:00:10.000Z',
        messageId: 'msg-mixed-bob-2-bootstrap-failed',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Bootstrap failed: unsupported model',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('does not map stale base lead inbox bootstrap failure onto an active suffixed mixed Anthropic teammate', async () => {
    const teamName = 'mixed-anthropic-stale-base-failure-suffixed-opencode-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      primaryProviderId: 'anthropic',
      removedMembers: ['bob'],
      extraMembers: [
        {
          name: 'bob-2',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
        },
      ],
    });
    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        'bob-2': mixedMemberState({
          name: 'bob-2',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob-2',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob',
        text: 'Bootstrap failed: unsupported model',
        timestamp: '2026-04-23T10:00:10.000Z',
        messageId: 'msg-mixed-stale-bob-bootstrap-failed',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob-2']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses['bob-2']).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('ignores stale suffixed lead inbox heartbeat from an older pure Anthropic launch attempt', async () => {
    const teamName = 'pure-anthropic-old-suffixed-heartbeat-current-attempt-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 1_000).toISOString();
    const staleMessageAt = new Date(Date.now() - 2_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: staleMessageAt,
        messageId: 'msg-old-bob-2-heartbeat',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('ignores stale suffixed lead inbox bootstrap failure from an older pure Anthropic launch attempt', async () => {
    const teamName = 'pure-anthropic-old-suffixed-failure-current-attempt-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 1_000).toISOString();
    const staleMessageAt = new Date(Date.now() - 2_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: staleMessageAt,
        messageId: 'msg-old-bob-2-bootstrap-failed',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('ignores stale suffixed lead inbox heartbeat from an older mixed Anthropic OpenCode launch attempt', async () => {
    const teamName = 'mixed-anthropic-old-suffixed-heartbeat-current-opencode-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 1_000).toISOString();
    const staleMessageAt = new Date(Date.now() - 2_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: staleMessageAt,
        messageId: 'msg-mixed-old-bob-2-heartbeat',
      },
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('ignores stale suffixed lead inbox bootstrap failure from an older mixed Anthropic OpenCode launch attempt', async () => {
    const teamName = 'mixed-anthropic-old-suffixed-failure-current-opencode-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 1_000).toISOString();
    const staleMessageAt = new Date(Date.now() - 2_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: staleMessageAt,
        messageId: 'msg-mixed-old-bob-2-bootstrap-failed',
      },
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('uses newer suffixed heartbeat over older pure Anthropic bootstrap failure during persisted reconcile', async () => {
    const teamName = 'pure-anthropic-newer-heartbeat-over-old-failure-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 3_000).toISOString();
    const olderSignalAt = new Date(Date.now() - 2_000).toISOString();
    const newerSignalAt = new Date(Date.now() - 1_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: olderSignalAt,
        messageId: 'msg-old-failure-before-heartbeat',
      },
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: newerSignalAt,
        messageId: 'msg-new-heartbeat-after-failure',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: newerSignalAt,
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('uses newer suffixed bootstrap failure over older pure Anthropic heartbeat during persisted reconcile', async () => {
    const teamName = 'pure-anthropic-newer-failure-over-old-heartbeat-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 3_000).toISOString();
    const olderSignalAt = new Date(Date.now() - 2_000).toISOString();
    const newerSignalAt = new Date(Date.now() - 1_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: olderSignalAt,
        messageId: 'msg-old-heartbeat-before-failure',
      },
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: newerSignalAt,
        messageId: 'msg-new-failure-after-heartbeat',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Bootstrap failed: unsupported model',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('uses newer suffixed heartbeat over older mixed Anthropic OpenCode bootstrap failure during persisted reconcile', async () => {
    const teamName = 'mixed-anthropic-newer-heartbeat-over-old-failure-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 3_000).toISOString();
    const olderSignalAt = new Date(Date.now() - 2_000).toISOString();
    const newerSignalAt = new Date(Date.now() - 1_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: olderSignalAt,
        messageId: 'msg-mixed-old-failure-before-heartbeat',
      },
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: newerSignalAt,
        messageId: 'msg-mixed-new-heartbeat-after-failure',
      },
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: newerSignalAt,
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('uses newer suffixed bootstrap failure over older mixed Anthropic OpenCode heartbeat during persisted reconcile', async () => {
    const teamName = 'mixed-anthropic-newer-failure-over-old-heartbeat-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 3_000).toISOString();
    const olderSignalAt = new Date(Date.now() - 2_000).toISOString();
    const newerSignalAt = new Date(Date.now() - 1_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: olderSignalAt,
        messageId: 'msg-mixed-old-heartbeat-before-failure',
      },
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: newerSignalAt,
        messageId: 'msg-mixed-new-failure-after-heartbeat',
      },
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Bootstrap failed: unsupported model',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('uses greater same-timestamp heartbeat messageId over pure Anthropic bootstrap failure during persisted reconcile', async () => {
    const teamName = 'pure-anthropic-same-time-heartbeat-wins-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 2_000).toISOString();
    const signalAt = new Date(Date.now() - 1_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: signalAt,
        messageId: 'msg-001-same-time-failure',
      },
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: signalAt,
        messageId: 'msg-002-same-time-heartbeat',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: signalAt,
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('uses greater same-timestamp bootstrap failure messageId over pure Anthropic heartbeat during persisted reconcile', async () => {
    const teamName = 'pure-anthropic-same-time-failure-wins-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 2_000).toISOString();
    const signalAt = new Date(Date.now() - 1_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: signalAt,
        messageId: 'msg-001-same-time-heartbeat',
      },
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: signalAt,
        messageId: 'msg-002-same-time-failure',
      },
    ]);

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Bootstrap failed: unsupported model',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('uses greater same-timestamp heartbeat messageId over mixed Anthropic OpenCode bootstrap failure during persisted reconcile', async () => {
    const teamName = 'mixed-anthropic-same-time-heartbeat-wins-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 2_000).toISOString();
    const signalAt = new Date(Date.now() - 1_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: signalAt,
        messageId: 'msg-mixed-001-same-time-failure',
      },
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: signalAt,
        messageId: 'msg-mixed-002-same-time-heartbeat',
      },
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: signalAt,
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('uses greater same-timestamp bootstrap failure messageId over mixed Anthropic OpenCode heartbeat during persisted reconcile', async () => {
    const teamName = 'mixed-anthropic-same-time-failure-wins-safe-e2e';
    const firstSpawnAcceptedAt = new Date(Date.now() - 2_000).toISOString();
    const signalAt = new Date(Date.now() - 1_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt,
        }),
      },
    });
    await writeLeadInboxMessages(teamName, [
      {
        from: 'bob-2',
        text: 'heartbeat',
        timestamp: signalAt,
        messageId: 'msg-mixed-001-same-time-heartbeat',
      },
      {
        from: 'bob-2',
        text: 'Bootstrap failed: unsupported model',
        timestamp: signalAt,
        messageId: 'msg-mixed-002-same-time-failure',
      },
    ]);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([new FakeOpenCodeRuntimeAdapter()])
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Bootstrap failed: unsupported model',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('clears false never-spawned pure Anthropic failure when live runtime proves the teammate exists', async () => {
    const teamName = 'pure-anthropic-never-spawned-live-runtime-recovered-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Teammate was never spawned during launch.',
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, model: 'haiku', livenessKind: 'confirmed_bootstrap' }],
        ['bob-2', { alive: true, model: 'sonnet', livenessKind: 'runtime_process' }],
      ]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: false,
      hardFailure: false,
      livenessSource: 'process',
      runtimeModel: 'sonnet',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('does not clear explicit pure Anthropic bootstrap failure just because runtime metadata is alive', async () => {
    const teamName = 'pure-anthropic-hard-failure-live-runtime-not-cleared-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Bootstrap failed: unsupported model',
          firstSpawnAcceptedAt: '2026-04-23T10:00:00.000Z',
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, model: 'haiku' }],
        ['bob-2', { alive: true, model: 'sonnet' }],
      ]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Bootstrap failed: unsupported model',
      runtimeModel: 'sonnet',
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('clears false never-spawned Anthropic primary failure in mixed launch when live runtime is alive', async () => {
    const teamName = 'mixed-anthropic-never-spawned-primary-live-runtime-recovered-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Teammate was never spawned during launch.',
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          name: 'tom',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([['alice', { alive: true, model: 'haiku', livenessKind: 'runtime_process' }]]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 0,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: false,
      hardFailure: false,
      livenessSource: 'process',
      runtimeModel: 'haiku',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('does not clear explicit Anthropic primary bootstrap failure in mixed launch when runtime metadata is alive', async () => {
    const teamName = 'mixed-anthropic-hard-primary-failure-live-runtime-not-cleared-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Bootstrap failed: unsupported model',
          firstSpawnAcceptedAt: '2026-04-23T10:00:00.000Z',
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          name: 'tom',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    const svc = new TeamProvisioningService();
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([['alice', { alive: true, model: 'haiku' }]]);

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 0,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Bootstrap failed: unsupported model',
      runtimeModel: 'haiku',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('confirms pure Anthropic teammate bootstrap from member transcript when inbox and runtime are silent', async () => {
    const teamName = 'pure-anthropic-transcript-success-safe-e2e';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-transcript-success',
      records: [
        {
          timestamp: acceptedAt,
          teamName,
          agentName: 'bob',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "bob".`,
          },
        },
        {
          timestamp: successAt,
          teamName,
          agentName: 'bob',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'member-briefing-bob',
                content: `Member briefing for bob on team "${teamName}" (${teamName}).\nTask briefing for bob:\nNo actionable tasks.`,
                is_error: false,
              },
            ],
          },
        },
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: successAt,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
    });
  });

  it('fails pure Anthropic teammate bootstrap from member transcript API error when inbox is silent', async () => {
    const teamName = 'pure-anthropic-transcript-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const errorAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-transcript-failure',
      records: [
        {
          timestamp: acceptedAt,
          teamName,
          agentName: 'bob',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "bob".`,
          },
        },
        {
          timestamp: errorAt,
          teamName,
          agentName: 'bob',
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
              },
            ],
          },
        },
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
  });

  it('confirms Anthropic primary bootstrap from transcript in mixed launch without changing OpenCode teammates', async () => {
    const teamName = 'mixed-anthropic-transcript-primary-success-safe-e2e';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          name: 'tom',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'alice-transcript-success',
      records: [
        {
          timestamp: acceptedAt,
          teamName,
          agentName: 'alice',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "alice".`,
          },
        },
        {
          timestamp: successAt,
          teamName,
          agentName: 'alice',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `Member briefing for alice on team "${teamName}" (${teamName}).\nTask briefing for alice:\nNo actionable tasks.`,
              },
            ],
          },
        },
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: successAt,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('fails Anthropic primary bootstrap from transcript in mixed launch without degrading OpenCode teammates', async () => {
    const teamName = 'mixed-anthropic-transcript-primary-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const errorAt = new Date(Date.now() - 4_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          name: 'tom',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'alice-transcript-failure',
      records: [
        {
          timestamp: acceptedAt,
          teamName,
          agentName: 'alice',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "alice".`,
          },
        },
        {
          timestamp: errorAt,
          teamName,
          agentName: 'alice',
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
              },
            ],
          },
        },
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('confirms pure Anthropic teammate bootstrap from suffixed member transcript agentName', async () => {
    const teamName = 'pure-anthropic-suffixed-transcript-success-safe-e2e';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-2-transcript-success',
      records: [
        {
          timestamp: acceptedAt,
          teamName,
          agentName: 'bob-2',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "bob".`,
          },
        },
        {
          timestamp: successAt,
          teamName,
          agentName: 'bob-2',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `Member briefing for bob on team "${teamName}" (${teamName}).\nTask briefing for bob:\nNo actionable tasks.`,
              },
            ],
          },
        },
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: successAt,
    });
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('fails pure Anthropic teammate bootstrap from suffixed member transcript API error', async () => {
    const teamName = 'pure-anthropic-suffixed-transcript-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const errorAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-2-transcript-failure',
      records: [
        {
          timestamp: acceptedAt,
          teamName,
          agentName: 'bob-2',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "bob".`,
          },
        },
        {
          timestamp: errorAt,
          teamName,
          agentName: 'bob-2',
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
              },
            ],
          },
        },
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
    expect(statuses.statuses['bob-2']).toBeUndefined();
  });

  it('confirms suffixed Anthropic primary transcript agentName in mixed launch without changing OpenCode teammates', async () => {
    const teamName = 'mixed-anthropic-suffixed-transcript-primary-success-safe-e2e';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          name: 'tom',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'alice-2-transcript-success',
      records: [
        {
          timestamp: acceptedAt,
          teamName,
          agentName: 'alice-2',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "alice".`,
          },
        },
        {
          timestamp: successAt,
          teamName,
          agentName: 'alice-2',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `Member briefing for alice on team "${teamName}" (${teamName}).\nTask briefing for alice:\nNo actionable tasks.`,
              },
            ],
          },
        },
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: successAt,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('fails suffixed Anthropic primary transcript agentName in mixed launch without degrading OpenCode teammates', async () => {
    const teamName = 'mixed-anthropic-suffixed-transcript-primary-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 5_000).toISOString();
    const errorAt = new Date(Date.now() - 4_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          name: 'tom',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'alice-2-transcript-failure',
      records: [
        {
          timestamp: acceptedAt,
          teamName,
          agentName: 'alice-2',
          type: 'user',
          message: {
            role: 'user',
            content: `You are bootstrapping into team "${teamName}" as member "alice".`,
          },
        },
        {
          timestamp: errorAt,
          teamName,
          agentName: 'alice-2',
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
              },
            ],
          },
        },
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('uses newer pure Anthropic transcript success over older lexically-later transcript failure', async () => {
    const teamName = 'pure-anthropic-newer-transcript-success-wins-safe-e2e';
    const acceptedAt = new Date(Date.now() - 6_000).toISOString();
    const olderAt = new Date(Date.now() - 5_000).toISOString();
    const newerAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'zz-old-bob-failure',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
        bootstrapFailureTranscriptRecord({ timestamp: olderAt, teamName, memberName: 'bob' }),
      ],
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'aa-new-bob-success',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
        bootstrapSuccessTranscriptRecord({ timestamp: newerAt, teamName, memberName: 'bob' }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: newerAt,
    });
  });

  it('uses newer pure Anthropic transcript failure over older lexically-later transcript success', async () => {
    const teamName = 'pure-anthropic-newer-transcript-failure-wins-safe-e2e';
    const acceptedAt = new Date(Date.now() - 6_000).toISOString();
    const olderAt = new Date(Date.now() - 5_000).toISOString();
    const newerAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'zz-old-bob-success',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
        bootstrapSuccessTranscriptRecord({ timestamp: olderAt, teamName, memberName: 'bob' }),
      ],
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'aa-new-bob-failure',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
        bootstrapFailureTranscriptRecord({ timestamp: newerAt, teamName, memberName: 'bob' }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
  });

  it('uses newer mixed Anthropic primary transcript success over older lexically-later failure', async () => {
    const teamName = 'mixed-anthropic-newer-transcript-success-wins-safe-e2e';
    const acceptedAt = new Date(Date.now() - 6_000).toISOString();
    const olderAt = new Date(Date.now() - 5_000).toISOString();
    const newerAt = new Date(Date.now() - 4_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          name: 'tom',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'zz-old-alice-failure',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' }),
        bootstrapFailureTranscriptRecord({ timestamp: olderAt, teamName, memberName: 'alice' }),
      ],
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'aa-new-alice-success',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' }),
        bootstrapSuccessTranscriptRecord({ timestamp: newerAt, teamName, memberName: 'alice' }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: newerAt,
    });
  });

  it('uses newer mixed Anthropic primary transcript failure over older lexically-later success', async () => {
    const teamName = 'mixed-anthropic-newer-transcript-failure-wins-safe-e2e';
    const acceptedAt = new Date(Date.now() - 6_000).toISOString();
    const olderAt = new Date(Date.now() - 5_000).toISOString();
    const newerAt = new Date(Date.now() - 4_000).toISOString();
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, { primaryProviderId: 'anthropic' });
    await writeMixedTeamLaunchState({
      teamName,
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        tom: mixedMemberState({
          name: 'tom',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'zz-old-alice-success',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' }),
        bootstrapSuccessTranscriptRecord({ timestamp: olderAt, teamName, memberName: 'alice' }),
      ],
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'aa-new-alice-failure',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' }),
        bootstrapFailureTranscriptRecord({ timestamp: newerAt, teamName, memberName: 'alice' }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('falls back to project-root Anthropic transcript success when member log discovery fails', async () => {
    const teamName = 'pure-anthropic-project-root-transcript-success-fallback-safe-e2e';
    const acceptedAt = new Date(Date.now() - 6_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-project-root-success',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
        bootstrapSuccessTranscriptRecord({ timestamp: successAt, teamName, memberName: 'bob' }),
      ],
    });
    const svc = new TeamProvisioningService();
    (svc as any).memberLogsFinder = {
      findMemberLogs: async () => {
        throw new Error('fake member log discovery failure');
      },
    };

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: successAt,
    });
  });

  it('falls back to project-root Anthropic transcript failure when member log discovery fails', async () => {
    const teamName = 'pure-anthropic-project-root-transcript-failure-fallback-safe-e2e';
    const acceptedAt = new Date(Date.now() - 6_000).toISOString();
    const failureAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-project-root-failure',
      records: [
        bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' }),
        bootstrapFailureTranscriptRecord({ timestamp: failureAt, teamName, memberName: 'bob' }),
      ],
    });
    const svc = new TeamProvisioningService();
    (svc as any).memberLogsFinder = {
      findMemberLogs: async () => {
        throw new Error('fake member log discovery failure');
      },
    };

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
  });

  it('ignores malformed Anthropic transcript lines and recovers bootstrap success', async () => {
    const teamName = 'pure-anthropic-malformed-transcript-success-safe-e2e';
    const acceptedAt = new Date(Date.now() - 6_000).toISOString();
    const successAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeRawMemberTranscript({
      projectPath,
      sessionId: 'bob-malformed-success',
      lines: [
        JSON.stringify(
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' })
        ),
        '{"timestamp": "not complete"',
        JSON.stringify(
          bootstrapSuccessTranscriptRecord({ timestamp: successAt, teamName, memberName: 'bob' })
        ),
        'warning: claude cli emitted a non-json trailer',
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: successAt,
    });
  });

  it('ignores malformed Anthropic transcript lines and recovers bootstrap failure', async () => {
    const teamName = 'pure-anthropic-malformed-transcript-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 6_000).toISOString();
    const failureAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    await writePureAnthropicTeamLaunchState({
      teamName,
      launchPhase: 'active',
      members: {
        alice: mixedMemberState({
          name: 'alice',
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          name: 'bob',
          providerId: 'anthropic',
          model: 'sonnet',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          firstSpawnAcceptedAt: acceptedAt,
        }),
      },
    });
    await writeRawMemberTranscript({
      projectPath,
      sessionId: 'bob-malformed-failure',
      lines: [
        JSON.stringify(
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' })
        ),
        'partial-json-line {',
        JSON.stringify(
          bootstrapFailureTranscriptRecord({ timestamp: failureAt, teamName, memberName: 'bob' })
        ),
        'non-json stderr trailer',
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
  });

  it('ignores stale Anthropic transcript success from before the current spawn attempt', async () => {
    const teamName = 'pure-anthropic-stale-transcript-success-safe-e2e';
    const staleAt = new Date(Date.now() - 8_000).toISOString();
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-stale-success',
      records: [
        bootstrapTranscriptRecord({ timestamp: staleAt, teamName, memberName: 'bob' }),
        bootstrapSuccessTranscriptRecord({ timestamp: staleAt, teamName, memberName: 'bob' }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('ignores stale Anthropic transcript failure from before the current spawn attempt', async () => {
    const teamName = 'pure-anthropic-stale-transcript-failure-safe-e2e';
    const staleAt = new Date(Date.now() - 8_000).toISOString();
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-stale-failure',
      records: [
        bootstrapTranscriptRecord({ timestamp: staleAt, teamName, memberName: 'bob' }),
        bootstrapFailureTranscriptRecord({ timestamp: staleAt, teamName, memberName: 'bob' }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('ignores invalid-timestamp Anthropic transcript success when filtering a current spawn attempt', async () => {
    const teamName = 'pure-anthropic-invalid-timestamp-success-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-invalid-timestamp-success',
      records: [
        bootstrapTranscriptRecord({ timestamp: 'not-a-date', teamName, memberName: 'bob' }),
        bootstrapSuccessTranscriptRecord({
          timestamp: 'not-a-date',
          teamName,
          memberName: 'bob',
        }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('ignores invalid-timestamp Anthropic transcript failure when filtering a current spawn attempt', async () => {
    const teamName = 'pure-anthropic-invalid-timestamp-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-invalid-timestamp-failure',
      records: [
        bootstrapTranscriptRecord({ timestamp: 'not-a-date', teamName, memberName: 'bob' }),
        bootstrapFailureTranscriptRecord({
          timestamp: 'not-a-date',
          teamName,
          memberName: 'bob',
        }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('ignores unrelated no-agentName Anthropic transcript failure in the same project root', async () => {
    const teamName = 'pure-anthropic-unrelated-no-agent-transcript-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    const errorAt = new Date(Date.now() - 2_000).toISOString();
    await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'unrelated-no-agent-failure',
      records: [genericTranscriptApiErrorRecord({ timestamp: errorAt })],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('accepts no-agentName Anthropic transcript failure when the file has matching bootstrap context', async () => {
    const teamName = 'pure-anthropic-contextual-no-agent-transcript-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    const errorAt = new Date(Date.now() - 2_000).toISOString();
    await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'bob-contextual-no-agent-failure',
      records: [
        withoutAgentName(
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' })
        ),
        genericTranscriptApiErrorRecord({ timestamp: errorAt }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
  });

  it('ignores unrelated no-agentName Anthropic primary transcript failure in mixed launch', async () => {
    const teamName = 'mixed-anthropic-unrelated-no-agent-transcript-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    const errorAt = new Date(Date.now() - 2_000).toISOString();
    await writeMixedAnthropicPendingAliceFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'mixed-unrelated-no-agent-failure',
      records: [genericTranscriptApiErrorRecord({ timestamp: errorAt })],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('accepts no-agentName Anthropic primary transcript failure in mixed launch with matching context', async () => {
    const teamName = 'mixed-anthropic-contextual-no-agent-transcript-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    const errorAt = new Date(Date.now() - 2_000).toISOString();
    await writeMixedAnthropicPendingAliceFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'mixed-alice-contextual-no-agent-failure',
      records: [
        withoutAgentName(
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' })
        ),
        genericTranscriptApiErrorRecord({ timestamp: errorAt }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('accepts attributed pure Anthropic no-agentName transcript failure without bootstrap context', async () => {
    const teamName = 'pure-anthropic-attributed-no-agent-transcript-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    const errorAt = new Date(Date.now() - 2_000).toISOString();
    const sessionId = 'bob-attributed-no-agent-failure';
    await writePureAnthropicPendingBobFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId,
      records: [genericTranscriptApiErrorRecord({ timestamp: errorAt })],
    });
    const svc = new TeamProvisioningService();
    (svc as any).memberLogsFinder = {
      findMemberLogs: async () => [
        {
          filePath: getMemberTranscriptPath(projectPath, sessionId),
        },
      ],
    };

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
  });

  it('accepts attributed mixed Anthropic no-agentName transcript failure without degrading OpenCode teammates', async () => {
    const teamName = 'mixed-anthropic-attributed-no-agent-transcript-failure-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    const errorAt = new Date(Date.now() - 2_000).toISOString();
    const sessionId = 'alice-attributed-no-agent-failure';
    await writeMixedAnthropicPendingAliceFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId,
      records: [genericTranscriptApiErrorRecord({ timestamp: errorAt })],
    });
    const svc = new TeamProvisioningService();
    (svc as any).memberLogsFinder = {
      findMemberLogs: async () => [
        {
          filePath: getMemberTranscriptPath(projectPath, sessionId),
        },
      ],
    };

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.alice?.hardFailureReason).toContain('requested Anthropic model');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('maps shared pure Anthropic transcript outcomes to the matching agentName only', async () => {
    const teamName = 'pure-anthropic-shared-transcript-agent-attribution-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    const aliceSuccessAt = new Date(Date.now() - 2_500).toISOString();
    const bobFailureAt = new Date(Date.now() - 2_000).toISOString();
    await writePureAnthropicPendingMembersFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'shared-agent-attributed-outcomes',
      records: [
        bootstrapTranscriptRecord({
          timestamp: acceptedAt,
          teamName,
          memberName: 'alice',
          agentName: 'alice',
        }),
        bootstrapSuccessTranscriptRecord({
          timestamp: aliceSuccessAt,
          teamName,
          memberName: 'alice',
          agentName: 'alice',
        }),
        bootstrapTranscriptRecord({
          timestamp: acceptedAt,
          teamName,
          memberName: 'bob',
          agentName: 'bob',
        }),
        bootstrapFailureTranscriptRecord({
          timestamp: bobFailureAt,
          teamName,
          memberName: 'bob',
          agentName: 'bob',
        }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: aliceSuccessAt,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
    });
    expect(statuses.statuses.bob?.hardFailureReason).toContain('requested Anthropic model');
  });

  it('does not apply one anonymous shared Anthropic transcript failure to multiple pending members', async () => {
    const teamName = 'pure-anthropic-shared-anonymous-failure-ambiguous-safe-e2e';
    const acceptedAt = new Date(Date.now() - 4_000).toISOString();
    const errorAt = new Date(Date.now() - 2_000).toISOString();
    await writePureAnthropicPendingMembersFixture({ teamName, projectPath, acceptedAt });
    await writeMemberTranscript({
      projectPath,
      sessionId: 'shared-ambiguous-anonymous-failure',
      records: [
        withoutAgentName(
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'alice' })
        ),
        withoutAgentName(
          bootstrapTranscriptRecord({ timestamp: acceptedAt, teamName, memberName: 'bob' })
        ),
        genericTranscriptApiErrorRecord({ timestamp: errorAt }),
      ],
    });

    const statuses = await new TeamProvisioningService().getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      hardFailure: false,
    });
  });

  it('marks an Agent tool call without team_name as an ephemeral spawn failure', async () => {
    const teamName = 'agent-missing-team-name-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.expectedMembers = ['alice', 'bob'];
    run.memberSpawnStatuses.set('bob', {
      status: 'waiting',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    (svc as any).captureTeamSpawnEvents(run, [
      {
        type: 'tool_use',
        name: 'Agent',
        id: 'tool-bob-missing-team',
        input: { name: 'bob' },
      },
    ]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('missing team_name')
    );
    (console.warn as unknown as { mockClear: () => void }).mockClear();

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: expect.stringContaining('missing team_name'),
    });
    expect(run.memberSpawnToolUseIds.has('tool-bob-missing-team')).toBe(false);
  });

  it('ignores an Agent tool call routed to a different team during launch capture', async () => {
    const teamName = 'agent-wrong-team-capture-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.expectedMembers = ['alice', 'bob'];
    run.memberSpawnStatuses.set('bob', {
      status: 'waiting',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    (svc as any).captureTeamSpawnEvents(run, [
      {
        type: 'tool_use',
        name: 'Agent',
        id: 'tool-bob-other-team',
        input: { team_name: 'other-team', name: 'bob' },
      },
    ]);

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'waiting',
      launchState: 'starting',
      agentToolAccepted: false,
      hardFailure: false,
    });
    expect(run.memberSpawnToolUseIds.has('tool-bob-other-team')).toBe(false);
  });

  it('marks a valid Agent tool call for this team as spawning and advances to members joining', async () => {
    const teamName = 'agent-valid-spawn-capture-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    const progressEvents: TeamProvisioningProgress[] = [];
    run.progress = {
      ...run.progress,
      state: 'configuring',
      message: 'Preparing launch',
    };
    run.onProgress = (progress: TeamProvisioningProgress) => progressEvents.push(progress);
    run.expectedMembers = ['alice', 'bob'];
    run.memberSpawnStatuses.set('bob', {
      status: 'waiting',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    (svc as any).captureTeamSpawnEvents(run, [
      {
        type: 'tool_use',
        name: 'Agent',
        id: 'tool-bob-valid-spawn',
        input: { team_name: teamName, name: 'bob' },
      },
    ]);

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(run.memberSpawnToolUseIds.get('tool-bob-valid-spawn')).toBe('bob');
    expect(progressEvents.at(-1)).toMatchObject({
      state: 'assembling',
      message: 'Spawning member bob...',
    });
  });

  it('does not reset an online teammate when a duplicate Agent tool call is captured', async () => {
    const teamName = 'agent-duplicate-online-capture-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    const progressEvents: TeamProvisioningProgress[] = [];
    run.progress = {
      ...run.progress,
      state: 'configuring',
      message: 'Preparing launch',
    };
    run.onProgress = (progress: TeamProvisioningProgress) => progressEvents.push(progress);
    const before = run.memberSpawnStatuses.get('alice');

    (svc as any).captureTeamSpawnEvents(run, [
      {
        type: 'tool_use',
        name: 'Agent',
        id: 'tool-alice-duplicate-spawn',
        input: { team_name: teamName, name: 'alice' },
      },
    ]);

    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: before.status,
      launchState: before.launchState,
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
    });
    expect(run.memberSpawnToolUseIds.has('tool-alice-duplicate-spawn')).toBe(false);
    expect(run.provisioningOutputParts.join('\n')).toContain(
      'respawn blocked as duplicate - teammate already online'
    );
    expect(progressEvents).toEqual([]);
  });

  it('ignores an Agent tool call without name instead of creating a phantom teammate', async () => {
    const teamName = 'agent-missing-name-capture-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.expectedMembers = ['alice', 'bob'];

    (svc as any).captureTeamSpawnEvents(run, [
      {
        type: 'tool_use',
        name: 'Agent',
        id: 'tool-missing-name',
        input: { team_name: teamName },
      },
    ]);

    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('missing name')
    );
    (console.warn as unknown as { mockClear: () => void }).mockClear();

    expect(run.memberSpawnStatuses.has('')).toBe(false);
    expect(run.memberSpawnStatuses.has('undefined')).toBe(false);
    expect(run.memberSpawnToolUseIds.has('tool-missing-name')).toBe(false);
  });

  it('moves a spawned teammate to bootstrap-pending when Agent tool result is accepted', async () => {
    const teamName = 'agent-tool-result-accepted-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.expectedMembers = ['alice', 'bob'];
    run.memberSpawnStatuses.set('bob', {
      status: 'spawning',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    run.activeToolCalls.set('tool-bob-result-accepted', {
      memberName: 'bob',
      toolUseId: 'tool-bob-result-accepted',
      toolName: 'Agent',
      preview: 'Spawn teammate bob',
      startedAt: '2026-04-23T10:00:00.000Z',
      state: 'running',
      source: 'runtime',
    });
    run.memberSpawnToolUseIds.set('tool-bob-result-accepted', 'bob');

    (svc as any).finishRuntimeToolActivity(
      run,
      'tool-bob-result-accepted',
      [{ type: 'text', text: 'Agent spawn accepted' }],
      false
    );

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(run.memberSpawnStatuses.get('bob')?.firstSpawnAcceptedAt).toBeTruthy();
    expect(run.memberSpawnToolUseIds.has('tool-bob-result-accepted')).toBe(false);
    expect(run.provisioningOutputParts.join('\n')).toContain(
      'spawn accepted, waiting for teammate check-in'
    );
  });

  it('fails a spawned teammate when Agent tool result returns an error', async () => {
    const teamName = 'agent-tool-result-error-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    const progressEvents: TeamProvisioningProgress[] = [];
    run.progress = {
      ...run.progress,
      state: 'assembling',
      message: 'Members joining',
    };
    run.onProgress = (progress: TeamProvisioningProgress) => progressEvents.push(progress);
    run.expectedMembers = ['alice', 'bob'];
    run.memberSpawnStatuses.set('bob', {
      status: 'spawning',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    run.activeToolCalls.set('tool-bob-result-error', {
      memberName: 'bob',
      toolUseId: 'tool-bob-result-error',
      toolName: 'Agent',
      preview: 'Spawn teammate bob',
      startedAt: '2026-04-23T10:00:00.000Z',
      state: 'running',
      source: 'runtime',
    });
    run.memberSpawnToolUseIds.set('tool-bob-result-error', 'bob');

    (svc as any).finishRuntimeToolActivity(
      run,
      'tool-bob-result-error',
      [{ type: 'text', text: 'spawn denied by runtime' }],
      true
    );

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: expect.stringContaining('spawn denied by runtime'),
    });
    expect(run.memberSpawnToolUseIds.has('tool-bob-result-error')).toBe(false);
    expect(run.provisioningOutputParts.join('\n')).toContain(
      'Teammate "bob" failed to start: spawn denied by runtime'
    );
    expect(progressEvents.at(-1)).toMatchObject({
      state: 'assembling',
      message: 'Failed to start member bob',
    });
  });

  it('restarts a pure Anthropic teammate through the primary runtime without touching siblings', async () => {
    const teamName = 'pure-anthropic-manual-restart-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);
    let sentRestartMessage = '';
    (svc as any).sendMessageToRun = async (_run: unknown, message: string) => {
      sentRestartMessage = message;
    };
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

    await svc.restartMember(teamName, 'bob');

    expect(sentRestartMessage).toContain('bob');
    expect(sentRestartMessage).toContain(teamName);
    expect(run.pendingMemberRestarts.has('bob')).toBe(true);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(run.provisioningOutputParts.join('\n')).toContain('manual restart requested from UI');
  });

  it('keeps a pure Anthropic restart pending after Agent accepts the spawn but before heartbeat', async () => {
    const teamName = 'pure-anthropic-restart-accepted-pending-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);
    (svc as any).sendMessageToRun = async () => undefined;
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

    await svc.restartMember(teamName, 'bob');
    run.activeToolCalls.set('tool-bob-restart-accepted', {
      memberName: 'bob',
      toolUseId: 'tool-bob-restart-accepted',
      toolName: 'Agent',
      preview: 'Restart teammate bob',
      startedAt: '2026-04-23T10:00:00.000Z',
      state: 'running',
      source: 'runtime',
    });
    run.memberSpawnToolUseIds.set('tool-bob-restart-accepted', 'bob');

    (svc as any).finishRuntimeToolActivity(
      run,
      'tool-bob-restart-accepted',
      [{ type: 'text', text: 'Agent spawn accepted' }],
      false
    );

    expect(run.pendingMemberRestarts.has('bob')).toBe(true);
    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('fails a pure Anthropic restart cleanly when the lead runtime cannot receive the command', async () => {
    const teamName = 'pure-anthropic-restart-send-failure-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);
    (svc as any).sendMessageToRun = async () => {
      throw new Error('lead stdin is closed');
    };
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

    await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow('lead stdin is closed');

    expect(run.pendingMemberRestarts.has('bob')).toBe(false);
    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'lead stdin is closed',
    });
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('rejects a duplicate pure Anthropic restart while the first restart is still pending', async () => {
    const teamName = 'pure-anthropic-duplicate-restart-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);
    let sendCount = 0;
    (svc as any).sendMessageToRun = async () => {
      sendCount += 1;
    };
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

    await svc.restartMember(teamName, 'bob');
    await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
      'Restart for teammate "bob" is already in progress'
    );

    expect(sendCount).toBe(1);
    expect(run.pendingMemberRestarts.has('bob')).toBe(true);
    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      hardFailure: false,
    });
  });

  it('clears stale Agent tracking for the restarted teammate without clearing sibling tool calls', async () => {
    const teamName = 'pure-anthropic-restart-clears-stale-tool-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);
    (svc as any).sendMessageToRun = async () => undefined;
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();
    run.activeToolCalls.set('old-bob-tool', {
      memberName: 'bob',
      toolUseId: 'old-bob-tool',
      toolName: 'Agent',
      preview: 'Old bob spawn',
      startedAt: '2026-04-23T09:59:00.000Z',
      state: 'running',
      source: 'runtime',
    });
    run.activeToolCalls.set('alice-tool', {
      memberName: 'alice',
      toolUseId: 'alice-tool',
      toolName: 'Read',
      preview: 'Alice is working',
      startedAt: '2026-04-23T09:59:00.000Z',
      state: 'running',
      source: 'runtime',
    });
    run.memberSpawnToolUseIds.set('old-bob-tool', 'bob');
    run.memberSpawnToolUseIds.set('alice-tool', 'alice');

    await svc.restartMember(teamName, 'bob');

    expect(run.activeToolCalls.has('old-bob-tool')).toBe(false);
    expect(run.activeToolCalls.has('alice-tool')).toBe(true);
    expect(run.memberSpawnToolUseIds.has('old-bob-tool')).toBe(false);
    expect(run.memberSpawnToolUseIds.get('alice-tool')).toBe('alice');
    expect(run.provisioningOutputParts.join('\n')).toContain(
      'cleared stale spawn tool tracking before manual restart'
    );
  });

  it('keeps manual restart state isolated to the targeted team', async () => {
    const firstTeamName = 'pure-anthropic-restart-team-a-safe-e2e';
    const secondTeamName = 'pure-anthropic-restart-team-b-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
    await writePureAnthropicTeamMeta(firstTeamName, projectPath);
    await writePureAnthropicMembersMeta(firstTeamName);
    await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
    await writePureAnthropicTeamMeta(secondTeamName, projectPath);
    await writePureAnthropicMembersMeta(secondTeamName);
    const svc = new TeamProvisioningService();
    const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);
    (svc as any).sendMessageToRun = async () => undefined;
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () => new Map();

    await svc.restartMember(firstTeamName, 'bob');

    expect(firstRun.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      hardFailure: false,
    });
    expect(secondRun.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    const firstStatuses = await svc.getMemberSpawnStatuses(firstTeamName);
    const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
    expect(firstStatuses.teamLaunchState).toBe('partial_pending');
    expect(secondStatuses.teamLaunchState).toBe('clean_success');
  });

  it('rejects restart for a removed pure Anthropic teammate without changing sibling statuses', async () => {
    const teamName = 'pure-anthropic-restart-removed-member-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName, { removedMembers: ['bob'] });
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
      'Member "bob" has been removed'
    );

    expect(run.pendingMemberRestarts.has('bob')).toBe(false);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('rejects restart for the team lead without creating a member restart', async () => {
    const teamName = 'pure-anthropic-restart-lead-reject-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await expect(svc.restartMember(teamName, 'team-lead')).rejects.toThrow(
      'Lead restart is not supported from member controls'
    );

    expect(run.pendingMemberRestarts.size).toBe(0);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('rejects restart after a pure Anthropic team was stopped', async () => {
    const teamName = 'pure-anthropic-restart-after-stop-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.child = { kill: () => undefined };
    trackLiveRun(svc, run);

    svc.stopTeam(teamName);

    expect(svc.isTeamAlive(teamName)).toBe(false);
    await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
      `Team "${teamName}" is not currently running`
    );
    expect(run.pendingMemberRestarts.has('bob')).toBe(false);
  });

  it('stops one live pure Anthropic team without disconnecting another tracked team', async () => {
    const firstTeamName = 'pure-anthropic-stop-team-a-safe-e2e';
    const secondTeamName = 'pure-anthropic-stop-team-b-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
    await writePureAnthropicTeamMeta(firstTeamName, projectPath);
    await writePureAnthropicMembersMeta(firstTeamName);
    await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
    await writePureAnthropicTeamMeta(secondTeamName, projectPath);
    await writePureAnthropicMembersMeta(secondTeamName);
    const svc = new TeamProvisioningService();
    const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
    firstRun.child = { kill: () => undefined };
    secondRun.child = { kill: () => undefined };
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);

    svc.stopTeam(firstTeamName);

    expect(svc.isTeamAlive(firstTeamName)).toBe(false);
    expect(svc.isTeamAlive(secondTeamName)).toBe(true);
    expect(firstRun.cancelRequested).toBe(true);
    expect(secondRun.cancelRequested).toBe(false);
    const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
    expect(secondStatuses.teamLaunchState).toBe('clean_success');
    expect(secondStatuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(secondStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
  });

  it('keeps pure Anthropic runtime state isolated when one of two teams stops', async () => {
    const stoppedTeamName = 'pure-anthropic-runtime-state-stopped-safe-e2e';
    const liveTeamName = 'pure-anthropic-runtime-state-live-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName: stoppedTeamName, projectPath });
    await writePureAnthropicTeamMeta(stoppedTeamName, projectPath);
    await writePureAnthropicMembersMeta(stoppedTeamName);
    await writePureAnthropicTeamConfig({ teamName: liveTeamName, projectPath });
    await writePureAnthropicTeamMeta(liveTeamName, projectPath);
    await writePureAnthropicMembersMeta(liveTeamName);
    const svc = new TeamProvisioningService();
    const stoppedRun = createPureAnthropicLiveRun({ teamName: stoppedTeamName, projectPath });
    const liveRun = createPureAnthropicLiveRun({ teamName: liveTeamName, projectPath });
    stoppedRun.child = { pid: 61101, kill: () => undefined, stdin: { writable: true } };
    liveRun.child = { pid: 61201, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, stoppedRun);
    trackLiveRun(svc, liveRun);

    expect(await svc.getRuntimeState(stoppedTeamName)).toMatchObject({
      teamName: stoppedTeamName,
      isAlive: true,
      runId: stoppedRun.runId,
      progress: {
        state: 'finalizing',
      },
    });
    expect(await svc.getRuntimeState(liveTeamName)).toMatchObject({
      teamName: liveTeamName,
      isAlive: true,
      runId: liveRun.runId,
      progress: {
        state: 'finalizing',
      },
    });

    svc.stopTeam(stoppedTeamName);

    expect(await svc.getRuntimeState(stoppedTeamName)).toMatchObject({
      teamName: stoppedTeamName,
      isAlive: false,
      runId: null,
      progress: null,
    });
    expect(await svc.getRuntimeState(liveTeamName)).toMatchObject({
      teamName: liveTeamName,
      isAlive: true,
      runId: liveRun.runId,
      progress: {
        state: 'finalizing',
      },
    });
    expect(svc.getAliveTeams()).toEqual([liveTeamName]);
  });

  it('stops all tracked pure Anthropic teams and clears lead activity', async () => {
    const firstTeamName = 'pure-anthropic-stop-all-a-safe-e2e';
    const secondTeamName = 'pure-anthropic-stop-all-b-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
    await writePureAnthropicTeamMeta(firstTeamName, projectPath);
    await writePureAnthropicMembersMeta(firstTeamName);
    await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
    await writePureAnthropicTeamMeta(secondTeamName, projectPath);
    await writePureAnthropicMembersMeta(secondTeamName);
    const svc = new TeamProvisioningService();
    const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
    firstRun.child = { pid: 62101, kill: () => undefined, stdin: { writable: true } };
    secondRun.child = { pid: 62201, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);

    expect(svc.getAliveTeams().sort()).toEqual([firstTeamName, secondTeamName].sort());

    svc.stopAllTeams();

    expect(svc.getAliveTeams()).toEqual([]);
    expect(firstRun.cancelRequested).toBe(true);
    expect(secondRun.cancelRequested).toBe(true);
    expect(svc.getLeadActivityState(firstTeamName)).toEqual({
      state: 'offline',
      runId: null,
    });
    expect(svc.getLeadActivityState(secondTeamName)).toEqual({
      state: 'offline',
      runId: null,
    });
  });

  it('sends a user message only to the targeted pure Anthropic team', async () => {
    const firstTeamName = 'pure-anthropic-message-team-a-safe-e2e';
    const secondTeamName = 'pure-anthropic-message-team-b-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
    await writePureAnthropicTeamMeta(firstTeamName, projectPath);
    await writePureAnthropicMembersMeta(firstTeamName);
    await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
    await writePureAnthropicTeamMeta(secondTeamName, projectPath);
    await writePureAnthropicMembersMeta(secondTeamName);
    const svc = new TeamProvisioningService();
    const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
    firstRun.child = { stdin: { writable: true } };
    secondRun.child = { stdin: { writable: true } };
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);
    const delivered: Array<{ teamName: string; message: string }> = [];
    (svc as any).sendMessageToRun = async (run: { teamName: string }, message: string) => {
      delivered.push({ teamName: run.teamName, message });
    };

    await svc.sendMessageToTeam(secondTeamName, 'please review the latest task');

    expect(delivered).toEqual([
      {
        teamName: secondTeamName,
        message: 'please review the latest task',
      },
    ]);
    expect(svc.isTeamAlive(firstTeamName)).toBe(true);
    expect(svc.isTeamAlive(secondTeamName)).toBe(true);
    expect(firstRun.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(secondRun.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('serializes attachments only into the targeted pure Anthropic lead stdin', async () => {
    const firstTeamName = 'pure-anthropic-attachment-team-a-safe-e2e';
    const secondTeamName = 'pure-anthropic-attachment-team-b-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
    await writePureAnthropicTeamMeta(firstTeamName, projectPath);
    await writePureAnthropicMembersMeta(firstTeamName);
    await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
    await writePureAnthropicTeamMeta(secondTeamName, projectPath);
    await writePureAnthropicMembersMeta(secondTeamName);
    const svc = new TeamProvisioningService();
    const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
    const firstWrites: string[] = [];
    const secondWrites: string[] = [];
    firstRun.child = { stdin: createWritableStdin(firstWrites) };
    secondRun.child = { stdin: createWritableStdin(secondWrites) };
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);

    await svc.sendMessageToTeam(secondTeamName, 'review the attached files', [
      {
        filename: 'notes.txt',
        mimeType: 'text/plain',
        data: Buffer.from('line one\nline two', 'utf8').toString('base64'),
      },
      {
        filename: 'brief.pdf',
        mimeType: 'application/pdf',
        data: 'JVBERi0xLjQ=',
      },
      {
        filename: 'screenshot.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    ]);

    expect(firstWrites).toEqual([]);
    expect(secondWrites).toHaveLength(1);
    const payload = JSON.parse(secondWrites[0].trim()) as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(payload.message.content).toMatchObject([
      { type: 'text', text: 'review the attached files' },
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'line one\nline two' },
        title: 'notes.txt',
      },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
        title: 'brief.pdf',
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      },
    ]);
    expect(svc.isTeamAlive(firstTeamName)).toBe(true);
    expect(svc.isTeamAlive(secondTeamName)).toBe(true);
  });

  it('routes messages to the current pure Anthropic run after same-team relaunch', async () => {
    const teamName = 'pure-anthropic-message-current-run-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
    const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
    staleRun.runId = `run-${teamName}-stale`;
    currentRun.runId = `run-${teamName}-current`;
    const staleWrites: string[] = [];
    const currentWrites: string[] = [];
    staleRun.child = { stdin: createWritableStdin(staleWrites) };
    currentRun.child = { stdin: createWritableStdin(currentWrites) };
    trackLiveRun(svc, staleRun);
    trackLiveRun(svc, currentRun);

    await svc.sendMessageToTeam(teamName, 'use the latest run only');

    expect(staleWrites).toEqual([]);
    expect(currentWrites).toHaveLength(1);
    const payload = JSON.parse(currentWrites[0].trim()) as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(payload.message.content).toMatchObject([
      { type: 'text', text: 'use the latest run only' },
    ]);
    expect(svc.getLeadActivityState(teamName)).toEqual({
      state: 'active',
      runId: currentRun.runId,
    });
  });

  it('sends a user message only to the targeted Anthropic and Gemini mixed team', async () => {
    const firstTeamName = 'mixed-anthropic-gemini-message-team-a-safe-e2e';
    const secondTeamName = 'mixed-anthropic-gemini-message-team-b-safe-e2e';
    await writeMixedTeamConfig({
      teamName: firstTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(firstTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(firstTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeMixedTeamConfig({
      teamName: secondTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(secondTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(secondTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const svc = new TeamProvisioningService();
    const firstRun = createMixedLiveRun({
      teamName: firstTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    const secondRun = createMixedLiveRun({
      teamName: secondTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    addGeminiPrimaryToMixedRun(firstRun);
    addGeminiPrimaryToMixedRun(secondRun);
    firstRun.child = { stdin: { writable: true } };
    secondRun.child = { stdin: { writable: true } };
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);
    const delivered: Array<{ teamName: string; message: string }> = [];
    (svc as any).sendMessageToRun = async (run: { teamName: string }, message: string) => {
      delivered.push({ teamName: run.teamName, message });
    };

    await svc.sendMessageToTeam(secondTeamName, 'review mixed launch state');

    expect(delivered).toEqual([
      {
        teamName: secondTeamName,
        message: 'review mixed launch state',
      },
    ]);
    expect(svc.isTeamAlive(firstTeamName)).toBe(true);
    expect(svc.isTeamAlive(secondTeamName)).toBe(true);
    expect(firstRun.memberSpawnStatuses.get('reviewer')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(secondRun.memberSpawnStatuses.get('reviewer')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('routes messages to the current Anthropic and Gemini mixed run after same-team relaunch', async () => {
    const teamName = 'mixed-anthropic-gemini-message-current-run-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const svc = new TeamProvisioningService();
    const staleRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const currentRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(staleRun);
    addGeminiPrimaryToMixedRun(currentRun);
    staleRun.runId = `run-${teamName}-stale`;
    currentRun.runId = `run-${teamName}-current`;
    const staleWrites: string[] = [];
    const currentWrites: string[] = [];
    staleRun.child = { stdin: createWritableStdin(staleWrites) };
    currentRun.child = { stdin: createWritableStdin(currentWrites) };
    trackLiveRun(svc, staleRun);
    trackLiveRun(svc, currentRun);

    await svc.sendMessageToTeam(teamName, 'use the latest mixed run only');

    expect(staleWrites).toEqual([]);
    expect(currentWrites).toHaveLength(1);
    const payload = JSON.parse(currentWrites[0].trim()) as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(payload.message.content).toMatchObject([
      { type: 'text', text: 'use the latest mixed run only' },
    ]);
    expect(svc.getLeadActivityState(teamName)).toEqual({
      state: 'active',
      runId: currentRun.runId,
    });
  });

  it('routes direct OpenCode member messages to the current Anthropic and Gemini mixed run after same-team relaunch', async () => {
    const teamName = 'mixed-anthropic-gemini-direct-message-current-run-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const staleRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const currentRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(staleRun);
    addGeminiPrimaryToMixedRun(currentRun);
    staleRun.runId = `run-${teamName}-stale`;
    currentRun.runId = `run-${teamName}-current`;
    trackLiveRun(svc, staleRun);
    trackLiveRun(svc, currentRun);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'use current run for direct opencode message',
        messageId: 'msg-current-direct-opencode',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: currentRun.runId,
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'use current run for direct opencode message',
      messageId: 'msg-current-direct-opencode',
    });
    expect(adapter.messageInputs[0]?.runId).not.toBe(staleRun.runId);
  });

  it('routes direct OpenCode member messages only to the targeted live mixed OpenCode lane', async () => {
    const firstTeamName = 'mixed-opencode-direct-message-live-team-a-safe-e2e';
    const secondTeamName = 'mixed-opencode-direct-message-live-team-b-safe-e2e';
    await writeMixedTeamConfig({
      teamName: firstTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(firstTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(firstTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeMixedTeamConfig({
      teamName: secondTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(secondTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(secondTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const firstRun = createMixedLiveRun({
      teamName: firstTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    const secondRun = createMixedLiveRun({
      teamName: secondTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    addGeminiPrimaryToMixedRun(firstRun);
    addGeminiPrimaryToMixedRun(secondRun);
    firstRun.child = { stdin: { writable: true } };
    secondRun.child = { stdin: { writable: true } };
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);

    await expect(
      svc.deliverOpenCodeMemberMessage(secondTeamName, {
        memberName: 'bob',
        text: 'send to the second live mixed opencode lane only',
        messageId: 'msg-live-mixed-opencode-team-b',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: secondRun.runId,
      teamName: secondTeamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'send to the second live mixed opencode lane only',
      messageId: 'msg-live-mixed-opencode-team-b',
    });
    expect(adapter.messageInputs[0]?.runId).not.toBe(firstRun.runId);
    expect(svc.isTeamAlive(firstTeamName)).toBe(true);
    expect(svc.isTeamAlive(secondTeamName)).toBe(true);
  });

  it('routes direct OpenCode member messages to a fresh Anthropic and Gemini mixed relaunch after cancelling an in-flight handoff', async () => {
    const cancelledTeamName = 'mixed-anthropic-gemini-direct-after-cancelled-handoff-safe-e2e';
    const survivingTeamName = 'mixed-anthropic-gemini-direct-survives-cancelled-handoff-safe-e2e';
    await writeMixedTeamConfig({
      teamName: cancelledTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(cancelledTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(cancelledTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeMixedTeamConfig({
      teamName: survivingTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(survivingTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(survivingTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const cancelledRun = createMixedLiveRun({
      teamName: cancelledTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    const survivingRun = createMixedLiveRun({
      teamName: survivingTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    addGeminiPrimaryToMixedRun(cancelledRun);
    addGeminiPrimaryToMixedRun(survivingRun);
    cancelledRun.child = { kill: () => undefined };
    survivingRun.child = { kill: () => undefined };
    trackLiveRun(svc, cancelledRun);
    trackLiveRun(svc, survivingRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 4);

    await svc.cancelProvisioning(cancelledRun.runId);

    await waitForCondition(
      () => adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 2
    );
    expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      survivingRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const freshRun = createMixedLiveRun({
      teamName: cancelledTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    freshRun.runId = `${cancelledRun.runId}-fresh`;
    freshRun.detectedSessionId = 'lead-session-fresh';
    freshRun.child = { kill: () => undefined };
    addGeminiPrimaryToMixedRun(freshRun);
    trackLiveRun(svc, freshRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
    await waitForCondition(() => adapter.launchInputs.length === 6);
    await waitForCondition(() =>
      freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await expect(
      svc.deliverOpenCodeMemberMessage(cancelledTeamName, {
        memberName: 'bob',
        text: 'send to fresh mixed relaunch after cancelled handoff',
        messageId: 'msg-fresh-mixed-opencode-after-cancelled-handoff',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    await expect(
      svc.deliverOpenCodeMemberMessage(survivingTeamName, {
        memberName: 'tom',
        text: 'send to surviving sibling mixed lane',
        messageId: 'msg-surviving-mixed-opencode-after-cancelled-handoff',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(2);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: freshRun.runId,
      teamName: cancelledTeamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'send to fresh mixed relaunch after cancelled handoff',
      messageId: 'msg-fresh-mixed-opencode-after-cancelled-handoff',
    });
    expect(adapter.messageInputs[1]).toMatchObject({
      runId: survivingRun.runId,
      teamName: survivingTeamName,
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      cwd: projectPath,
      text: 'send to surviving sibling mixed lane',
      messageId: 'msg-surviving-mixed-opencode-after-cancelled-handoff',
    });
    expect(adapter.messageInputs.map((input) => input.runId)).not.toContain(cancelledRun.runId);
  });

  it('does not deliver direct OpenCode member messages to a cancelled mixed handoff after late launch completion while a sibling stays live', async () => {
    const cancelledTeamName = 'mixed-direct-cancelled-late-completion-safe-e2e';
    const survivingTeamName = 'mixed-direct-sibling-after-cancelled-late-completion-safe-e2e';
    await writeMixedTeamConfig({
      teamName: cancelledTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(cancelledTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(cancelledTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeMixedTeamConfig({
      teamName: survivingTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(survivingTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(survivingTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const cancelledRun = createMixedLiveRun({
      teamName: cancelledTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    const survivingRun = createMixedLiveRun({
      teamName: survivingTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    addGeminiPrimaryToMixedRun(cancelledRun);
    addGeminiPrimaryToMixedRun(survivingRun);
    cancelledRun.child = { kill: () => undefined };
    survivingRun.child = { kill: () => undefined };
    trackLiveRun(svc, cancelledRun);
    trackLiveRun(svc, survivingRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 4);

    await svc.cancelProvisioning(cancelledRun.runId);

    await waitForCondition(
      () => adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 2
    );
    expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);
    expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
    expect(svc.isTeamAlive(survivingTeamName)).toBe(true);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      survivingRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await expect(
      svc.deliverOpenCodeMemberMessage(cancelledTeamName, {
        memberName: 'bob',
        text: 'must not reach cancelled mixed handoff after late launch',
        messageId: 'msg-cancelled-mixed-late-launch-direct',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    await expect(
      svc.deliverOpenCodeMemberMessage(survivingTeamName, {
        memberName: 'bob',
        text: 'sibling still receives direct message after cancelled launch',
        messageId: 'msg-sibling-after-cancelled-late-launch-direct',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: survivingRun.runId,
      teamName: survivingTeamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'sibling still receives direct message after cancelled launch',
      messageId: 'msg-sibling-after-cancelled-late-launch-direct',
    });
    expect(adapter.messageInputs[0]?.runId).not.toBe(cancelledRun.runId);
  });

  it('routes direct OpenCode member messages to the alive mixed run when stale provisioning state remains', async () => {
    const teamName = 'mixed-direct-message-stale-provisioning-alive-run-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const currentRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(currentRun);
    currentRun.runId = `run-${teamName}-current`;
    trackLiveRun(svc, currentRun);
    injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'use alive mixed run despite stale provisioning',
        messageId: 'msg-stale-provisioning-alive-mixed',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: currentRun.runId,
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'use alive mixed run despite stale provisioning',
      messageId: 'msg-stale-provisioning-alive-mixed',
    });
  });

  it('routes direct OpenCode member messages to the current pure OpenCode run after same-team relaunch', async () => {
    const teamName = 'pure-opencode-direct-message-current-run-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const first = await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    const second = await svc.launchTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'use current pure opencode run only',
        messageId: 'msg-current-pure-opencode',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: second.runId,
      teamName,
      laneId: 'primary',
      memberName: 'alice',
      cwd: projectPath,
      text: 'use current pure opencode run only',
      messageId: 'msg-current-pure-opencode',
    });
    expect(adapter.messageInputs[0]?.runId).not.toBe(first.runId);
  });

  it('routes direct OpenCode member messages only to the targeted live pure OpenCode team', async () => {
    const firstTeamName = 'pure-opencode-direct-message-live-team-a-safe-e2e';
    const secondTeamName = 'pure-opencode-direct-message-live-team-b-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const first = await svc.createTeam(
      {
        teamName: firstTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    const second = await svc.createTeam(
      {
        teamName: secondTeamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    await expect(
      svc.deliverOpenCodeMemberMessage(secondTeamName, {
        memberName: 'alice',
        text: 'send to the second live pure opencode team only',
        messageId: 'msg-live-pure-opencode-team-b',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: second.runId,
      teamName: secondTeamName,
      laneId: 'primary',
      memberName: 'alice',
      cwd: projectPath,
      text: 'send to the second live pure opencode team only',
      messageId: 'msg-live-pure-opencode-team-b',
    });
    expect(adapter.messageInputs[0]?.runId).not.toBe(first.runId);
    expect(svc.isTeamAlive(firstTeamName)).toBe(true);
    expect(svc.isTeamAlive(secondTeamName)).toBe(true);
  });

  it('routes direct OpenCode member messages to the alive pure OpenCode run when stale provisioning state remains', async () => {
    const teamName = 'pure-opencode-direct-message-stale-provisioning-alive-run-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const current = await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'use alive pure opencode run despite stale provisioning',
        messageId: 'msg-stale-provisioning-alive-pure',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: current.runId,
      teamName,
      laneId: 'primary',
      memberName: 'alice',
      cwd: projectPath,
      text: 'use alive pure opencode run despite stale provisioning',
      messageId: 'msg-stale-provisioning-alive-pure',
    });
  });

  it('delivers direct OpenCode member messages to recovered pure OpenCode lanes after service restart', async () => {
    const teamName = 'pure-opencode-direct-message-recovered-lane-safe-e2e';
    const launchAdapter = new FakeOpenCodeRuntimeAdapter();
    const firstService = new TeamProvisioningService();
    firstService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([launchAdapter]));
    await firstService.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    const messageAdapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([messageAdapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'message recovered pure opencode lane',
        messageId: 'msg-recovered-pure-opencode',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(messageAdapter.messageInputs).toHaveLength(1);
    expect(messageAdapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'primary',
      memberName: 'alice',
      cwd: projectPath,
      text: 'message recovered pure opencode lane',
      messageId: 'msg-recovered-pure-opencode',
    });
    expect(messageAdapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('delivers direct OpenCode member messages to recovered pure OpenCode lanes despite stale terminal provisioning state', async () => {
    const teamName = 'pure-opencode-direct-message-recovered-stale-terminal-safe-e2e';
    await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice'] });
    await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'message recovered pure lane despite stale terminal state',
        messageId: 'msg-recovered-pure-stale-terminal',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'primary',
      memberName: 'alice',
      cwd: projectPath,
      text: 'message recovered pure lane despite stale terminal state',
      messageId: 'msg-recovered-pure-stale-terminal',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('delivers direct OpenCode member messages to recovered pure OpenCode lanes when config is missing', async () => {
    const teamName = 'pure-opencode-direct-message-meta-only-recovered-safe-e2e';
    await writeOpenCodeTeamMeta(teamName, projectPath);
    await writeOpenCodeMembersMeta(teamName, {
      members: ['alice'],
      memberCwd: projectPath,
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'message pure opencode recovered from meta only',
        messageId: 'msg-meta-only-pure-opencode',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'primary',
      memberName: 'alice',
      cwd: projectPath,
      text: 'message pure opencode recovered from meta only',
      messageId: 'msg-meta-only-pure-opencode',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('keeps recovered pure OpenCode direct messages isolated across teams with the same member name', async () => {
    const activeTeamName = 'pure-opencode-direct-message-cross-team-active-safe-e2e';
    const degradedTeamName = 'pure-opencode-direct-message-cross-team-degraded-safe-e2e';
    const activeProjectPath = path.join(tempDir, 'project-active-pure');
    const degradedProjectPath = path.join(tempDir, 'project-degraded-pure');
    await fs.mkdir(activeProjectPath, { recursive: true });
    await fs.mkdir(degradedProjectPath, { recursive: true });
    await writeOpenCodeTeamMeta(activeTeamName, activeProjectPath);
    await writeOpenCodeMembersMeta(activeTeamName, {
      members: ['alice'],
      memberCwd: activeProjectPath,
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName: activeTeamName,
      laneId: 'primary',
      state: 'active',
    });
    await writeOpenCodeTeamMeta(degradedTeamName, degradedProjectPath);
    await writeOpenCodeMembersMeta(degradedTeamName, {
      members: ['alice'],
      memberCwd: degradedProjectPath,
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName: degradedTeamName,
      laneId: 'primary',
      state: 'degraded',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      svc.deliverOpenCodeMemberMessage(activeTeamName, {
        memberName: 'alice',
        text: 'message only active pure team',
        messageId: 'msg-cross-team-active-pure',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    await expect(
      svc.deliverOpenCodeMemberMessage(degradedTeamName, {
        memberName: 'alice',
        text: 'must not reach degraded pure team',
        messageId: 'msg-cross-team-degraded-pure',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName: activeTeamName,
      laneId: 'primary',
      memberName: 'alice',
      cwd: activeProjectPath,
      text: 'message only active pure team',
      messageId: 'msg-cross-team-active-pure',
    });
  });

  it('does not deliver direct OpenCode member messages to stopped pure OpenCode teams', async () => {
    const teamName = 'pure-opencode-direct-message-stopped-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    svc.stopTeam(teamName);
    await waitForCondition(() => adapter.stopInputs.length === 1);
    await waitForCondition(() => !svc.isTeamAlive(teamName));
    expect((await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).lanes).toEqual({});

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'must not reach stopped pure opencode',
        messageId: 'msg-stopped-pure-opencode',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    expect(adapter.messageInputs).toEqual([]);
  });

  it('does not deliver direct OpenCode member messages while a pure OpenCode stop is in flight', async () => {
    const teamName = 'pure-opencode-direct-message-stop-in-flight-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );
    let releaseStop: () => void = () => undefined;
    const stopRelease = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    adapter.stop = (async (input) => {
      adapter.stopInputs.push(input);
      await stopRelease;
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: ['delayed fake stop'],
      };
    }) as typeof adapter.stop;

    svc.stopTeam(teamName);
    await waitForCondition(() => adapter.stopInputs.length === 1);
    try {
      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          text: 'must not reach pure opencode while stop is in flight',
          messageId: 'msg-pure-opencode-stop-in-flight',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      expect(adapter.messageInputs).toEqual([]);
    } finally {
      releaseStop();
      await waitForCondition(() => !svc.isTeamAlive(teamName));
    }
  });

  it('does not deliver direct OpenCode member messages to removed pure OpenCode teammates', async () => {
    const teamName = 'pure-opencode-direct-message-removed-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const { runId } = await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [
          { name: 'alice', role: 'Developer', providerId: 'opencode' },
          { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
        ],
      },
      () => undefined
    );
    await writeOpenCodeMembersMeta(teamName, {
      members: ['alice', 'bob'],
      removedMembers: ['alice'],
    });

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'must not reach removed pure alice',
        messageId: 'msg-removed-pure-alice',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'recipient_removed',
    });
    expect(adapter.messageInputs).toEqual([]);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'active pure bob still receives message',
        messageId: 'msg-active-pure-bob',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId,
      teamName,
      laneId: 'primary',
      memberName: 'bob',
      text: 'active pure bob still receives message',
      messageId: 'msg-active-pure-bob',
    });
  });

  it('delivers direct OpenCode member messages to re-added pure OpenCode teammates when meta is active', async () => {
    const teamName = 'pure-opencode-direct-message-readded-safe-e2e';
    await writeOpenCodeTeamConfig({
      teamName,
      projectPath,
      members: ['alice'],
      removedMembers: ['alice'],
    });
    await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 're-added pure alice should receive message',
        messageId: 'msg-readded-pure-alice',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'primary',
      memberName: 'alice',
      cwd: projectPath,
      text: 're-added pure alice should receive message',
      messageId: 'msg-readded-pure-alice',
    });
  });

  it('delivers direct OpenCode member messages to recovered pure lanes with case-insensitive member input after service restart', async () => {
    const teamName = 'pure-opencode-direct-message-case-insensitive-recovered-safe-e2e';
    await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice'] });
    await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'ALICE',
        text: 'case-insensitive alice reaches recovered pure lane',
        messageId: 'msg-case-insensitive-recovered-pure-alice',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'primary',
      memberName: 'alice',
      cwd: projectPath,
      text: 'case-insensitive alice reaches recovered pure lane',
      messageId: 'msg-case-insensitive-recovered-pure-alice',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('does not deliver direct OpenCode member messages when members meta removed a pure teammate but config and lane index are stale active after service restart', async () => {
    const teamName = 'pure-opencode-direct-message-meta-removed-config-stale-safe-e2e';
    await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice', 'bob'] });
    await writeOpenCodeMembersMeta(teamName, {
      members: ['alice', 'bob'],
      removedMembers: ['alice'],
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      state: 'active',
      diagnostics: ['stale active primary lane while members meta removed alice'],
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'meta removed alice must not receive message despite stale active config',
        messageId: 'msg-meta-removed-config-stale-pure-alice',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'recipient_removed',
    });
    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'active pure bob still receives message despite stale removed sibling',
        messageId: 'msg-meta-removed-config-stale-pure-bob',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'primary',
      memberName: 'bob',
      cwd: projectPath,
      text: 'active pure bob still receives message despite stale removed sibling',
      messageId: 'msg-meta-removed-config-stale-pure-bob',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('does not deliver direct OpenCode member messages to unknown pure OpenCode teammates', async () => {
    const teamName = 'pure-opencode-direct-message-unknown-safe-e2e';
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    await svc.createTeam(
      {
        teamName,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'ghost',
        text: 'must not reach unknown pure member',
        messageId: 'msg-unknown-pure-opencode',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'recipient_is_not_opencode',
    });
    expect(adapter.messageInputs).toEqual([]);
  });

  it('does not deliver direct OpenCode member messages to degraded recovered pure OpenCode primary lanes', async () => {
    const teamName = 'pure-opencode-direct-message-degraded-lane-safe-e2e';
    await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice'] });
    await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      state: 'degraded',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'must not reach degraded pure opencode lane',
        messageId: 'msg-degraded-pure-opencode',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    expect(adapter.messageInputs).toEqual([]);
  });

  it('does not deliver direct OpenCode member messages to degraded pure OpenCode lanes despite stale terminal provisioning state', async () => {
    const teamName = 'pure-opencode-direct-message-degraded-stale-terminal-safe-e2e';
    await writeOpenCodeTeamConfig({ teamName, projectPath, members: ['alice'] });
    await writeOpenCodeMembersMeta(teamName, { members: ['alice'] });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      state: 'degraded',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'alice',
        text: 'must not reach degraded pure opencode despite stale terminal state',
        messageId: 'msg-degraded-pure-stale-terminal',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    expect(adapter.messageInputs).toEqual([]);
  });

  it('does not deliver direct OpenCode member messages to stopped mixed OpenCode secondary lanes', async () => {
    const teamName = 'mixed-opencode-direct-message-stopped-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    run.child = { kill: () => undefined };
    trackLiveRun(svc, run);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);

    svc.stopTeam(teamName);
    await waitForCondition(() => adapter.stopInputs.length === 2);
    await waitForCondition(() => !svc.isTeamAlive(teamName));
    expect((await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).lanes).toEqual({});

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'must not reach stopped mixed opencode lane',
        messageId: 'msg-stopped-mixed-opencode',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    expect(adapter.messageInputs).toEqual([]);
  });

  it('does not deliver direct OpenCode member messages to one detached mixed lane while its sibling lane stays live', async () => {
    const teamName = 'mixed-opencode-direct-message-one-detached-lane-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    run.child = { kill: () => undefined };
    trackLiveRun(svc, run);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      runId: adapter.launchInputs.find((input) => input.laneId === 'secondary:opencode:bob')
        ?.runId,
      teamName,
      laneId: 'secondary:opencode:bob',
      reason: 'cleanup',
    });
    expect(
      run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
    ).toEqual(['tom']);
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'must not reach the detached mixed bob lane',
        messageId: 'msg-one-detached-mixed-bob',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'tom',
        text: 'active mixed tom lane still receives direct message',
        messageId: 'msg-one-detached-mixed-tom',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: run.runId,
      teamName,
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      cwd: projectPath,
      text: 'active mixed tom lane still receives direct message',
      messageId: 'msg-one-detached-mixed-tom',
    });
  });

  it('delivers direct OpenCode member messages to live mixed lanes with case-insensitive member input', async () => {
    const teamName = 'mixed-opencode-direct-message-live-case-insensitive-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    run.child = { kill: () => undefined };
    trackLiveRun(svc, run);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'BOB',
        text: 'case-insensitive bob reaches live mixed lane',
        messageId: 'msg-live-case-insensitive-mixed-bob',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: run.runId,
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'case-insensitive bob reaches live mixed lane',
      messageId: 'msg-live-case-insensitive-mixed-bob',
    });
  });

  it('does not let stale active lane index resurrect direct OpenCode messages to a detached mixed lane', async () => {
    const teamName = 'mixed-opencode-direct-message-detached-stale-index-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    run.child = { kill: () => undefined };
    trackLiveRun(svc, run);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
      diagnostics: ['stale active lane index entry'],
    });

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'stale active lane index must not revive detached bob',
        messageId: 'msg-detached-stale-index-bob',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'tom',
        text: 'live tom still receives message despite stale bob index',
        messageId: 'msg-detached-stale-index-tom',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: run.runId,
      teamName,
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      cwd: projectPath,
      text: 'live tom still receives message despite stale bob index',
      messageId: 'msg-detached-stale-index-tom',
    });
  });

  it('delivers direct OpenCode member messages to a reattached mixed lane after detach rejected stale delivery', async () => {
    const teamName = 'mixed-opencode-direct-message-reattached-lane-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    run.child = { kill: () => undefined };
    trackLiveRun(svc, run);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'detached bob must not receive message before reattach',
        messageId: 'msg-detached-before-reattach-bob',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    expect(adapter.messageInputs).toEqual([]);

    await svc.reattachOpenCodeOwnedMemberLane(teamName, 'bob', { reason: 'member_updated' });

    await waitForCondition(() => adapter.launchInputs.length === 3);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    expect(
      run.mixedSecondaryLanes
        .map((lane: { member: { name: string } }) => lane.member.name)
        .sort()
    ).toEqual(['bob', 'tom']);
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'reattached bob receives direct message',
        messageId: 'msg-reattached-mixed-bob',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: run.runId,
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'reattached bob receives direct message',
      messageId: 'msg-reattached-mixed-bob',
    });
  });

  it('keeps direct OpenCode member messages scoped when detaching one of two mixed teams with the same member name', async () => {
    const firstTeamName = 'mixed-opencode-direct-detach-cross-team-a-safe-e2e';
    const secondTeamName = 'mixed-opencode-direct-detach-cross-team-b-safe-e2e';
    await writeMixedTeamConfig({ teamName: firstTeamName, projectPath });
    await writeTeamMeta(firstTeamName, projectPath);
    await writeMembersMeta(firstTeamName);
    await writeMixedTeamConfig({ teamName: secondTeamName, projectPath });
    await writeTeamMeta(secondTeamName, projectPath);
    await writeMembersMeta(secondTeamName);
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const firstRun = createMixedLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createMixedLiveRun({ teamName: secondTeamName, projectPath });
    firstRun.child = { kill: () => undefined };
    secondRun.child = { kill: () => undefined };
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(firstRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(secondRun);
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      firstRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(() =>
      secondRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.detachOpenCodeOwnedMemberLane(secondTeamName, 'bob');

    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      teamName: secondTeamName,
      laneId: 'secondary:opencode:bob',
      reason: 'cleanup',
    });
    expect(
      firstRun.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
    ).toEqual(['bob', 'tom']);
    expect(
      secondRun.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
    ).toEqual(['tom']);

    await expect(
      svc.deliverOpenCodeMemberMessage(firstTeamName, {
        memberName: 'bob',
        text: 'first team bob still receives direct message',
        messageId: 'msg-cross-team-detach-first-bob',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    await expect(
      svc.deliverOpenCodeMemberMessage(secondTeamName, {
        memberName: 'bob',
        text: 'second team detached bob must not receive direct message',
        messageId: 'msg-cross-team-detach-second-bob',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    await expect(
      svc.deliverOpenCodeMemberMessage(secondTeamName, {
        memberName: 'tom',
        text: 'second team tom still receives direct message',
        messageId: 'msg-cross-team-detach-second-tom',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(2);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: firstRun.runId,
      teamName: firstTeamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'first team bob still receives direct message',
      messageId: 'msg-cross-team-detach-first-bob',
    });
    expect(adapter.messageInputs[1]).toMatchObject({
      runId: secondRun.runId,
      teamName: secondTeamName,
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      cwd: projectPath,
      text: 'second team tom still receives direct message',
      messageId: 'msg-cross-team-detach-second-tom',
    });
  });

  it('does not deliver direct OpenCode member messages while mixed OpenCode stop is in flight', async () => {
    const teamName = 'mixed-opencode-direct-message-stop-in-flight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    run.child = { kill: () => undefined };
    trackLiveRun(svc, run);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    let releaseStop: () => void = () => undefined;
    const stopRelease = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    adapter.stop = (async (input) => {
      adapter.stopInputs.push(input);
      await stopRelease;
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: ['delayed fake stop'],
      };
    }) as typeof adapter.stop;

    svc.stopTeam(teamName);
    await waitForCondition(() => adapter.stopInputs.length === 1);
    try {
      await expect(
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          text: 'must not reach mixed opencode while stop is in flight',
          messageId: 'msg-mixed-opencode-stop-in-flight',
        })
      ).resolves.toEqual({
        delivered: false,
        reason: 'opencode_runtime_not_active',
      });
      expect(adapter.messageInputs).toEqual([]);
    } finally {
      releaseStop();
      await waitForCondition(() => adapter.stopInputs.length === 2);
      await waitForCondition(() => !svc.isTeamAlive(teamName));
    }
  });

  it('delivers direct OpenCode member messages to recovered mixed OpenCode secondary lanes after service restart', async () => {
    const teamName = 'mixed-opencode-direct-message-recovered-lane-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'message recovered mixed opencode lane',
        messageId: 'msg-recovered-mixed-opencode',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'message recovered mixed opencode lane',
      messageId: 'msg-recovered-mixed-opencode',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('does not deliver direct OpenCode member messages to a removed mixed teammate despite stale active lane index after service restart', async () => {
    const teamName = 'mixed-opencode-direct-message-removed-stale-index-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, removedMembers: ['bob'] });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName, { removedMembers: ['bob'] });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
      diagnostics: ['stale removed bob lane index entry'],
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'removed bob must not receive message despite stale active lane index',
        messageId: 'msg-removed-stale-index-mixed-bob',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'recipient_removed',
    });
    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'tom',
        text: 'active tom still receives message despite removed bob stale index',
        messageId: 'msg-removed-stale-index-mixed-tom',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      cwd: projectPath,
      text: 'active tom still receives message despite removed bob stale index',
      messageId: 'msg-removed-stale-index-mixed-tom',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('does not deliver direct OpenCode member messages when members meta removed a mixed teammate but config and lane index are stale active after service restart', async () => {
    const teamName = 'mixed-opencode-direct-message-meta-removed-config-stale-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName, { removedMembers: ['bob'] });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
      diagnostics: ['stale active lane index while members meta removed bob'],
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'meta removed bob must not receive message despite stale active config',
        messageId: 'msg-meta-removed-config-stale-mixed-bob',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'recipient_removed',
    });
    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'tom',
        text: 'active tom still receives message despite stale removed sibling',
        messageId: 'msg-meta-removed-config-stale-mixed-tom',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      cwd: projectPath,
      text: 'active tom still receives message despite stale removed sibling',
      messageId: 'msg-meta-removed-config-stale-mixed-tom',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('does not let an orphan active mixed OpenCode lane index entry create a direct message recipient after service restart', async () => {
    const teamName = 'mixed-opencode-direct-message-orphan-lane-index-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:ghost',
      state: 'active',
      diagnostics: ['orphan active lane index entry without roster member'],
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'ghost',
        text: 'orphan active lane index must not create ghost recipient',
        messageId: 'msg-orphan-lane-index-ghost',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'recipient_is_not_opencode',
    });
    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'tom',
        text: 'active tom still receives message despite orphan sibling lane',
        messageId: 'msg-orphan-lane-index-tom',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      cwd: projectPath,
      text: 'active tom still receives message despite orphan sibling lane',
      messageId: 'msg-orphan-lane-index-tom',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('delivers direct OpenCode member messages to recovered mixed lanes with case-insensitive member input after service restart', async () => {
    const teamName = 'mixed-opencode-direct-message-case-insensitive-recovered-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'BOB',
        text: 'case-insensitive bob reaches recovered mixed lane',
        messageId: 'msg-case-insensitive-recovered-mixed-bob',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'case-insensitive bob reaches recovered mixed lane',
      messageId: 'msg-case-insensitive-recovered-mixed-bob',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('delivers direct OpenCode member messages after a removed mixed teammate is reattached with a stale active lane index', async () => {
    const teamName = 'mixed-opencode-direct-message-removed-reattached-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, removedMembers: ['bob'] });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName, { removedMembers: ['bob'] });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
      diagnostics: ['stale active lane index while bob was removed'],
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'removed bob must not receive message before reattach',
        messageId: 'msg-removed-before-reattach-mixed-bob',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'recipient_removed',
    });
    expect(adapter.messageInputs).toEqual([]);

    await writeMixedTeamConfig({ teamName, projectPath });
    await writeMembersMeta(teamName);

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'reattached bob receives message after removed state is cleared',
        messageId: 'msg-removed-reattached-mixed-bob',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'reattached bob receives message after removed state is cleared',
      messageId: 'msg-removed-reattached-mixed-bob',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('delivers direct OpenCode member messages to recovered mixed OpenCode lanes despite stale terminal provisioning state', async () => {
    const teamName = 'mixed-opencode-direct-message-recovered-stale-terminal-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'message recovered mixed lane despite stale terminal state',
        messageId: 'msg-recovered-mixed-stale-terminal',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'message recovered mixed lane despite stale terminal state',
      messageId: 'msg-recovered-mixed-stale-terminal',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('delivers direct OpenCode member messages to recovered mixed OpenCode lanes when config is missing', async () => {
    const teamName = 'mixed-opencode-direct-message-meta-only-recovered-safe-e2e';
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName, { memberCwd: projectPath });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'message mixed opencode recovered from meta only',
        messageId: 'msg-meta-only-mixed-opencode',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 'message mixed opencode recovered from meta only',
      messageId: 'msg-meta-only-mixed-opencode',
    });
    expect(adapter.messageInputs[0]?.runId).toBeUndefined();
  });

  it('keeps recovered mixed OpenCode direct messages isolated across teams with the same member name', async () => {
    const activeTeamName = 'mixed-opencode-direct-message-cross-team-active-safe-e2e';
    const degradedTeamName = 'mixed-opencode-direct-message-cross-team-degraded-safe-e2e';
    const activeProjectPath = path.join(tempDir, 'project-active-mixed');
    const degradedProjectPath = path.join(tempDir, 'project-degraded-mixed');
    await fs.mkdir(activeProjectPath, { recursive: true });
    await fs.mkdir(degradedProjectPath, { recursive: true });
    await writeTeamMeta(activeTeamName, activeProjectPath);
    await writeMembersMeta(activeTeamName, { memberCwd: activeProjectPath });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName: activeTeamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await writeTeamMeta(degradedTeamName, degradedProjectPath);
    await writeMembersMeta(degradedTeamName, { memberCwd: degradedProjectPath });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName: degradedTeamName,
      laneId: 'secondary:opencode:bob',
      state: 'degraded',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      svc.deliverOpenCodeMemberMessage(activeTeamName, {
        memberName: 'bob',
        text: 'message only active mixed team',
        messageId: 'msg-cross-team-active-mixed',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    await expect(
      svc.deliverOpenCodeMemberMessage(degradedTeamName, {
        memberName: 'bob',
        text: 'must not reach degraded mixed team',
        messageId: 'msg-cross-team-degraded-mixed',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });

    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      teamName: activeTeamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: activeProjectPath,
      text: 'message only active mixed team',
      messageId: 'msg-cross-team-active-mixed',
    });
  });

  it('does not deliver direct OpenCode member messages to degraded recovered mixed OpenCode lanes', async () => {
    const teamName = 'mixed-opencode-direct-message-degraded-lane-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'degraded',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const restartedService = new TeamProvisioningService();
    restartedService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await expect(
      restartedService.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'must not reach degraded mixed opencode lane',
        messageId: 'msg-degraded-mixed-opencode',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    expect(adapter.messageInputs).toEqual([]);
  });

  it('does not deliver direct OpenCode member messages to degraded mixed OpenCode lanes despite stale terminal provisioning state', async () => {
    const teamName = 'mixed-opencode-direct-message-degraded-stale-terminal-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'degraded',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    injectStaleTerminalProvisioningRun(svc, teamName, `run-${teamName}-stale`);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'must not reach degraded mixed opencode despite stale terminal state',
        messageId: 'msg-degraded-mixed-stale-terminal',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    expect(adapter.messageInputs).toEqual([]);
  });

  it('does not deliver direct OpenCode member messages to removed Anthropic and Gemini mixed teammates', async () => {
    const teamName = 'mixed-anthropic-gemini-direct-message-removed-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
      removedMembers: ['bob'],
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(run);
    trackLiveRun(svc, run);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 'must not reach removed bob',
        messageId: 'msg-removed-bob',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'recipient_removed',
    });
    expect(adapter.messageInputs).toEqual([]);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'tom',
        text: 'active tom still receives direct opencode message',
        messageId: 'msg-active-tom',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: run.runId,
      teamName,
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      cwd: projectPath,
      text: 'active tom still receives direct opencode message',
      messageId: 'msg-active-tom',
    });
  });

  it('delivers direct OpenCode member messages to re-added Anthropic and Gemini mixed teammates when meta is active', async () => {
    const teamName = 'mixed-anthropic-gemini-direct-message-readded-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
      removedMembers: ['bob'],
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(run);
    trackLiveRun(svc, run);

    await expect(
      svc.deliverOpenCodeMemberMessage(teamName, {
        memberName: 'bob',
        text: 're-added bob should receive direct opencode message',
        messageId: 'msg-readded-bob',
      })
    ).resolves.toEqual({
      delivered: true,
      diagnostics: [],
    });
    expect(adapter.messageInputs).toHaveLength(1);
    expect(adapter.messageInputs[0]).toMatchObject({
      runId: run.runId,
      teamName,
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: projectPath,
      text: 're-added bob should receive direct opencode message',
      messageId: 'msg-readded-bob',
    });
  });

  it('stops the current Anthropic and Gemini mixed run instead of a stale same-team run', async () => {
    const teamName = 'mixed-anthropic-gemini-stop-current-run-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const staleRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const currentRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(staleRun);
    addGeminiPrimaryToMixedRun(currentRun);
    staleRun.runId = `run-${teamName}-stale`;
    currentRun.runId = `run-${teamName}-current`;
    let staleKillCount = 0;
    let currentKillCount = 0;
    staleRun.child = { pid: 64901, kill: () => (staleKillCount += 1), stdin: { writable: true } };
    currentRun.child = {
      pid: 64902,
      kill: () => (currentKillCount += 1),
      stdin: { writable: true },
    };
    trackLiveRun(svc, staleRun);
    trackLiveRun(svc, currentRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(currentRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expectDirectChildKillCount(staleKillCount, 0);
    expectDirectChildKillCount(currentKillCount, 1);
    expect(staleRun.cancelRequested).toBe(false);
    expect(currentRun.cancelRequested).toBe(true);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(await svc.getRuntimeState(teamName)).toMatchObject({
      teamName,
      isAlive: false,
      runId: null,
      progress: null,
    });
  });

  it('cancels a stale Anthropic and Gemini mixed run without stopping current OpenCode lanes', async () => {
    const teamName = 'mixed-anthropic-gemini-cancel-stale-run-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const staleRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const currentRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(staleRun);
    addGeminiPrimaryToMixedRun(currentRun);
    staleRun.runId = `run-${teamName}-stale`;
    currentRun.runId = `run-${teamName}-current`;
    let staleKillCount = 0;
    let currentKillCount = 0;
    staleRun.child = { pid: 65001, kill: () => (staleKillCount += 1), stdin: { writable: true } };
    currentRun.child = {
      pid: 65002,
      kill: () => (currentKillCount += 1),
      stdin: createWritableStdin([]),
    };
    trackLiveRun(svc, staleRun);
    trackLiveRun(svc, currentRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(currentRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    await svc.cancelProvisioning(staleRun.runId);

    expectDirectChildKillCount(staleKillCount, 1);
    expectDirectChildKillCount(currentKillCount, 0);
    expect(staleRun.cancelRequested).toBe(true);
    expect(currentRun.cancelRequested).toBe(false);
    expect(adapter.stopInputs).toEqual([]);
    expect(svc.isTeamAlive(teamName)).toBe(true);
    expect(await svc.getRuntimeState(teamName)).toMatchObject({
      teamName,
      isAlive: true,
      runId: currentRun.runId,
    });

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      currentRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.reviewer).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('stops the current pure Anthropic run instead of a stale same-team run', async () => {
    const teamName = 'pure-anthropic-stop-current-run-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
    const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
    staleRun.runId = `run-${teamName}-stale`;
    currentRun.runId = `run-${teamName}-current`;
    let staleKillCount = 0;
    let currentKillCount = 0;
    staleRun.child = { pid: 63101, kill: () => (staleKillCount += 1), stdin: { writable: true } };
    currentRun.child = {
      pid: 63102,
      kill: () => (currentKillCount += 1),
      stdin: { writable: true },
    };
    trackLiveRun(svc, staleRun);
    trackLiveRun(svc, currentRun);

    expect(await svc.getRuntimeState(teamName)).toMatchObject({
      teamName,
      isAlive: true,
      runId: currentRun.runId,
    });

    svc.stopTeam(teamName);

    expectDirectChildKillCount(staleKillCount, 0);
    expectDirectChildKillCount(currentKillCount, 1);
    expect(staleRun.cancelRequested).toBe(false);
    expect(currentRun.cancelRequested).toBe(true);
    expect(await svc.getRuntimeState(teamName)).toMatchObject({
      teamName,
      isAlive: false,
      runId: null,
      progress: null,
    });
  });

  it('cancels a stale pure Anthropic run without stopping the current same-team run', async () => {
    const teamName = 'pure-anthropic-cancel-stale-run-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
    const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
    staleRun.runId = `run-${teamName}-stale`;
    currentRun.runId = `run-${teamName}-current`;
    let staleKillCount = 0;
    let currentKillCount = 0;
    staleRun.child = { pid: 63301, kill: () => (staleKillCount += 1), stdin: { writable: true } };
    currentRun.child = {
      pid: 63302,
      kill: () => (currentKillCount += 1),
      stdin: createWritableStdin([]),
    };
    trackLiveRun(svc, staleRun);
    trackLiveRun(svc, currentRun);

    await svc.cancelProvisioning(staleRun.runId);

    expectDirectChildKillCount(staleKillCount, 1);
    expectDirectChildKillCount(currentKillCount, 0);
    expect(staleRun.cancelRequested).toBe(true);
    expect(currentRun.cancelRequested).toBe(false);
    expect(svc.isTeamAlive(teamName)).toBe(true);
    expect(await svc.getRuntimeState(teamName)).toMatchObject({
      teamName,
      isAlive: true,
      runId: currentRun.runId,
    });

    await svc.sendMessageToTeam(teamName, 'current run still receives messages');
  });

  it('cancels the current pure Anthropic run without resurrecting a stale same-team run', async () => {
    const teamName = 'pure-anthropic-cancel-current-no-stale-resurrect-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
    const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
    staleRun.runId = `run-${teamName}-stale`;
    currentRun.runId = `run-${teamName}-current`;
    let staleKillCount = 0;
    let currentKillCount = 0;
    staleRun.child = { pid: 63501, kill: () => (staleKillCount += 1), stdin: { writable: true } };
    currentRun.child = {
      pid: 63502,
      kill: () => (currentKillCount += 1),
      stdin: createWritableStdin([]),
    };
    trackLiveRun(svc, staleRun);
    trackLiveRun(svc, currentRun);

    await svc.cancelProvisioning(currentRun.runId);

    expectDirectChildKillCount(staleKillCount, 0);
    expectDirectChildKillCount(currentKillCount, 1);
    expect(staleRun.cancelRequested).toBe(false);
    expect(currentRun.cancelRequested).toBe(true);
    expect(svc.isTeamAlive(teamName)).toBe(false);
    expect(await svc.getRuntimeState(teamName)).toMatchObject({
      teamName,
      isAlive: false,
      runId: null,
      progress: null,
    });
    await expect(svc.sendMessageToTeam(teamName, 'must not hit stale run')).rejects.toThrow(
      `No active process for team "${teamName}"`
    );
  });

  it('refreshes runtime snapshot cache after same-team pure Anthropic relaunch', async () => {
    const teamName = 'pure-anthropic-runtime-cache-relaunch-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const staleRun = createPureAnthropicLiveRun({ teamName, projectPath });
    staleRun.runId = `run-${teamName}-stale`;
    staleRun.child = { pid: 64101, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, staleRun);
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, pid: 64102, model: 'haiku-stale' }],
        ['bob', { alive: true, pid: 64103, model: 'sonnet-stale' }],
      ]);
    (svc as any).readProcessRssBytesByPid = async (pids: number[]) =>
      new Map(pids.map((pid) => [pid, pid * 1_000]));

    const staleSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(staleSnapshot).toMatchObject({
      runId: staleRun.runId,
      members: {
        'team-lead': { pid: 64101, rssBytes: 64_101_000 },
        alice: { pid: 64102, rssBytes: 64_102_000, runtimeModel: 'haiku-stale' },
        bob: { pid: 64103, rssBytes: 64_103_000, runtimeModel: 'sonnet-stale' },
      },
    });

    const currentRun = createPureAnthropicLiveRun({ teamName, projectPath });
    currentRun.runId = `run-${teamName}-current`;
    currentRun.child = { pid: 64201, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, currentRun);
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, pid: 64202, model: 'haiku-current' }],
        ['bob', { alive: true, pid: 64203, model: 'sonnet-current' }],
      ]);

    const currentSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(currentSnapshot).toMatchObject({
      runId: currentRun.runId,
      members: {
        'team-lead': { pid: 64201, rssBytes: 64_201_000 },
        alice: { pid: 64202, rssBytes: 64_202_000, runtimeModel: 'haiku-current' },
        bob: { pid: 64203, rssBytes: 64_203_000, runtimeModel: 'sonnet-current' },
      },
    });
  });

  it('does not reuse stopped pure Anthropic runtime cache after relaunch', async () => {
    const teamName = 'pure-anthropic-runtime-cache-stop-relaunch-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const firstRun = createPureAnthropicLiveRun({ teamName, projectPath });
    firstRun.runId = `run-${teamName}-first`;
    firstRun.child = { pid: 64501, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, firstRun);
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, pid: 64502, model: 'haiku-before-stop' }],
        ['bob', { alive: true, pid: 64503, model: 'sonnet-before-stop' }],
      ]);
    (svc as any).readProcessRssBytesByPid = async (pids: number[]) =>
      new Map(pids.map((pid) => [pid, pid * 1_000]));

    const beforeStop = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(beforeStop).toMatchObject({
      runId: firstRun.runId,
      members: {
        'team-lead': { pid: 64501, rssBytes: 64_501_000 },
        alice: { pid: 64502, rssBytes: 64_502_000, runtimeModel: 'haiku-before-stop' },
      },
    });

    svc.stopTeam(teamName);

    const secondRun = createPureAnthropicLiveRun({ teamName, projectPath });
    secondRun.runId = `run-${teamName}-second`;
    secondRun.child = { pid: 64601, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, secondRun);
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, pid: 64602, model: 'haiku-after-relaunch' }],
        ['bob', { alive: true, pid: 64603, model: 'sonnet-after-relaunch' }],
      ]);

    const afterRelaunch = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(afterRelaunch).toMatchObject({
      runId: secondRun.runId,
      members: {
        'team-lead': { pid: 64601, rssBytes: 64_601_000 },
        alice: { pid: 64602, rssBytes: 64_602_000, runtimeModel: 'haiku-after-relaunch' },
        bob: { pid: 64603, rssBytes: 64_603_000, runtimeModel: 'sonnet-after-relaunch' },
      },
    });
  });

  it('refreshes runtime snapshot cache after same-team Anthropic and Gemini mixed relaunch', async () => {
    const teamName = 'mixed-anthropic-gemini-runtime-cache-relaunch-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const svc = new TeamProvisioningService();
    const staleRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(staleRun);
    staleRun.runId = `run-${teamName}-stale`;
    staleRun.child = { pid: 64701, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, staleRun);
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, pid: 64702, model: 'haiku-stale' }],
        ['reviewer', { alive: true, pid: 64703, model: 'gemini-stale' }],
        ['bob', { alive: true, pid: 64704, model: 'opencode/minimax-stale' }],
        ['tom', { alive: true, pid: 64705, model: 'opencode/nemotron-stale' }],
      ]);
    (svc as any).readProcessRssBytesByPid = async (pids: number[]) =>
      new Map(pids.map((pid) => [pid, pid * 1_000]));

    const staleSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(staleSnapshot).toMatchObject({
      runId: staleRun.runId,
      members: {
        'team-lead': { pid: 64701, rssBytes: 64_701_000 },
        alice: { pid: 64702, rssBytes: 64_702_000, runtimeModel: 'haiku-stale' },
        reviewer: { pid: 64703, rssBytes: 64_703_000, runtimeModel: 'gemini-stale' },
        bob: { pid: 64704, rssBytes: 64_704_000, runtimeModel: 'opencode/minimax-stale' },
        tom: { pid: 64705, rssBytes: 64_705_000, runtimeModel: 'opencode/nemotron-stale' },
      },
    });

    const currentRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(currentRun);
    currentRun.runId = `run-${teamName}-current`;
    currentRun.child = { pid: 64801, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, currentRun);
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        ['alice', { alive: true, pid: 64802, model: 'haiku-current' }],
        ['reviewer', { alive: true, pid: 64803, model: 'gemini-current' }],
        ['bob', { alive: true, pid: 64804, model: 'opencode/minimax-current' }],
        ['tom', { alive: true, pid: 64805, model: 'opencode/nemotron-current' }],
      ]);

    const currentSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(currentSnapshot).toMatchObject({
      runId: currentRun.runId,
      members: {
        'team-lead': { pid: 64801, rssBytes: 64_801_000 },
        alice: { pid: 64802, rssBytes: 64_802_000, runtimeModel: 'haiku-current' },
        reviewer: { pid: 64803, rssBytes: 64_803_000, runtimeModel: 'gemini-current' },
        bob: { pid: 64804, rssBytes: 64_804_000, runtimeModel: 'opencode/minimax-current' },
        tom: { pid: 64805, rssBytes: 64_805_000, runtimeModel: 'opencode/nemotron-current' },
      },
    });
  });

  it('rejects messages to a stopped pure Anthropic team while another team remains sendable', async () => {
    const stoppedTeamName = 'pure-anthropic-message-stopped-safe-e2e';
    const liveTeamName = 'pure-anthropic-message-live-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName: stoppedTeamName, projectPath });
    await writePureAnthropicTeamMeta(stoppedTeamName, projectPath);
    await writePureAnthropicMembersMeta(stoppedTeamName);
    await writePureAnthropicTeamConfig({ teamName: liveTeamName, projectPath });
    await writePureAnthropicTeamMeta(liveTeamName, projectPath);
    await writePureAnthropicMembersMeta(liveTeamName);
    const svc = new TeamProvisioningService();
    const stoppedRun = createPureAnthropicLiveRun({ teamName: stoppedTeamName, projectPath });
    const liveRun = createPureAnthropicLiveRun({ teamName: liveTeamName, projectPath });
    stoppedRun.child = { kill: () => undefined, stdin: { writable: true } };
    liveRun.child = { stdin: { writable: true } };
    trackLiveRun(svc, stoppedRun);
    trackLiveRun(svc, liveRun);
    const delivered: Array<{ teamName: string; message: string }> = [];
    (svc as any).sendMessageToRun = async (run: { teamName: string }, message: string) => {
      delivered.push({ teamName: run.teamName, message });
    };

    svc.stopTeam(stoppedTeamName);

    await expect(svc.sendMessageToTeam(stoppedTeamName, 'should not send')).rejects.toThrow(
      `No active process for team "${stoppedTeamName}"`
    );
    await svc.sendMessageToTeam(liveTeamName, 'still alive');

    expect(delivered).toEqual([{ teamName: liveTeamName, message: 'still alive' }]);
    expect(svc.isTeamAlive(stoppedTeamName)).toBe(false);
    expect(svc.isTeamAlive(liveTeamName)).toBe(true);
  });

  it('rejects messages when a pure Anthropic team stdin is not writable without marking it dead', async () => {
    const teamName = 'pure-anthropic-message-stdin-closed-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.child = { stdin: { writable: false } };
    trackLiveRun(svc, run);

    await expect(svc.sendMessageToTeam(teamName, 'will fail')).rejects.toThrow(
      `Team "${teamName}" process stdin is not writable`
    );

    expect(svc.isTeamAlive(teamName)).toBe(true);
    expect(run.cancelRequested).toBe(false);
    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('keeps runtime pid and memory snapshots isolated across two pure Anthropic teams', async () => {
    const firstTeamName = 'pure-anthropic-runtime-snapshot-a-safe-e2e';
    const secondTeamName = 'pure-anthropic-runtime-snapshot-b-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName: firstTeamName, projectPath });
    await writePureAnthropicTeamMeta(firstTeamName, projectPath);
    await writePureAnthropicMembersMeta(firstTeamName);
    await writePureAnthropicTeamConfig({ teamName: secondTeamName, projectPath });
    await writePureAnthropicTeamMeta(secondTeamName, projectPath);
    await writePureAnthropicMembersMeta(secondTeamName);
    const svc = new TeamProvisioningService();
    const firstRun = createPureAnthropicLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createPureAnthropicLiveRun({ teamName: secondTeamName, projectPath });
    firstRun.child = { pid: 50101, kill: () => undefined, stdin: { writable: true } };
    secondRun.child = { pid: 50201, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);
    (svc as any).getLiveTeamAgentRuntimeMetadata = async (teamName: string) =>
      new Map(
        teamName === firstTeamName
          ? [
              ['alice', { alive: true, pid: 50102, model: 'haiku-runtime' }],
              ['bob', { alive: true, pid: 50103, model: 'sonnet-runtime' }],
            ]
          : [
              ['alice', { alive: true, pid: 50202, model: 'haiku-runtime' }],
              ['bob', { alive: true, pid: 50203, model: 'sonnet-runtime' }],
            ]
      );
    (svc as any).readProcessRssBytesByPid = async (pids: number[]) =>
      new Map(pids.map((pid) => [pid, pid * 1_000]));

    const firstSnapshot = await svc.getTeamAgentRuntimeSnapshot(firstTeamName);
    const secondSnapshot = await svc.getTeamAgentRuntimeSnapshot(secondTeamName);

    expect(firstSnapshot.members['team-lead']).toMatchObject({
      alive: true,
      pid: 50101,
      rssBytes: 50_101_000,
      runtimeModel: 'sonnet',
    });
    expect(firstSnapshot.members.alice).toMatchObject({
      alive: true,
      pid: 50102,
      rssBytes: 50_102_000,
      providerId: 'anthropic',
      runtimeModel: 'haiku-runtime',
    });
    expect(firstSnapshot.members.bob).toMatchObject({
      alive: true,
      pid: 50103,
      rssBytes: 50_103_000,
      providerId: 'anthropic',
      runtimeModel: 'sonnet-runtime',
    });
    expect(secondSnapshot.members['team-lead']).toMatchObject({
      alive: true,
      pid: 50201,
      rssBytes: 50_201_000,
      runtimeModel: 'sonnet',
    });
    expect(secondSnapshot.members.alice).toMatchObject({
      alive: true,
      pid: 50202,
      rssBytes: 50_202_000,
      providerId: 'anthropic',
      runtimeModel: 'haiku-runtime',
    });
    expect(secondSnapshot.members.bob).toMatchObject({
      alive: true,
      pid: 50203,
      rssBytes: 50_203_000,
      providerId: 'anthropic',
      runtimeModel: 'sonnet-runtime',
    });
  });

  it('clears cached runtime pid and memory after stopping one pure Anthropic team', async () => {
    const stoppedTeamName = 'pure-anthropic-runtime-cache-stopped-safe-e2e';
    const liveTeamName = 'pure-anthropic-runtime-cache-live-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName: stoppedTeamName, projectPath });
    await writePureAnthropicTeamMeta(stoppedTeamName, projectPath);
    await writePureAnthropicMembersMeta(stoppedTeamName);
    await writePureAnthropicTeamConfig({ teamName: liveTeamName, projectPath });
    await writePureAnthropicTeamMeta(liveTeamName, projectPath);
    await writePureAnthropicMembersMeta(liveTeamName);
    const svc = new TeamProvisioningService();
    const stoppedRun = createPureAnthropicLiveRun({ teamName: stoppedTeamName, projectPath });
    const liveRun = createPureAnthropicLiveRun({ teamName: liveTeamName, projectPath });
    stoppedRun.child = { pid: 60101, kill: () => undefined, stdin: { writable: true } };
    liveRun.child = { pid: 60201, kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, stoppedRun);
    trackLiveRun(svc, liveRun);
    (svc as any).getLiveTeamAgentRuntimeMetadata = async (teamName: string) => {
      if (!svc.isTeamAlive(teamName)) {
        return new Map();
      }
      return new Map(
        teamName === stoppedTeamName
          ? [
              ['alice', { alive: true, pid: 60102, model: 'haiku-runtime' }],
              ['bob', { alive: true, pid: 60103, model: 'sonnet-runtime' }],
            ]
          : [
              ['alice', { alive: true, pid: 60202, model: 'haiku-runtime' }],
              ['bob', { alive: true, pid: 60203, model: 'sonnet-runtime' }],
            ]
      );
    };
    (svc as any).readProcessRssBytesByPid = async (pids: number[]) =>
      new Map(pids.map((pid) => [pid, pid * 1_000]));

    const beforeStop = await svc.getTeamAgentRuntimeSnapshot(stoppedTeamName);
    expect(beforeStop.members['team-lead']).toMatchObject({
      alive: true,
      pid: 60101,
      rssBytes: 60_101_000,
    });

    svc.stopTeam(stoppedTeamName);

    const stoppedSnapshot = await svc.getTeamAgentRuntimeSnapshot(stoppedTeamName);
    const liveSnapshot = await svc.getTeamAgentRuntimeSnapshot(liveTeamName);
    expect(stoppedSnapshot.members['team-lead']).toMatchObject({ alive: false });
    expect(stoppedSnapshot.members['team-lead']?.pid).toBeUndefined();
    expect(stoppedSnapshot.members.alice).toMatchObject({ alive: false });
    expect(stoppedSnapshot.members.alice?.pid).toBeUndefined();
    expect(liveSnapshot.members['team-lead']).toMatchObject({
      alive: true,
      pid: 60201,
      rssBytes: 60_201_000,
    });
    expect(liveSnapshot.members.alice).toMatchObject({
      alive: true,
      pid: 60202,
      rssBytes: 60_202_000,
    });
  });

  it('reports lead activity as active for a live team and offline after stop', async () => {
    const teamName = 'pure-anthropic-lead-activity-stop-safe-e2e';
    await writePureAnthropicTeamConfig({ teamName, projectPath });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.child = { kill: () => undefined, stdin: { writable: true } };
    trackLiveRun(svc, run);

    expect(svc.getLeadActivityState(teamName)).toEqual({
      state: 'active',
      runId: run.runId,
    });

    svc.stopTeam(teamName);

    expect(svc.getLeadActivityState(teamName)).toEqual({
      state: 'offline',
      runId: null,
    });
  });

  it('treats a suffixed registered live agent as the expected teammate during launch audit', async () => {
    const teamName = 'agent-audit-suffixed-registered-safe-e2e';
    await writePureAnthropicTeamConfigWithMembers({
      teamName,
      projectPath,
      members: ['alice', 'bob-2'],
    });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.expectedMembers = ['alice', 'bob'];
    run.memberSpawnStatuses.set('bob', {
      status: 'spawning',
      launchState: 'starting',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      firstSpawnAcceptedAt: new Date().toISOString(),
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    (svc as any).getLiveTeamAgentRuntimeMetadata = async () =>
      new Map([
        [
          'bob-2',
          {
            alive: true,
            model: 'sonnet',
          },
        ],
      ]);

    await (svc as any).auditMemberSpawnStatuses(run);

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      livenessSource: 'process',
      hardFailure: false,
    });
  });

  it('does not finalize a suffixed registered agent as missing during launch finalization', async () => {
    const teamName = 'agent-finalize-suffixed-registered-safe-e2e';
    await writePureAnthropicTeamConfigWithMembers({
      teamName,
      projectPath,
      members: ['alice', 'bob-2'],
    });
    await writePureAnthropicTeamMeta(teamName, projectPath);
    await writePureAnthropicMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createPureAnthropicLiveRun({ teamName, projectPath });
    run.expectedMembers = ['alice', 'bob'];
    run.memberSpawnStatuses.set('bob', {
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    await (svc as any).finalizeMissingRegisteredMembersAsFailed(run);

    expect(run.memberSpawnStatuses.get('bob')).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      hardFailure: false,
    });
  });

  it('keeps OpenCode secondary lanes online when the primary Codex member failed to spawn', async () => {
    const teamName = 'mixed-primary-failure-opencode-ready-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);
    run.memberSpawnStatuses.set('alice', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Codex native runtime unavailable',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Codex native runtime unavailable',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('keeps OpenCode secondary lanes online when the primary Anthropic member failed to spawn', async () => {
    const teamName = 'mixed-anthropic-primary-failure-opencode-ready-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);
    run.memberSpawnStatuses.set('alice', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Anthropic pane exited before bootstrap',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      failedCount: 1,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Anthropic pane exited before bootstrap',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      alive: false,
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('keeps OpenCode secondary lanes online when Anthropic and Gemini primary members both failed', async () => {
    const teamName = 'mixed-anthropic-gemini-primary-failure-opencode-ready-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    run.expectedMembers = ['alice', 'reviewer'];
    run.effectiveMembers = [
      ...(run.effectiveMembers as Array<Record<string, unknown>>),
      {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      },
    ];
    run.allEffectiveMembers = [
      ...(run.allEffectiveMembers as Array<Record<string, unknown>>),
      {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      },
    ];
    trackLiveRun(svc, run);
    run.memberSpawnStatuses.set('alice', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Anthropic pane exited before bootstrap',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    run.memberSpawnStatuses.set('reviewer', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Gemini pane failed to start',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive'
    );
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      failedCount: 2,
    });
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Anthropic pane exited before bootstrap',
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Gemini pane failed to start',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('detaches one OpenCode secondary lane after Anthropic and Gemini primary members both failed', async () => {
    const teamName = 'mixed-anthropic-gemini-primary-failure-opencode-detach-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    run.expectedMembers = ['alice', 'reviewer'];
    run.effectiveMembers = [
      ...(run.effectiveMembers as Array<Record<string, unknown>>),
      {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      },
    ];
    run.allEffectiveMembers = [
      ...(run.allEffectiveMembers as Array<Record<string, unknown>>),
      {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      },
    ];
    trackLiveRun(svc, run);
    run.memberSpawnStatuses.set('alice', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Anthropic pane exited before bootstrap',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    run.memberSpawnStatuses.set('reviewer', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Gemini pane failed to start',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      laneId: 'secondary:opencode:bob',
      reason: 'cleanup',
    });
    expect(
      run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
    ).toEqual(['tom']);
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.expectedMembers).toEqual(['alice', 'reviewer', 'tom']);
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Anthropic pane exited before bootstrap',
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Gemini pane failed to start',
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );
  });

  it('restarts one OpenCode secondary lane after Anthropic and Gemini primary members both failed', async () => {
    const teamName = 'mixed-anthropic-gemini-primary-failure-opencode-restart-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    run.expectedMembers = ['alice', 'reviewer'];
    run.effectiveMembers = [
      ...(run.effectiveMembers as Array<Record<string, unknown>>),
      {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      },
    ];
    run.allEffectiveMembers = [
      ...(run.allEffectiveMembers as Array<Record<string, unknown>>),
      {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      },
    ];
    trackLiveRun(svc, run);
    run.memberSpawnStatuses.set('alice', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Anthropic pane exited before bootstrap',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });
    run.memberSpawnStatuses.set('reviewer', {
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: 'Gemini pane failed to start',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    adapter.setLaunchResult('partial_pending', { bob: 'permission' });

    await svc.restartMember(teamName, 'bob');

    await waitForCondition(() => adapter.launchInputs.length === 3);
    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      laneId: 'secondary:opencode:bob',
      reason: 'relaunch',
    });
    expect(adapter.launchInputs.at(-1)).toMatchObject({
      laneId: 'secondary:opencode:bob',
      expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
    });

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Anthropic pane exited before bootstrap',
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'Gemini pane failed to start',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['perm-bob'],
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('fails mixed OpenCode secondary lanes clearly when the runtime adapter is not registered', async () => {
    const teamName = 'mixed-missing-opencode-adapter-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const svc = new TeamProvisioningService();
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(snapshot).toMatchObject({
      teamName,
      teamLaunchState: 'partial_failure',
    });
    expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
      'finished',
      'finished',
    ]);
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'opencode_runtime_adapter_missing',
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'opencode_runtime_adapter_missing',
    });
  });

  it('keeps Anthropic primary online when OpenCode secondary adapter is not registered', async () => {
    const teamName = 'mixed-anthropic-missing-opencode-adapter-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const svc = new TeamProvisioningService();
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(snapshot).toMatchObject({
      teamName,
      teamLaunchState: 'partial_failure',
    });
    expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
      'finished',
      'finished',
    ]);
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'opencode_runtime_adapter_missing',
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'opencode_runtime_adapter_missing',
    });

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      alive: true,
      runtimeModel: 'haiku',
    });
  });

  it('restarts one mixed OpenCode secondary lane without touching other live teammates', async () => {
    const teamName = 'mixed-opencode-manual-restart-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    adapter.setLaunchResult('partial_pending', { bob: 'permission' });

    await svc.restartMember(teamName, 'bob');

    await waitForCondition(() => adapter.launchInputs.length === 3);
    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      laneId: 'secondary:opencode:bob',
      reason: 'relaunch',
    });
    expect(adapter.launchInputs.at(-1)).toMatchObject({
      laneId: 'secondary:opencode:bob',
      expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
    });

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['perm-bob'],
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('restarts one Anthropic mixed OpenCode secondary lane without touching other live teammates', async () => {
    const teamName = 'mixed-anthropic-opencode-manual-restart-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    adapter.setLaunchResult('partial_pending', { bob: 'permission' });

    await svc.restartMember(teamName, 'bob');

    await waitForCondition(() => adapter.launchInputs.length === 3);
    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      laneId: 'secondary:opencode:bob',
      reason: 'relaunch',
    });
    expect(adapter.launchInputs.at(-1)).toMatchObject({
      laneId: 'secondary:opencode:bob',
      expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
    });

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['perm-bob'],
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });

    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.alice).toMatchObject({
      providerId: 'anthropic',
      laneKind: 'primary',
      runtimeModel: 'haiku',
    });
    expect(runtimeSnapshot.members.bob).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:bob',
      laneKind: 'secondary',
      runtimeModel: 'opencode/minimax-m2.5-free',
    });
    expect(runtimeSnapshot.members.tom).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:tom',
      laneKind: 'secondary',
      runtimeModel: 'opencode/nemotron-3-super-free',
    });
  });

  it('restarts only the targeted mixed OpenCode secondary lane when two teams share member names', async () => {
    const firstTeamName = 'mixed-opencode-restart-cross-team-a-safe-e2e';
    const secondTeamName = 'mixed-opencode-restart-cross-team-b-safe-e2e';
    await writeMixedTeamConfig({ teamName: firstTeamName, projectPath });
    await writeMixedTeamConfig({ teamName: secondTeamName, projectPath });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const firstRun = createMixedLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createMixedLiveRun({ teamName: secondTeamName, projectPath });
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(firstRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(secondRun);
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      firstRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(() =>
      secondRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    adapter.setLaunchResult('partial_pending', { bob: 'permission' });

    await svc.restartMember(secondTeamName, 'bob');

    await waitForCondition(() => adapter.launchInputs.length === 5);
    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      teamName: secondTeamName,
      laneId: 'secondary:opencode:bob',
      reason: 'relaunch',
    });
    expect(adapter.launchInputs.at(-1)).toMatchObject({
      teamName: secondTeamName,
      laneId: 'secondary:opencode:bob',
      expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
    });

    const firstStatuses = await svc.getMemberSpawnStatuses(firstTeamName);
    const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
    expect(firstStatuses.teamLaunchState).toBe('clean_success');
    expect(firstStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(secondStatuses.teamLaunchState).toBe('partial_pending');
    expect(secondStatuses.statuses.bob).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['perm-bob'],
      hardFailure: false,
    });
    expect(secondStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('detaches one mixed OpenCode secondary lane and keeps remaining teammates launchable', async () => {
    const teamName = 'mixed-opencode-detach-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      laneId: 'secondary:opencode:bob',
      reason: 'cleanup',
    });
    expect(
      run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
    ).toEqual(['tom']);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.expectedMembers).toEqual(['alice', 'tom']);
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );
  });

  it('detaches only the targeted mixed OpenCode secondary lane when two teams share member names', async () => {
    const firstTeamName = 'mixed-opencode-detach-cross-team-a-safe-e2e';
    const secondTeamName = 'mixed-opencode-detach-cross-team-b-safe-e2e';
    await writeMixedTeamConfig({ teamName: firstTeamName, projectPath });
    await writeMixedTeamConfig({ teamName: secondTeamName, projectPath });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const firstRun = createMixedLiveRun({ teamName: firstTeamName, projectPath });
    const secondRun = createMixedLiveRun({ teamName: secondTeamName, projectPath });
    trackLiveRun(svc, firstRun);
    trackLiveRun(svc, secondRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(firstRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(secondRun);
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      firstRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    await waitForCondition(() =>
      secondRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.detachOpenCodeOwnedMemberLane(secondTeamName, 'bob');

    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      teamName: secondTeamName,
      laneId: 'secondary:opencode:bob',
      reason: 'cleanup',
    });
    expect(
      firstRun.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
    ).toEqual(['bob', 'tom']);
    expect(
      secondRun.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
    ).toEqual(['tom']);

    const firstStatuses = await svc.getMemberSpawnStatuses(firstTeamName);
    const secondStatuses = await svc.getMemberSpawnStatuses(secondTeamName);
    expect(firstStatuses.expectedMembers).toEqual(['alice', 'bob', 'tom']);
    expect(firstStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(secondStatuses.expectedMembers).toEqual(['alice', 'tom']);
    expect(secondStatuses.statuses.bob).toBeUndefined();
    expect(secondStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('detaches one Anthropic mixed OpenCode secondary lane and keeps remaining teammates launchable', async () => {
    const teamName = 'mixed-anthropic-opencode-detach-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.detachOpenCodeOwnedMemberLane(teamName, 'bob');

    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      laneId: 'secondary:opencode:bob',
      reason: 'cleanup',
    });
    expect(
      run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
    ).toEqual(['tom']);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.expectedMembers).toEqual(['alice', 'tom']);
    expect(statuses.statuses.bob).toBeUndefined();
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );
  });

  it('reattaches a newly added mixed OpenCode teammate without relaunching existing lanes', async () => {
    const teamName = 'mixed-opencode-add-member-reattach-safe-e2e';
    const eve = {
      name: 'eve',
      providerId: 'opencode' as const,
      model: 'opencode/big-pickle',
    };
    await writeMixedTeamConfig({ teamName, projectPath, extraMembers: [eve] });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName, { extraMembers: [eve] });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
      eve: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.reattachOpenCodeOwnedMemberLane(teamName, 'eve', { reason: 'member_added' });

    await waitForCondition(() => adapter.launchInputs.length === 3);
    expect(adapter.stopInputs).toHaveLength(0);
    expect(adapter.launchInputs.at(-1)).toMatchObject({
      laneId: 'secondary:opencode:eve',
      expectedMembers: [expect.objectContaining({ name: 'eve', providerId: 'opencode' })],
    });
    expect(
      run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name).sort()
    ).toEqual(['bob', 'eve', 'tom']);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.expectedMembers).toEqual(
      expect.arrayContaining(['alice', 'bob', 'tom', 'eve'])
    );
    expect(statuses.statuses.eve).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
    expect(runtimeSnapshot.members.eve).toMatchObject({
      providerId: 'opencode',
      laneId: 'secondary:opencode:eve',
      laneKind: 'secondary',
      runtimeModel: 'opencode/big-pickle',
    });
  });

  it('reattaches an existing mixed OpenCode teammate after member update without changing siblings', async () => {
    const teamName = 'mixed-opencode-update-member-reattach-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await svc.reattachOpenCodeOwnedMemberLane(teamName, 'bob', { reason: 'member_updated' });

    await waitForCondition(() => adapter.launchInputs.length === 3);
    expect(adapter.stopInputs).toHaveLength(1);
    expect(adapter.stopInputs[0]).toMatchObject({
      laneId: 'secondary:opencode:bob',
      reason: 'relaunch',
    });
    expect(adapter.launchInputs.at(-1)).toMatchObject({
      laneId: 'secondary:opencode:bob',
      expectedMembers: [expect.objectContaining({ name: 'bob', providerId: 'opencode' })],
    });
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('rejects controlled OpenCode reattach for a primary-runtime teammate without dispatching lanes', async () => {
    const teamName = 'mixed-opencode-reattach-primary-reject-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await expect(svc.reattachOpenCodeOwnedMemberLane(teamName, 'alice')).rejects.toThrow(
      'Controlled reattach is only supported for OpenCode-owned members'
    );

    expect(adapter.launchInputs).toHaveLength(0);
    expect(adapter.stopInputs).toHaveLength(0);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('rejects controlled OpenCode reattach for a removed teammate without launching a stale lane', async () => {
    const teamName = 'mixed-opencode-reattach-removed-reject-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName, { removedMembers: ['bob'] });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await expect(svc.reattachOpenCodeOwnedMemberLane(teamName, 'bob')).rejects.toThrow(
      'Member "bob" has been removed'
    );

    expect(adapter.launchInputs).toHaveLength(0);
    expect(adapter.stopInputs).toHaveLength(0);
    expect(
      run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)
    ).toEqual(['bob', 'tom']);
  });

  it('rejects mixed OpenCode secondary restart when the runtime adapter is missing', async () => {
    const teamName = 'mixed-opencode-restart-missing-adapter-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    const svc = new TeamProvisioningService();
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await expect(svc.restartMember(teamName, 'bob')).rejects.toThrow(
      'OpenCode runtime adapter is not available for controlled lane reattach.'
    );

    expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
      'queued',
      'queued',
    ]);
    expect(run.pendingMemberRestarts.has('bob')).toBe(false);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(run.memberSpawnStatuses.get('bob')).toBeUndefined();
  });

  it('detaches a stale mixed OpenCode teammate that no longer has a runtime lane', async () => {
    const teamName = 'mixed-opencode-detach-stale-member-safe-e2e';
    const eve = {
      name: 'eve',
      providerId: 'opencode' as const,
      model: 'opencode/big-pickle',
    };
    await writeMixedTeamConfig({ teamName, projectPath, extraMembers: [eve] });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName, { extraMembers: [eve] });
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    run.allEffectiveMembers.push({
      name: 'eve',
      role: 'Developer',
      providerId: 'opencode',
      model: 'opencode/big-pickle',
    });
    run.request.members = run.allEffectiveMembers;
    trackLiveRun(svc, run);

    await svc.detachOpenCodeOwnedMemberLane(teamName, 'eve');

    expect(adapter.stopInputs).toHaveLength(0);
    expect(run.allEffectiveMembers.map((member: { name: string }) => member.name)).not.toContain(
      'eve'
    );
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.expectedMembers).not.toContain('eve');
    expect(statuses.statuses.eve).toBeUndefined();
    expect(statuses.statuses.bob).toBeDefined();
    expect(statuses.statuses.tom).toBeDefined();
  });

  it('shows mixed OpenCode secondary lanes as spawning while runtime adapter launch is in flight', async () => {
    const teamName = 'mixed-live-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    const initialSnapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(initialSnapshot.teamLaunchState).toBe('partial_pending');
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    const inFlightStatuses = await svc.getMemberSpawnStatuses(teamName);
    expect(inFlightStatuses.teamLaunchState).toBe('partial_pending');
    expect(inFlightStatuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 2,
      failedCount: 0,
    });
    expect(inFlightStatuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(inFlightStatuses.statuses.bob).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      hardFailure: false,
    });
    expect(inFlightStatuses.statuses.tom).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      hardFailure: false,
    });

    adapter.releaseLaunches();

    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    const finalStatuses = await svc.getMemberSpawnStatuses(teamName);
    expect(finalStatuses.teamLaunchState).toBe('clean_success');
    expect(finalStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(finalStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
  });

  it('shows Anthropic mixed OpenCode secondary lanes as spawning while runtime adapter launch is in flight', async () => {
    const teamName = 'mixed-anthropic-live-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    const initialSnapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(initialSnapshot.teamLaunchState).toBe('partial_pending');
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    const inFlightStatuses = await svc.getMemberSpawnStatuses(teamName);
    expect(inFlightStatuses.teamLaunchState).toBe('partial_pending');
    expect(inFlightStatuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 2,
      failedCount: 0,
    });
    expect(inFlightStatuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(inFlightStatuses.statuses.bob).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      hardFailure: false,
    });
    expect(inFlightStatuses.statuses.tom).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      hardFailure: false,
    });

    adapter.releaseLaunches();

    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );
    const finalStatuses = await svc.getMemberSpawnStatuses(teamName);
    expect(finalStatuses.teamLaunchState).toBe('clean_success');
    expect(finalStatuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(finalStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(finalStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
  });

  it('does not double-dispatch mixed OpenCode secondary lanes when launch handoff is retried in flight', async () => {
    const teamName = 'mixed-retry-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
    const firstLaneRunIds = run.mixedSecondaryLanes.map(
      (lane: { runId: string | null }) => lane.runId
    );

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(adapter.pendingLaunchInputs).toHaveLength(2);
    expect(adapter.launchInputs).toHaveLength(0);
    expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
      'launching',
      'launching',
    ]);
    expect(run.mixedSecondaryLanes.map((lane: { runId: string | null }) => lane.runId)).toEqual(
      firstLaneRunIds
    );

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(adapter.launchInputs).toHaveLength(2);
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
  });

  it('does not double-dispatch Anthropic mixed OpenCode secondary lanes when launch handoff is retried in flight', async () => {
    const teamName = 'mixed-anthropic-retry-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);
    const firstLaneRunIds = run.mixedSecondaryLanes.map(
      (lane: { runId: string | null }) => lane.runId
    );

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(adapter.pendingLaunchInputs).toHaveLength(2);
    expect(adapter.launchInputs).toHaveLength(0);
    expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
      'launching',
      'launching',
    ]);
    expect(run.mixedSecondaryLanes.map((lane: { runId: string | null }) => lane.runId)).toEqual(
      firstLaneRunIds
    );

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);
    await waitForCondition(() =>
      run.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(adapter.launchInputs).toHaveLength(2);
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
  });

  it('does not dispatch mixed OpenCode secondary lanes after the primary launch run is cancelled', async () => {
    const teamName = 'mixed-cancel-before-handoff-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);
    run.cancelRequested = true;
    run.processKilled = true;

    const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(snapshot).toBeNull();
    expect(adapter.pendingLaunchInputs).toHaveLength(0);
    expect(adapter.launchInputs).toHaveLength(0);
    expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
      'queued',
      'queued',
    ]);
  });

  it('does not dispatch Anthropic mixed OpenCode secondary lanes after the primary launch run is cancelled', async () => {
    const teamName = 'mixed-anthropic-cancel-before-handoff-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);
    run.cancelRequested = true;
    run.processKilled = true;

    const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(snapshot).toBeNull();
    expect(adapter.pendingLaunchInputs).toHaveLength(0);
    expect(adapter.launchInputs).toHaveLength(0);
    expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
      'queued',
      'queued',
    ]);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('does not dispatch Anthropic and Gemini mixed OpenCode secondary lanes after the primary launch run is cancelled', async () => {
    const teamName = 'mixed-anthropic-gemini-cancel-before-handoff-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(run);
    trackLiveRun(svc, run);
    run.cancelRequested = true;
    run.processKilled = true;

    const snapshot = await (svc as any).launchMixedSecondaryLaneIfNeeded(run);

    expect(snapshot).toBeNull();
    expect(adapter.pendingLaunchInputs).toHaveLength(0);
    expect(adapter.launchInputs).toHaveLength(0);
    expect(run.mixedSecondaryLanes.map((lane: { state: string }) => lane.state)).toEqual([
      'queued',
      'queued',
    ]);
    expect(run.memberSpawnStatuses.get('alice')).toMatchObject({
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(run.memberSpawnStatuses.get('reviewer')).toMatchObject({
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('does not resurrect a stopped mixed launch when in-flight OpenCode lanes finish late', async () => {
    const teamName = 'mixed-stop-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);

    await waitForCondition(() => !svc.isTeamAlive(teamName));
    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(svc.isTeamAlive(teamName)).toBe(false);
    expect(statuses.teamLaunchState).not.toBe('clean_success');
    expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
  });

  it('does not resurrect a stopped Anthropic mixed launch when in-flight OpenCode lanes finish late', async () => {
    const teamName = 'mixed-anthropic-stop-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);

    await waitForCondition(() => !svc.isTeamAlive(teamName));
    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(svc.isTeamAlive(teamName)).toBe(false);
    expect(statuses.teamLaunchState).not.toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
  });

  it('does not resurrect a stopped Anthropic and Gemini mixed launch when in-flight OpenCode lanes finish late', async () => {
    const teamName = 'mixed-anthropic-gemini-stop-inflight-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    run.expectedMembers = ['alice', 'reviewer'];
    run.effectiveMembers = [
      ...(run.effectiveMembers as Array<Record<string, unknown>>),
      {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      },
    ];
    run.allEffectiveMembers = [
      ...(run.allEffectiveMembers as Array<Record<string, unknown>>),
      {
        name: 'reviewer',
        role: 'Reviewer',
        providerId: 'gemini',
        model: 'gemini-2.5-flash',
      },
    ];
    run.memberSpawnStatuses.set('reviewer', {
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: '2026-04-23T10:00:00.000Z',
      lastRuntimeAliveAt: '2026-04-23T10:00:00.000Z',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
      livenessSource: 'heartbeat',
    });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);

    await waitForCondition(() => !svc.isTeamAlive(teamName));
    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(svc.isTeamAlive(teamName)).toBe(false);
    expect(statuses.teamLaunchState).not.toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
  });

  it('stops one mixed in-flight launch without stopping another mixed team', async () => {
    const stoppedTeamName = 'mixed-stop-one-of-two-inflight-safe-e2e';
    const survivingTeamName = 'mixed-survives-other-stop-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName: stoppedTeamName, projectPath });
    await writeTeamMeta(stoppedTeamName, projectPath);
    await writeMembersMeta(stoppedTeamName);
    await writeMixedTeamConfig({ teamName: survivingTeamName, projectPath });
    await writeTeamMeta(survivingTeamName, projectPath);
    await writeMembersMeta(survivingTeamName);
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const stoppedRun = createMixedLiveRun({ teamName: stoppedTeamName, projectPath });
    const survivingRun = createMixedLiveRun({ teamName: survivingTeamName, projectPath });
    stoppedRun.child = { kill: () => undefined };
    survivingRun.child = { kill: () => undefined };
    trackLiveRun(svc, stoppedRun);
    trackLiveRun(svc, survivingRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(stoppedRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 4);

    svc.stopTeam(stoppedTeamName);

    await waitForCondition(
      () => adapter.stopInputs.filter((input) => input.teamName === stoppedTeamName).length === 2
    );
    expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);
    expect(svc.isTeamAlive(stoppedTeamName)).toBe(false);
    expect(svc.isTeamAlive(survivingTeamName)).toBe(true);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      survivingRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const stoppedStatuses = await svc.getMemberSpawnStatuses(stoppedTeamName);
    const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
    expect(stoppedStatuses.teamLaunchState).not.toBe('clean_success');
    expect(stoppedStatuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(stoppedStatuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
    expect(survivingStatuses.teamLaunchState).toBe('clean_success');
    expect(survivingStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(survivingStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('does not let a stopped run late result overwrite newer mixed launch truth', async () => {
    const teamName = 'mixed-late-old-result-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const oldRun = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, oldRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(oldRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);
    await waitForCondition(() => !svc.isTeamAlive(teamName));
    await waitForCondition(() => adapter.stopInputs.length === 2);

    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['new-perm-bob'],
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'new run explicit failure',
        }),
      },
    });

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.bob).toMatchObject({
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['new-perm-bob'],
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailureReason: 'new run explicit failure',
    });
  });

  it('does not let a stopped Anthropic run late result overwrite newer mixed launch truth', async () => {
    const teamName = 'mixed-anthropic-late-old-result-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const oldRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, oldRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(oldRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);
    await waitForCondition(() => !svc.isTeamAlive(teamName));
    await waitForCondition(() => adapter.stopInputs.length === 2);

    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['new-perm-bob'],
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'new Anthropic run explicit failure',
        }),
      },
    });

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['new-perm-bob'],
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailureReason: 'new Anthropic run explicit failure',
    });
  });

  it('does not let a stopped Anthropic and Gemini run late result overwrite newer mixed launch truth', async () => {
    const teamName = 'mixed-anthropic-gemini-late-old-result-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const oldRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const reviewer = {
      name: 'reviewer',
      role: 'Reviewer',
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
    };
    oldRun.expectedMembers = ['alice', 'reviewer'];
    oldRun.effectiveMembers = [...oldRun.effectiveMembers, reviewer];
    oldRun.allEffectiveMembers = [
      ...oldRun.effectiveMembers,
      ...oldRun.allEffectiveMembers.filter(
        (member: { providerId?: string }) => member.providerId === 'opencode'
      ),
    ];
    oldRun.memberSpawnStatuses.set('reviewer', {
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: '2026-04-23T10:00:00.000Z',
      lastRuntimeAliveAt: '2026-04-23T10:00:00.000Z',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
      livenessSource: 'heartbeat',
    });
    trackLiveRun(svc, oldRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(oldRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);
    await waitForCondition(() => !svc.isTeamAlive(teamName));
    await waitForCondition(() => adapter.stopInputs.length === 2);

    await writeMixedTeamLaunchState({
      teamName,
      members: {
        alice: mixedMemberState({
          providerId: 'anthropic',
          model: 'haiku',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        reviewer: mixedMemberState({
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
          laneId: 'primary:gemini:reviewer',
          laneKind: 'primary',
          laneOwnerProviderId: 'gemini',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
        }),
        bob: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'runtime_pending_permission',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['new-perm-bob'],
        }),
        tom: mixedMemberState({
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'new Anthropic and Gemini run explicit failure',
        }),
      },
    });

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['new-perm-bob'],
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailureReason: 'new Anthropic and Gemini run explicit failure',
    });
  });

  it('does not degrade stopped mixed launch lanes when in-flight OpenCode launch errors late', async () => {
    const teamName = 'mixed-stop-late-error-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new RejectingBlockingOpenCodeRuntimeAdapter('late fake bridge failure');
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);
    await waitForCondition(() => !svc.isTeamAlive(teamName));
    await waitForCondition(() => adapter.stopInputs.length === 2);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.rejectedLaunchCount === 2);

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
  });

  it('does not degrade stopped Anthropic mixed launch lanes when in-flight OpenCode launch errors late', async () => {
    const teamName = 'mixed-anthropic-stop-late-error-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
      'late fake Anthropic bridge failure'
    );
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);
    await waitForCondition(() => !svc.isTeamAlive(teamName));
    await waitForCondition(() => adapter.stopInputs.length === 2);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.rejectedLaunchCount === 2);

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
  });

  it('does not degrade stopped Anthropic and Gemini mixed launch lanes when in-flight OpenCode launch errors late', async () => {
    const teamName = 'mixed-anthropic-gemini-stop-late-error-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
      'late fake Anthropic and Gemini bridge failure'
    );
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const reviewer = {
      name: 'reviewer',
      role: 'Reviewer',
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
    };
    run.expectedMembers = ['alice', 'reviewer'];
    run.effectiveMembers = [...run.effectiveMembers, reviewer];
    run.allEffectiveMembers = [
      ...run.effectiveMembers,
      ...run.allEffectiveMembers.filter(
        (member: { providerId?: string }) => member.providerId === 'opencode'
      ),
    ];
    run.memberSpawnStatuses.set('reviewer', {
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      lastHeartbeatAt: '2026-04-23T10:00:00.000Z',
      lastRuntimeAliveAt: '2026-04-23T10:00:00.000Z',
      lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
      livenessSource: 'heartbeat',
    });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    svc.stopTeam(teamName);
    await waitForCondition(() => !svc.isTeamAlive(teamName));
    await waitForCondition(() => adapter.stopInputs.length === 2);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.rejectedLaunchCount === 2);

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
  });

  it('stops mixed OpenCode secondary lanes when provisioning is cancelled mid-launch', async () => {
    const teamName = 'mixed-cancel-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    await svc.cancelProvisioning(run.runId);

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('clean_success');
    expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
  });

  it('stops Anthropic mixed OpenCode secondary lanes when provisioning is cancelled mid-launch', async () => {
    const teamName = 'mixed-anthropic-cancel-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    await svc.cancelProvisioning(run.runId);

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
  });

  it('stops Anthropic and Gemini mixed OpenCode secondary lanes when provisioning is cancelled mid-launch', async () => {
    const teamName = 'mixed-anthropic-gemini-cancel-inflight-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(run);
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    await svc.cancelProvisioning(run.runId);

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('clean_success');
    expect(statuses.statuses.alice).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(statuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
  });

  it('allows fresh Anthropic and Gemini mixed OpenCode lanes after cancel cancelled in-flight handoff', async () => {
    const teamName = 'mixed-anthropic-gemini-fresh-after-cancelled-handoff-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const cancelledRun = createMixedLiveRun({
      teamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    addGeminiPrimaryToMixedRun(cancelledRun);
    trackLiveRun(svc, cancelledRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    await svc.cancelProvisioning(cancelledRun.runId);

    await waitForCondition(() => adapter.stopInputs.length === 2);
    expect(adapter.stopInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(svc.isTeamAlive(teamName)).toBe(false);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 2);

    const cancelledStatuses = await svc.getMemberSpawnStatuses(teamName);
    expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
    expect(cancelledStatuses.statuses.alice).toMatchObject({ hardFailure: false });
    expect(cancelledStatuses.statuses.reviewer).toMatchObject({ hardFailure: false });
    expect(cancelledStatuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(cancelledStatuses.statuses.tom?.launchState).not.toBe('confirmed_alive');

    const freshRun = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    freshRun.runId = `${cancelledRun.runId}-fresh`;
    freshRun.detectedSessionId = 'lead-session-fresh';
    addGeminiPrimaryToMixedRun(freshRun);
    trackLiveRun(svc, freshRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const freshStatuses = await svc.getMemberSpawnStatuses(teamName);
    expect(freshStatuses.teamLaunchState).toBe('clean_success');
    expect(freshStatuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(freshStatuses.statuses.reviewer).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(freshStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(freshStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('cancels one mixed in-flight launch without cancelling another mixed team', async () => {
    const cancelledTeamName = 'mixed-cancel-one-of-two-inflight-safe-e2e';
    const survivingTeamName = 'mixed-survives-other-cancel-inflight-safe-e2e';
    await writeMixedTeamConfig({ teamName: cancelledTeamName, projectPath });
    await writeTeamMeta(cancelledTeamName, projectPath);
    await writeMembersMeta(cancelledTeamName);
    await writeMixedTeamConfig({ teamName: survivingTeamName, projectPath });
    await writeTeamMeta(survivingTeamName, projectPath);
    await writeMembersMeta(survivingTeamName);
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const cancelledRun = createMixedLiveRun({ teamName: cancelledTeamName, projectPath });
    const survivingRun = createMixedLiveRun({ teamName: survivingTeamName, projectPath });
    cancelledRun.child = { kill: () => undefined };
    survivingRun.child = { kill: () => undefined };
    trackLiveRun(svc, cancelledRun);
    trackLiveRun(svc, survivingRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 4);

    await svc.cancelProvisioning(cancelledRun.runId);

    await waitForCondition(
      () => adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 2
    );
    expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);
    expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
    expect(svc.isTeamAlive(survivingTeamName)).toBe(true);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      survivingRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const cancelledStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
    const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
    expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
    expect(cancelledStatuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(cancelledStatuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
    expect(survivingStatuses.teamLaunchState).toBe('clean_success');
    expect(survivingStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(survivingStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('cancels one Anthropic and Gemini mixed in-flight launch without cancelling another mixed team', async () => {
    const cancelledTeamName = 'mixed-anthropic-gemini-cancel-one-inflight-safe-e2e';
    const survivingTeamName = 'mixed-anthropic-gemini-survives-cancel-safe-e2e';
    await writeMixedTeamConfig({
      teamName: cancelledTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(cancelledTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(cancelledTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeMixedTeamConfig({
      teamName: survivingTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(survivingTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(survivingTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const cancelledRun = createMixedLiveRun({
      teamName: cancelledTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    const survivingRun = createMixedLiveRun({
      teamName: survivingTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    addGeminiPrimaryToMixedRun(cancelledRun);
    addGeminiPrimaryToMixedRun(survivingRun);
    cancelledRun.child = { kill: () => undefined };
    survivingRun.child = { kill: () => undefined };
    trackLiveRun(svc, cancelledRun);
    trackLiveRun(svc, survivingRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 4);

    await svc.cancelProvisioning(cancelledRun.runId);

    await waitForCondition(
      () => adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 2
    );
    expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);
    expect(svc.isTeamAlive(cancelledTeamName)).toBe(false);
    expect(svc.isTeamAlive(survivingTeamName)).toBe(true);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      survivingRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const cancelledStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
    const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
    expect(cancelledStatuses.teamLaunchState).not.toBe('clean_success');
    expect(cancelledStatuses.statuses.bob?.launchState).not.toBe('confirmed_alive');
    expect(cancelledStatuses.statuses.tom?.launchState).not.toBe('confirmed_alive');
    expect(survivingStatuses.teamLaunchState).toBe('clean_success');
    expect(survivingStatuses.statuses.reviewer).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(survivingStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(survivingStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('allows a cancelled mixed team to relaunch OpenCode secondary lanes without disturbing its surviving sibling', async () => {
    const cancelledTeamName = 'mixed-cancel-one-then-relaunch-safe-e2e';
    const survivingTeamName = 'mixed-survives-cancel-while-sibling-relaunches-safe-e2e';
    await writeMixedTeamConfig({ teamName: cancelledTeamName, projectPath });
    await writeTeamMeta(cancelledTeamName, projectPath);
    await writeMembersMeta(cancelledTeamName);
    await writeMixedTeamConfig({ teamName: survivingTeamName, projectPath });
    await writeTeamMeta(survivingTeamName, projectPath);
    await writeMembersMeta(survivingTeamName);
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const cancelledRun = createMixedLiveRun({ teamName: cancelledTeamName, projectPath });
    const survivingRun = createMixedLiveRun({ teamName: survivingTeamName, projectPath });
    cancelledRun.child = { kill: () => undefined };
    survivingRun.child = { kill: () => undefined };
    trackLiveRun(svc, cancelledRun);
    trackLiveRun(svc, survivingRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 4);

    await svc.cancelProvisioning(cancelledRun.runId);

    await waitForCondition(
      () => adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 2
    );
    expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      survivingRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const freshRun = createMixedLiveRun({ teamName: cancelledTeamName, projectPath });
    freshRun.runId = `${cancelledRun.runId}-fresh`;
    freshRun.detectedSessionId = 'lead-session-fresh';
    freshRun.child = { kill: () => undefined };
    trackLiveRun(svc, freshRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
    await waitForCondition(() => adapter.launchInputs.length === 6);
    await waitForCondition(() =>
      freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const relaunchedStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
    const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
    expect(relaunchedStatuses.teamLaunchState).toBe('clean_success');
    expect(relaunchedStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(relaunchedStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(survivingStatuses.teamLaunchState).toBe('clean_success');
    expect(survivingStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(survivingStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('allows a cancelled Anthropic and Gemini mixed team to relaunch while its sibling stays online', async () => {
    const cancelledTeamName = 'mixed-anthropic-gemini-cancel-one-then-relaunch-safe-e2e';
    const survivingTeamName = 'mixed-anthropic-gemini-survives-sibling-relaunch-safe-e2e';
    await writeMixedTeamConfig({
      teamName: cancelledTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(cancelledTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(cancelledTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeMixedTeamConfig({
      teamName: survivingTeamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(survivingTeamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(survivingTeamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new BlockingOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const cancelledRun = createMixedLiveRun({
      teamName: cancelledTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    const survivingRun = createMixedLiveRun({
      teamName: survivingTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    addGeminiPrimaryToMixedRun(cancelledRun);
    addGeminiPrimaryToMixedRun(survivingRun);
    cancelledRun.child = { kill: () => undefined };
    survivingRun.child = { kill: () => undefined };
    trackLiveRun(svc, cancelledRun);
    trackLiveRun(svc, survivingRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(cancelledRun);
    await (svc as any).launchMixedSecondaryLaneIfNeeded(survivingRun);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 4);

    await svc.cancelProvisioning(cancelledRun.runId);

    await waitForCondition(
      () => adapter.stopInputs.filter((input) => input.teamName === cancelledTeamName).length === 2
    );
    expect(adapter.stopInputs.some((input) => input.teamName === survivingTeamName)).toBe(false);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.launchInputs.length === 4);
    await waitForCondition(() =>
      survivingRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const freshRun = createMixedLiveRun({
      teamName: cancelledTeamName,
      projectPath,
      primaryProviderId: 'anthropic',
    });
    freshRun.runId = `${cancelledRun.runId}-fresh`;
    freshRun.detectedSessionId = 'lead-session-fresh';
    freshRun.child = { kill: () => undefined };
    addGeminiPrimaryToMixedRun(freshRun);
    trackLiveRun(svc, freshRun);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(freshRun);
    await waitForCondition(() => adapter.launchInputs.length === 6);
    await waitForCondition(() =>
      freshRun.mixedSecondaryLanes.every((lane: { state: string }) => lane.state === 'finished')
    );

    const relaunchedStatuses = await svc.getMemberSpawnStatuses(cancelledTeamName);
    const survivingStatuses = await svc.getMemberSpawnStatuses(survivingTeamName);
    expect(relaunchedStatuses.teamLaunchState).toBe('clean_success');
    expect(relaunchedStatuses.statuses.reviewer).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(relaunchedStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(relaunchedStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(survivingStatuses.teamLaunchState).toBe('clean_success');
    expect(survivingStatuses.statuses.reviewer).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(survivingStatuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(survivingStatuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
  });

  it('does not degrade mixed OpenCode lanes when in-flight launch errors after cancel', async () => {
    const teamName = 'mixed-cancel-late-error-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    const adapter = new RejectingBlockingOpenCodeRuntimeAdapter('late fake cancel bridge failure');
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    await svc.cancelProvisioning(run.runId);
    await waitForCondition(() => adapter.stopInputs.length === 2);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.rejectedLaunchCount === 2);

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('partial_failure');
    expect(statuses.statuses.bob).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
  });

  it('does not degrade Anthropic mixed OpenCode lanes when in-flight launch errors after cancel', async () => {
    const teamName = 'mixed-anthropic-cancel-late-error-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath, primaryProviderId: 'anthropic' });
    const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
      'late fake Anthropic cancel bridge failure'
    );
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    await svc.cancelProvisioning(run.runId);
    await waitForCondition(() => adapter.stopInputs.length === 2);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.rejectedLaunchCount === 2);

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
  });

  it('does not degrade Anthropic and Gemini mixed OpenCode lanes when in-flight launch errors after cancel', async () => {
    const teamName = 'mixed-anthropic-gemini-cancel-late-error-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    const adapter = new RejectingBlockingOpenCodeRuntimeAdapter(
      'late fake Anthropic and Gemini cancel bridge failure'
    );
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const run = createMixedLiveRun({ teamName, projectPath, primaryProviderId: 'anthropic' });
    addGeminiPrimaryToMixedRun(run);
    trackLiveRun(svc, run);

    await (svc as any).launchMixedSecondaryLaneIfNeeded(run);
    await waitForCondition(() => adapter.pendingLaunchInputs.length === 2);

    await svc.cancelProvisioning(run.runId);
    await waitForCondition(() => adapter.stopInputs.length === 2);

    adapter.releaseLaunches();
    await waitForCondition(() => adapter.rejectedLaunchCount === 2);

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {},
      }
    );
    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).not.toBe('partial_failure');
    expect(statuses.statuses.alice).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.reviewer).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom).toMatchObject({
      hardFailure: false,
    });
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
  });

  it('degrades stale active mixed OpenCode lanes when lane state is missing on disk', async () => {
    const teamName = 'mixed-stale-lanes-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });

    const svc = new TeamProvisioningService();
    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(statuses.teamLaunchState).toBe('partial_failure');
    expect(statuses.expectedMembers).toEqual(expect.arrayContaining(['alice', 'bob', 'tom']));
    expect(statuses.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      error: expect.stringContaining('no lane state exists on disk'),
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      error: expect.stringContaining('no lane state exists on disk'),
    });
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:bob': { state: 'degraded' },
          'secondary:opencode:tom': { state: 'degraded' },
        },
      }
    );
  });

  it('recovers stale active mixed OpenCode lanes from runtime reconcile before degrading them', async () => {
    const teamName = 'mixed-runtime-recover-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'confirmed',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
    });
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );
  });

  it('recovers stale active mixed OpenCode lanes into ready and permission-pending states before degrading them', async () => {
    const teamName = 'mixed-runtime-recover-split-permission-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'permission',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      hardFailure: false,
      pendingPermissionRequestIds: ['perm-tom'],
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );
  });

  it('recovers stale active mixed OpenCode lanes into ready and bootstrap-pending states before degrading them', async () => {
    const teamName = 'mixed-runtime-recover-split-bootstrap-safe-e2e';
    await writeMixedTeamConfig({ teamName, projectPath });
    await writeTeamMeta(teamName, projectPath);
    await writeMembersMeta(teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'launching',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 2,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );
  });

  it('recovers stale active Anthropic and Gemini configured OpenCode lanes into ready and permission-pending states before degrading them', async () => {
    const teamName = 'mixed-anthropic-gemini-configured-runtime-recover-split-permission-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'permission',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 3,
      failedCount: 0,
    });
    expect(statuses.expectedMembers).toEqual(
      expect.arrayContaining(['alice', 'reviewer', 'bob', 'tom'])
    );
    expect(statuses.statuses.alice?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.reviewer?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_permission',
      hardFailure: false,
      pendingPermissionRequestIds: ['perm-tom'],
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );
  });

  it('recovers stale active Anthropic and Gemini configured OpenCode lanes into ready and bootstrap-pending states before degrading them', async () => {
    const teamName = 'mixed-anthropic-gemini-configured-runtime-recover-split-bootstrap-safe-e2e';
    await writeMixedTeamConfig({
      teamName,
      projectPath,
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await writeTeamMeta(teamName, projectPath, { primaryProviderId: 'anthropic' });
    await writeMembersMeta(teamName, {
      includeGeminiPrimary: true,
      primaryProviderId: 'anthropic',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:bob',
      state: 'active',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'secondary:opencode:tom',
      state: 'active',
    });
    const adapter = new FakeOpenCodeRuntimeAdapter('clean_success', {
      bob: 'confirmed',
      tom: 'launching',
    });
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const statuses = await svc.getMemberSpawnStatuses(teamName);

    expect(adapter.reconcileInputs.map((input) => input.laneId).sort()).toEqual([
      'secondary:opencode:bob',
      'secondary:opencode:tom',
    ]);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 3,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });
    expect(statuses.expectedMembers).toEqual(
      expect.arrayContaining(['alice', 'reviewer', 'bob', 'tom'])
    );
    expect(statuses.statuses.alice?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.reviewer?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
      {
        lanes: {
          'secondary:opencode:bob': { state: 'active' },
          'secondary:opencode:tom': { state: 'active' },
        },
      }
    );
  });

  it('recovers pure OpenCode launch statuses from disk after service restart', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter();
    const firstService = new TeamProvisioningService();
    firstService.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await firstService.createTeam(
      {
        teamName: 'restart-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [
          { name: 'alice', role: 'Developer', providerId: 'opencode' },
          { name: 'bob', role: 'Reviewer', providerId: 'opencode' },
        ],
      },
      () => undefined
    );

    const restartedService = new TeamProvisioningService();
    const statuses = await restartedService.getMemberSpawnStatuses('restart-opencode-safe-e2e');

    expect(statuses).toMatchObject({
      source: 'persisted',
      teamLaunchState: 'clean_success',
    });
    expect(statuses.expectedMembers).toEqual(['alice', 'bob']);
    expect(statuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
    });
  });

  it('relaunches an OpenCode team after a failed runtime adapter launch and replaces stale failures', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter('partial_failure');
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await svc.createTeam(
      {
        teamName: 'failed-then-relaunch-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    const failedStatuses = await svc.getMemberSpawnStatuses(
      'failed-then-relaunch-opencode-safe-e2e'
    );
    expect(failedStatuses.teamLaunchState).toBe('partial_failure');
    expect(failedStatuses.statuses.alice).toMatchObject({
      status: 'error',
      hardFailure: true,
    });

    adapter.setLaunchResult('clean_success');

    await svc.launchTeam(
      {
        teamName: 'failed-then-relaunch-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );

    const relaunchedStatuses = await svc.getMemberSpawnStatuses(
      'failed-then-relaunch-opencode-safe-e2e'
    );
    expect(relaunchedStatuses.teamLaunchState).toBe('clean_success');
    expect(relaunchedStatuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(relaunchedStatuses.statuses.alice?.hardFailureReason).toBeUndefined();
  });

  it('relaunches an OpenCode team after permission-pending stop and clears pending permissions', async () => {
    const adapter = new FakeOpenCodeRuntimeAdapter('partial_pending');
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    await svc.createTeam(
      {
        teamName: 'pending-then-relaunch-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: false,
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      () => undefined
    );

    const pendingStatuses = await svc.getMemberSpawnStatuses(
      'pending-then-relaunch-opencode-safe-e2e'
    );
    expect(pendingStatuses.statuses.alice).toMatchObject({
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['perm-alice'],
    });

    svc.stopTeam('pending-then-relaunch-opencode-safe-e2e');
    await waitForCondition(() => adapter.stopInputs.length === 1);
    adapter.setLaunchResult('clean_success');

    await svc.launchTeam(
      {
        teamName: 'pending-then-relaunch-opencode-safe-e2e',
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        skipPermissions: true,
      },
      () => undefined
    );

    const relaunchedStatuses = await svc.getMemberSpawnStatuses(
      'pending-then-relaunch-opencode-safe-e2e'
    );
    expect(relaunchedStatuses.teamLaunchState).toBe('clean_success');
    expect(relaunchedStatuses.statuses.alice).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
    });
    expect(relaunchedStatuses.statuses.alice?.pendingPermissionRequestIds).toBeUndefined();
  });
}, LAUNCH_MATRIX_SAFE_E2E_TIMEOUT_MS);

type FakeMemberOutcome = 'confirmed' | 'permission' | 'launching' | 'failed';
type MixedPrimaryProviderId = 'anthropic' | 'codex';

class FakeOpenCodeRuntimeAdapter implements TeamLaunchRuntimeAdapter {
  readonly providerId = 'opencode' as const;
  readonly launchInputs: TeamRuntimeLaunchInput[] = [];
  readonly messageInputs: OpenCodeTeamRuntimeMessageInput[] = [];
  readonly reconcileInputs: TeamRuntimeReconcileInput[] = [];
  readonly stopInputs: TeamRuntimeStopInput[] = [];

  constructor(
    private launchState: TeamRuntimeLaunchResult['teamLaunchState'] = 'clean_success',
    private memberOutcomes: Record<string, FakeMemberOutcome> = {}
  ) {}

  setLaunchResult(
    launchState: TeamRuntimeLaunchResult['teamLaunchState'],
    memberOutcomes: Record<string, FakeMemberOutcome> = {}
  ): void {
    this.launchState = launchState;
    this.memberOutcomes = memberOutcomes;
  }

  async prepare(input: TeamRuntimeLaunchInput): Promise<TeamRuntimePrepareResult> {
    return {
      ok: true,
      providerId: 'opencode',
      modelId: input.model ?? null,
      diagnostics: [],
      warnings: [],
    };
  }

  async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    this.launchInputs.push(input);
    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'finished',
      teamLaunchState: this.aggregateLaunchState(input.expectedMembers),
      members: Object.fromEntries(
        input.expectedMembers.map((member, index) => [
          member.name,
          this.buildMemberEvidence(member, index),
        ])
      ),
      warnings: [],
      diagnostics:
        this.launchState === 'partial_failure'
          ? ['fake OpenCode launch failed']
          : this.launchState === 'partial_pending'
            ? ['fake OpenCode launch awaiting permission']
            : ['fake OpenCode launch ready'],
    };
  }

  async sendMessageToMember(
    input: OpenCodeTeamRuntimeMessageInput
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    this.messageInputs.push(input);
    return {
      ok: true,
      providerId: 'opencode',
      memberName: input.memberName,
      sessionId: `session-${input.memberName}`,
      runtimePid: 12_000 + this.messageInputs.length,
      diagnostics: [],
    };
  }

  async reconcile(input: TeamRuntimeReconcileInput): Promise<TeamRuntimeReconcileResult> {
    this.reconcileInputs.push(input);
    const members = Object.fromEntries(
      input.expectedMembers.map((member, index) => [
        member.name,
        this.buildMemberEvidence(member, index),
      ])
    );
    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'reconciled',
      teamLaunchState: this.aggregateLaunchState(input.expectedMembers),
      members,
      snapshot: null,
      warnings: [],
      diagnostics: ['fake reconcile'],
    };
  }

  async stop(input: TeamRuntimeStopInput): Promise<TeamRuntimeStopResult> {
    this.stopInputs.push(input);
    return {
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: ['fake stop'],
    };
  }

  private defaultOutcome(): FakeMemberOutcome {
    if (this.launchState === 'partial_failure') {
      return 'failed';
    }
    if (this.launchState === 'partial_pending') {
      return 'permission';
    }
    return 'confirmed';
  }

  private buildMemberEvidence(
    member: Pick<TeamRuntimeMemberSpec, 'name'>,
    index: number
  ): TeamRuntimeMemberLaunchEvidence {
    const outcome = this.memberOutcomes[member.name] ?? this.defaultOutcome();
    const failed = outcome === 'failed';
    const permissionPending = outcome === 'permission';
    const bootstrapPending = outcome === 'launching';
    const livenessKind = failed
      ? 'not_found'
      : permissionPending
        ? 'permission_blocked'
        : bootstrapPending
          ? 'runtime_process_candidate'
          : 'confirmed_bootstrap';
    const runtimeDiagnostic = permissionPending
      ? 'OpenCode runtime is waiting for permission approval'
      : bootstrapPending
        ? 'OpenCode runtime pid reported by bridge without local process verification'
        : undefined;
    return {
      memberName: member.name,
      providerId: 'opencode',
      launchState: failed
        ? 'failed_to_start'
        : permissionPending
          ? 'runtime_pending_permission'
          : bootstrapPending
            ? 'runtime_pending_bootstrap'
            : 'confirmed_alive',
      agentToolAccepted: !failed,
      runtimeAlive: !failed && !permissionPending && !bootstrapPending,
      bootstrapConfirmed: !failed && !permissionPending && !bootstrapPending,
      hardFailure: failed,
      hardFailureReason: failed ? 'fake_open_code_launch_failure' : undefined,
      pendingPermissionRequestIds: permissionPending ? [`perm-${member.name}`] : undefined,
      runtimePid: failed ? undefined : 10_000 + index,
      livenessKind,
      pidSource: failed ? undefined : 'opencode_bridge',
      runtimeDiagnostic,
      diagnostics: failed
        ? ['fake OpenCode launch failure']
        : permissionPending
          ? ['fake OpenCode launch awaiting permission']
          : bootstrapPending
            ? ['fake OpenCode launch awaiting bootstrap']
            : ['fake OpenCode launch ready'],
    };
  }

  private aggregateLaunchState(
    members: readonly Pick<TeamRuntimeMemberSpec, 'name'>[]
  ): TeamRuntimeLaunchResult['teamLaunchState'] {
    const outcomes = members.map(
      (member) => this.memberOutcomes[member.name] ?? this.defaultOutcome()
    );
    if (outcomes.some((outcome) => outcome === 'failed')) {
      return 'partial_failure';
    }
    if (outcomes.some((outcome) => outcome === 'permission' || outcome === 'launching')) {
      return 'partial_pending';
    }
    return 'clean_success';
  }
}

class BlockingOpenCodeRuntimeAdapter extends FakeOpenCodeRuntimeAdapter {
  readonly pendingLaunchInputs: TeamRuntimeLaunchInput[] = [];
  private releaseGate: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  override async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    this.pendingLaunchInputs.push(input);
    await this.gate;
    return super.launch(input);
  }

  releaseLaunches(): void {
    this.releaseGate?.();
  }
}

class BlockingStopOpenCodeRuntimeAdapter extends BlockingOpenCodeRuntimeAdapter {
  private releaseStopGate: (() => void) | null = null;
  private readonly stopGate = new Promise<void>((resolve) => {
    this.releaseStopGate = resolve;
  });

  override async stop(input: TeamRuntimeStopInput): Promise<TeamRuntimeStopResult> {
    this.stopInputs.push(input);
    await this.stopGate;
    return {
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: ['fake delayed stop'],
    };
  }

  releaseStops(): void {
    this.releaseStopGate?.();
  }
}

class RejectingBlockingOpenCodeRuntimeAdapter extends FakeOpenCodeRuntimeAdapter {
  readonly pendingLaunchInputs: TeamRuntimeLaunchInput[] = [];
  rejectedLaunchCount = 0;
  private releaseGate: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  constructor(private readonly errorMessage: string) {
    super();
  }

  override async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    this.pendingLaunchInputs.push(input);
    await this.gate;
    this.rejectedLaunchCount += 1;
    throw new Error(this.errorMessage);
  }

  releaseLaunches(): void {
    this.releaseGate?.();
  }
}

async function waitForCondition(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(assertion()).toBe(true);
}

async function removeTempDirWithRetries(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

function createMixedLiveRun(input: {
  teamName: string;
  projectPath: string;
  primaryProviderId?: MixedPrimaryProviderId;
}): any {
  const now = '2026-04-23T10:00:00.000Z';
  const primary = getMixedPrimaryFixture(input.primaryProviderId);
  return {
    runId: `run-${input.teamName}`,
    teamName: input.teamName,
    startedAt: now,
    detectedSessionId: 'lead-session',
    isLaunch: true,
    provisioningComplete: false,
    processKilled: false,
    cancelRequested: false,
    leadActivityState: 'active',
    request: {
      teamName: input.teamName,
      cwd: input.projectPath,
      providerId: primary.providerId,
      providerBackendId: primary.providerBackendId,
      model: primary.leadModel,
      skipPermissions: false,
      members: [],
    },
    progress: {
      state: 'finalizing',
      message: 'Finishing launch - waiting for secondary runtime lanes',
      updatedAt: now,
      assistantOutput: null,
    },
    onProgress: () => undefined,
    launchIdentity: {
      providerId: primary.providerId,
      providerBackendId: primary.providerBackendId ?? null,
      selectedModel: primary.leadModel,
      selectedModelKind: 'explicit',
      resolvedLaunchModel: primary.leadModel,
      catalogId: primary.leadModel,
      catalogSource: 'bundled',
      catalogFetchedAt: now,
      selectedEffort: 'medium',
      resolvedEffort: 'medium',
      selectedFastMode: null,
      resolvedFastMode: null,
      fastResolutionReason: null,
    },
    expectedMembers: ['alice'],
    effectiveMembers: [
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: primary.providerId,
        providerBackendId: primary.providerBackendId,
        model: primary.memberModel,
      },
    ],
    allEffectiveMembers: [
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: primary.providerId,
        providerBackendId: primary.providerBackendId,
        model: primary.memberModel,
      },
      {
        name: 'bob',
        role: 'Developer',
        providerId: 'opencode',
        model: 'opencode/minimax-m2.5-free',
      },
      {
        name: 'tom',
        role: 'Developer',
        providerId: 'opencode',
        model: 'opencode/nemotron-3-super-free',
      },
    ],
    memberSpawnStatuses: new Map([
      [
        'alice',
        {
          status: 'online',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastHeartbeatAt: now,
          lastRuntimeAliveAt: now,
          lastEvaluatedAt: now,
          updatedAt: now,
          livenessSource: 'heartbeat',
        },
      ],
    ]),
    mixedSecondaryLanes: [
      {
        laneId: 'secondary:opencode:bob',
        providerId: 'opencode',
        member: {
          name: 'bob',
          role: 'Developer',
          providerId: 'opencode',
          model: 'opencode/minimax-m2.5-free',
        },
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
      {
        laneId: 'secondary:opencode:tom',
        providerId: 'opencode',
        member: {
          name: 'tom',
          role: 'Developer',
          providerId: 'opencode',
          model: 'opencode/nemotron-3-super-free',
        },
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ],
    memberSpawnToolUseIds: new Map(),
    pendingMemberRestarts: new Map(),
    pendingApprovals: new Map(),
    memberSpawnLeadInboxCursorByMember: new Map(),
    provisioningOutputParts: [],
    stdoutBuffer: '',
    stderrBuffer: '',
    claudeLogLines: [],
    activeToolCalls: new Map(),
    activeCrossTeamReplyHints: [],
    pendingInboxRelayCandidates: [],
    mcpConfigPath: null,
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
  };
}

function addGeminiPrimaryToMixedRun(run: any): void {
  const now = '2026-04-23T10:00:00.000Z';
  const reviewer = {
    name: 'reviewer',
    role: 'Reviewer',
    providerId: 'gemini',
    model: 'gemini-2.5-flash',
  };
  run.expectedMembers = Array.from(new Set([...(run.expectedMembers ?? []), 'reviewer']));
  run.effectiveMembers = [...(run.effectiveMembers ?? []), reviewer];
  run.allEffectiveMembers = [
    ...run.effectiveMembers,
    ...((run.allEffectiveMembers ?? []) as Array<Record<string, unknown>>).filter(
      (member) => member.providerId === 'opencode'
    ),
  ];
  run.memberSpawnStatuses.set('reviewer', {
    status: 'online',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    lastHeartbeatAt: now,
    lastRuntimeAliveAt: now,
    lastEvaluatedAt: now,
    updatedAt: now,
    livenessSource: 'heartbeat',
  });
}

function createPureAnthropicLiveRun(input: { teamName: string; projectPath: string }): any {
  const now = '2026-04-23T10:00:00.000Z';
  const memberStatus = {
    status: 'online',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    lastHeartbeatAt: now,
    lastRuntimeAliveAt: now,
    lastEvaluatedAt: now,
    updatedAt: now,
    livenessSource: 'heartbeat',
  };
  return {
    ...createMixedLiveRun({
      teamName: input.teamName,
      projectPath: input.projectPath,
      primaryProviderId: 'anthropic',
    }),
    request: {
      teamName: input.teamName,
      cwd: input.projectPath,
      providerId: 'anthropic',
      model: 'sonnet',
      skipPermissions: false,
      members: [],
    },
    expectedMembers: ['alice', 'bob'],
    effectiveMembers: [
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: 'anthropic',
        model: 'haiku',
      },
      {
        name: 'bob',
        role: 'Developer',
        providerId: 'anthropic',
        model: 'sonnet',
      },
    ],
    allEffectiveMembers: [
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: 'anthropic',
        model: 'haiku',
      },
      {
        name: 'bob',
        role: 'Developer',
        providerId: 'anthropic',
        model: 'sonnet',
      },
    ],
    memberSpawnStatuses: new Map([
      ['alice', { ...memberStatus }],
      ['bob', { ...memberStatus }],
    ]),
    mixedSecondaryLanes: [],
  };
}

function trackLiveRun(svc: TeamProvisioningService, run: any): void {
  (svc as any).runs.set(run.runId, run);
  (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);
  (svc as any).aliveRunByTeam.set(run.teamName, run.runId);
}

function expectDirectChildKillCount(actual: number, expected: number): void {
  // Windows uses taskkill.exe for process-tree termination, so fake child.kill is not called.
  expect(actual).toBe(process.platform === 'win32' ? 0 : expected);
}

function injectStaleTerminalProvisioningRun(
  svc: TeamProvisioningService,
  teamName: string,
  runId: string
): void {
  const timestamp = '2026-04-23T10:00:00.000Z';
  (svc as any).provisioningRunByTeam.set(teamName, runId);
  (svc as any).runtimeAdapterProgressByRunId.set(runId, {
    runId,
    teamName,
    state: 'failed',
    message: 'stale provisioning failure',
    startedAt: timestamp,
    updatedAt: timestamp,
  } satisfies TeamProvisioningProgress);
}

function createWritableStdin(writes: string[]): {
  writable: true;
  write: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
} {
  return {
    writable: true,
    write: (chunk, callback) => {
      writes.push(chunk);
      callback?.();
      return true;
    },
  };
}

async function writeOpenCodeTeamConfig(input: {
  teamName: string;
  projectPath: string;
  members: string[];
  removedMembers?: string[];
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  const removedMembers = new Set(input.removedMembers ?? []);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: 'opencode',
            model: 'opencode/big-pickle',
          },
          ...input.members.map((name) => ({
            name,
            role: 'Developer',
            providerId: 'opencode',
            model: 'opencode/big-pickle',
            ...(removedMembers.has(name) ? { removedAt: 1_777_000_000_000 } : {}),
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeOpenCodeMembersMeta(
  teamName: string,
  options: {
    members: string[];
    removedMembers?: string[];
    memberCwd?: string;
  }
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const removedMembers = new Set(options.removedMembers ?? []);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'members.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        members: options.members.map((name) => ({
          name,
          providerId: 'opencode',
          model: 'opencode/big-pickle',
          ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
          ...(removedMembers.has(name) ? { removedAt: 1_777_000_000_000 } : {}),
        })),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeOpenCodeTeamMeta(teamName: string, projectPath: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'team.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        cwd: projectPath,
        providerId: 'opencode',
        model: 'opencode/big-pickle',
        effort: 'medium',
        createdAt: Date.now(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writePureAnthropicTeamConfig(input: {
  teamName: string;
  projectPath: string;
}): Promise<void> {
  await writePureAnthropicTeamConfigWithMembers({
    ...input,
    members: ['alice', 'bob'],
  });
}

async function writePureAnthropicTeamConfigWithMembers(input: {
  teamName: string;
  projectPath: string;
  members: string[];
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        providerId: 'anthropic',
        model: 'sonnet',
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: 'anthropic',
            model: 'sonnet',
          },
          ...input.members.map((name, index) => ({
            name,
            role: index === 0 ? 'Reviewer' : 'Developer',
            providerId: 'anthropic',
            model: index === 0 ? 'haiku' : 'sonnet',
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMixedTeamConfig(input: {
  teamName: string;
  projectPath: string;
  includeGeminiPrimary?: boolean;
  primaryProviderId?: MixedPrimaryProviderId;
  removedMembers?: string[];
  extraMembers?: Array<{ name: string; providerId: 'opencode'; model: string }>;
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  const primary = getMixedPrimaryFixture(input.primaryProviderId);
  const removedMembers = new Set(input.removedMembers ?? []);
  const extraMembers = input.extraMembers ?? [];
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        providerId: primary.providerId,
        ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
        model: primary.leadModel,
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: primary.providerId,
            ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
            model: primary.leadModel,
          },
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: primary.providerId,
            ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
            model: primary.memberModel,
            ...(removedMembers.has('alice') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...(input.includeGeminiPrimary
            ? [
                {
                  name: 'reviewer',
                  role: 'Reviewer',
                  providerId: 'gemini',
                  model: 'gemini-2.5-flash',
                  ...(removedMembers.has('reviewer') ? { removedAt: 1_777_000_000_000 } : {}),
                },
              ]
            : []),
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            ...(removedMembers.has('bob') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          {
            name: 'tom',
            role: 'Developer',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            ...(removedMembers.has('tom') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...extraMembers.map((member) => ({
            name: member.name,
            role: 'Developer',
            providerId: member.providerId,
            model: member.model,
            ...(removedMembers.has(member.name) ? { removedAt: 1_777_000_000_000 } : {}),
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMixedTeamConfigWithoutOpenCodeProviderMetadata(input: {
  teamName: string;
  projectPath: string;
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4',
          },
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4-mini',
          },
          {
            name: 'bob',
            role: 'Developer',
            model: 'opencode/minimax-m2.5-free',
          },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMixedTeamLaunchState(input: {
  teamName: string;
  updatedAt?: string;
  members: Record<string, ReturnType<typeof mixedMemberState>>;
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  const snapshot = createPersistedLaunchSnapshot({
    teamName: input.teamName,
    leadSessionId: 'lead-session',
    launchPhase: 'active',
    expectedMembers: Object.keys(input.members),
    bootstrapExpectedMembers: ['alice'],
    members: input.members as any,
    updatedAt: input.updatedAt,
  });
  await fs.writeFile(
    path.join(teamDir, 'launch-state.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8'
  );
}

async function writePureAnthropicTeamLaunchState(input: {
  teamName: string;
  launchPhase?: 'active' | 'finished' | 'reconciled';
  expectedMembers?: string[];
  members: Record<string, ReturnType<typeof mixedMemberState>>;
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  const expectedMembers = input.expectedMembers ?? Object.keys(input.members);
  const snapshot = createPersistedLaunchSnapshot({
    teamName: input.teamName,
    leadSessionId: 'lead-session',
    launchPhase: input.launchPhase ?? 'active',
    expectedMembers,
    bootstrapExpectedMembers: expectedMembers,
    members: input.members as any,
  });
  await fs.writeFile(
    path.join(teamDir, 'launch-state.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8'
  );
}

async function writePureAnthropicPendingBobFixture(input: {
  teamName: string;
  projectPath: string;
  acceptedAt: string;
}): Promise<void> {
  await writePureAnthropicTeamConfig({ teamName: input.teamName, projectPath: input.projectPath });
  await writePureAnthropicTeamMeta(input.teamName, input.projectPath);
  await writePureAnthropicMembersMeta(input.teamName);
  await writePureAnthropicTeamLaunchState({
    teamName: input.teamName,
    launchPhase: 'active',
    members: {
      alice: mixedMemberState({
        name: 'alice',
        providerId: 'anthropic',
        model: 'haiku',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      }),
      bob: mixedMemberState({
        name: 'bob',
        providerId: 'anthropic',
        model: 'sonnet',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        firstSpawnAcceptedAt: input.acceptedAt,
      }),
    },
  });
}

async function writePureAnthropicPendingMembersFixture(input: {
  teamName: string;
  projectPath: string;
  acceptedAt: string;
}): Promise<void> {
  await writePureAnthropicTeamConfig({ teamName: input.teamName, projectPath: input.projectPath });
  await writePureAnthropicTeamMeta(input.teamName, input.projectPath);
  await writePureAnthropicMembersMeta(input.teamName);
  await writePureAnthropicTeamLaunchState({
    teamName: input.teamName,
    launchPhase: 'active',
    members: {
      alice: mixedMemberState({
        name: 'alice',
        providerId: 'anthropic',
        model: 'haiku',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        firstSpawnAcceptedAt: input.acceptedAt,
      }),
      bob: mixedMemberState({
        name: 'bob',
        providerId: 'anthropic',
        model: 'sonnet',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        firstSpawnAcceptedAt: input.acceptedAt,
      }),
    },
  });
}

async function writeMixedAnthropicPendingAliceFixture(input: {
  teamName: string;
  projectPath: string;
  acceptedAt: string;
}): Promise<void> {
  await writeMixedTeamConfig({
    teamName: input.teamName,
    projectPath: input.projectPath,
    primaryProviderId: 'anthropic',
  });
  await writeTeamMeta(input.teamName, input.projectPath, { primaryProviderId: 'anthropic' });
  await writeMembersMeta(input.teamName, { primaryProviderId: 'anthropic' });
  await writeMixedTeamLaunchState({
    teamName: input.teamName,
    members: {
      alice: mixedMemberState({
        name: 'alice',
        providerId: 'anthropic',
        model: 'haiku',
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'anthropic',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        firstSpawnAcceptedAt: input.acceptedAt,
      }),
      bob: mixedMemberState({
        name: 'bob',
        providerId: 'opencode',
        model: 'opencode/minimax-m2.5-free',
        laneId: 'secondary:opencode:bob',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      }),
      tom: mixedMemberState({
        name: 'tom',
        providerId: 'opencode',
        model: 'opencode/nemotron-3-super-free',
        laneId: 'secondary:opencode:tom',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      }),
    },
  });
}

async function writeLegacyPartialLaunchState(input: {
  teamName: string;
  expectedMembers: string[];
  confirmedMembers: string[];
  missingMembers: string[];
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'launch-state.json'),
    `${JSON.stringify(
      {
        state: 'partial_launch_failure',
        expectedMembers: input.expectedMembers,
        confirmedMembers: input.confirmedMembers,
        missingMembers: input.missingMembers,
        leadSessionId: 'lead-session',
        updatedAt: '2026-04-23T10:00:00.000Z',
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeBootstrapState(
  teamName: string,
  members: Array<{
    name: string;
    status: string;
    lastAttemptAt?: number;
    lastObservedAt?: number;
    failureReason?: string;
  }>
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'bootstrap-state.json'),
    `${JSON.stringify(
      {
        version: 1,
        teamName,
        updatedAt: '2026-04-23T10:00:06.000Z',
        phase: 'completed',
        members,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeLeadInboxMessages(
  teamName: string,
  messages: Array<{
    from: string;
    text: string;
    timestamp: string;
    messageId: string;
    read?: boolean;
  }>
): Promise<void> {
  const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.writeFile(
    path.join(inboxDir, 'team-lead.json'),
    `${JSON.stringify(
      messages.map((message) => ({
        ...message,
        to: 'team-lead',
        read: message.read ?? false,
      })),
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMemberTranscript(input: {
  projectPath: string;
  sessionId: string;
  records: Record<string, unknown>[];
}): Promise<void> {
  const projectDir = getProjectTranscriptDir(input.projectPath);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${input.sessionId}.jsonl`),
    `${input.records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  );
}

async function writeRawMemberTranscript(input: {
  projectPath: string;
  sessionId: string;
  lines: string[];
}): Promise<void> {
  const projectDir = getProjectTranscriptDir(input.projectPath);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${input.sessionId}.jsonl`),
    `${input.lines.join('\n')}\n`,
    'utf8'
  );
}

function getProjectTranscriptDir(projectPath: string): string {
  return path.join(getProjectsBasePath(), extractBaseDir(encodePath(projectPath)));
}

function getMemberTranscriptPath(projectPath: string, sessionId: string): string {
  return path.join(getProjectTranscriptDir(projectPath), `${sessionId}.jsonl`);
}

function bootstrapTranscriptRecord(input: {
  timestamp: string;
  teamName: string;
  memberName: string;
  agentName?: string;
}): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    teamName: input.teamName,
    agentName: input.agentName ?? input.memberName,
    type: 'user',
    message: {
      role: 'user',
      content: `You are bootstrapping into team "${input.teamName}" as member "${input.memberName}".`,
    },
  };
}

function bootstrapSuccessTranscriptRecord(input: {
  timestamp: string;
  teamName: string;
  memberName: string;
  agentName?: string;
}): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    teamName: input.teamName,
    agentName: input.agentName ?? input.memberName,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `Member briefing for ${input.memberName} on team "${input.teamName}" (${input.teamName}).\nTask briefing for ${input.memberName}:\nNo actionable tasks.`,
        },
      ],
    },
  };
}

function bootstrapFailureTranscriptRecord(input: {
  timestamp: string;
  teamName: string;
  memberName: string;
  agentName?: string;
}): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    teamName: input.teamName,
    agentName: input.agentName ?? input.memberName,
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
        },
      ],
    },
  };
}

function genericTranscriptApiErrorRecord(input: { timestamp: string }): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'API Error: 400 {"detail":"The requested Anthropic model is not available for your account."}',
        },
      ],
    },
  };
}

function withoutAgentName(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  delete next.agentName;
  return next;
}

function mixedMemberState(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: overrides.name,
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
    ...overrides,
  };
}

function getMixedPrimaryFixture(providerId: MixedPrimaryProviderId = 'codex'): {
  providerId: MixedPrimaryProviderId;
  providerBackendId?: string;
  leadModel: string;
  memberModel: string;
} {
  if (providerId === 'anthropic') {
    return {
      providerId,
      leadModel: 'sonnet',
      memberModel: 'haiku',
    };
  }

  return {
    providerId,
    providerBackendId: 'codex-native',
    leadModel: 'gpt-5.4',
    memberModel: 'gpt-5.4-mini',
  };
}

async function writeTeamMeta(
  teamName: string,
  projectPath: string,
  options: { primaryProviderId?: MixedPrimaryProviderId } = {}
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const primary = getMixedPrimaryFixture(options.primaryProviderId);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'team.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        cwd: projectPath,
        providerId: primary.providerId,
        ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
        model: primary.leadModel,
        effort: 'medium',
        createdAt: Date.now(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writePureAnthropicTeamMeta(teamName: string, projectPath: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'team.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        cwd: projectPath,
        providerId: 'anthropic',
        model: 'sonnet',
        effort: 'medium',
        createdAt: Date.now(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writePureAnthropicMembersMeta(
  teamName: string,
  options: {
    removedMembers?: string[];
    extraMembers?: Array<{ name: string; providerId: 'anthropic'; model: string }>;
  } = {}
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const removedMembers = new Set(options.removedMembers ?? []);
  const extraMembers = options.extraMembers ?? [];
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'members.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        members: [
          {
            name: 'alice',
            providerId: 'anthropic',
            model: 'haiku',
            ...(removedMembers.has('alice') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          {
            name: 'bob',
            providerId: 'anthropic',
            model: 'sonnet',
            ...(removedMembers.has('bob') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...extraMembers.map((member) => ({
            name: member.name,
            providerId: member.providerId,
            model: member.model,
            ...(removedMembers.has(member.name) ? { removedAt: 1_777_000_000_000 } : {}),
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeMembersMeta(
  teamName: string,
  options: {
    includeGeminiPrimary?: boolean;
    primaryProviderId?: MixedPrimaryProviderId;
    removedMembers?: string[];
    extraMembers?: Array<{ name: string; providerId: 'opencode'; model: string }>;
    memberCwd?: string;
  } = {}
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const primary = getMixedPrimaryFixture(options.primaryProviderId);
  const removedMembers = new Set(options.removedMembers ?? []);
  const extraMembers = options.extraMembers ?? [];
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'members.meta.json'),
    `${JSON.stringify(
      {
        version: 1,
        ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
        members: [
          {
            name: 'alice',
            providerId: primary.providerId,
            ...(primary.providerBackendId ? { providerBackendId: primary.providerBackendId } : {}),
            model: primary.memberModel,
            ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
            ...(removedMembers.has('alice') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...(options.includeGeminiPrimary
            ? [
                {
                  name: 'reviewer',
                  providerId: 'gemini',
                  model: 'gemini-2.5-flash',
                  ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
                  ...(removedMembers.has('reviewer') ? { removedAt: 1_777_000_000_000 } : {}),
                },
              ]
            : []),
          {
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
            ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
            ...(removedMembers.has('bob') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          {
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
            ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
            ...(removedMembers.has('tom') ? { removedAt: 1_777_000_000_000 } : {}),
          },
          ...extraMembers.map((member) => ({
            name: member.name,
            providerId: member.providerId,
            model: member.model,
            ...(options.memberCwd ? { cwd: options.memberCwd } : {}),
            ...(removedMembers.has(member.name) ? { removedAt: 1_777_000_000_000 } : {}),
          })),
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}
