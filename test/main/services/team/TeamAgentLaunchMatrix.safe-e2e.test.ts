import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
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
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { createPersistedLaunchSnapshot } from '../../../../src/main/services/team/TeamLaunchStateEvaluator';
import {
  readOpenCodeRuntimeLaneIndex,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import type { TeamProvisioningProgress } from '../../../../src/shared/types';

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
      status: 'online',
      launchState: 'runtime_pending_permission',
      runtimeAlive: true,
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
      status: 'online',
      launchState: 'runtime_pending_permission',
      runtimeAlive: true,
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
      runtimeAlivePendingCount: 1,
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
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
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
      status: 'online',
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
    await waitForCondition(() => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive');
    await waitForCondition(() => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_permission');

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
      status: 'online',
      launchState: 'runtime_pending_permission',
      runtimeAlive: true,
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
    await waitForCondition(() => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive');
    await waitForCondition(() => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive');

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
    await waitForCondition(() => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive');
    await waitForCondition(
      () => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_bootstrap'
    );

    const statuses = await svc.getMemberSpawnStatuses(teamName);
    expect(statuses.teamLaunchState).toBe('partial_pending');
    expect(statuses.summary).toMatchObject({
      confirmedCount: 2,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 1,
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
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
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
      alive: true,
      runtimeModel: 'opencode/nemotron-3-super-free',
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
      ...run.allEffectiveMembers.filter((member: { providerId?: string }) => member.providerId === 'opencode'),
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
    await waitForCondition(() => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive');
    await waitForCondition(() => run.memberSpawnStatuses.get('tom')?.launchState === 'runtime_pending_permission');

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
      status: 'online',
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
    await waitForCondition(() => run.memberSpawnStatuses.get('bob')?.launchState === 'failed_to_start');
    await waitForCondition(() => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive');

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
    await waitForCondition(() => run.memberSpawnStatuses.get('bob')?.launchState === 'confirmed_alive');
    await waitForCondition(() => run.memberSpawnStatuses.get('tom')?.launchState === 'confirmed_alive');

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
      status: 'online',
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
    expect(run.mixedSecondaryLanes.map((lane: { member: { name: string } }) => lane.member.name)).toEqual([
      'tom',
    ]);

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
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:tom': { state: 'active' },
      },
    });
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

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject({
      lanes: {},
    });
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

    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject({
      lanes: {},
    });
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
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:bob': { state: 'degraded' },
        'secondary:opencode:tom': { state: 'degraded' },
      },
    });
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
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:bob': { state: 'active' },
        'secondary:opencode:tom': { state: 'active' },
      },
    });
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
      status: 'online',
      launchState: 'runtime_pending_permission',
      hardFailure: false,
      pendingPermissionRequestIds: ['perm-tom'],
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:bob': { state: 'active' },
        'secondary:opencode:tom': { state: 'active' },
      },
    });
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
      runtimeAlivePendingCount: 1,
    });
    expect(statuses.statuses.bob).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      hardFailure: false,
    });
    expect(statuses.statuses.tom).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(statuses.statuses.bob?.launchState).not.toBe('failed_to_start');
    expect(statuses.statuses.tom?.launchState).not.toBe('failed_to_start');
    await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject({
      lanes: {
        'secondary:opencode:bob': { state: 'active' },
        'secondary:opencode:tom': { state: 'active' },
      },
    });
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
});

type FakeMemberOutcome = 'confirmed' | 'permission' | 'launching' | 'failed';
type MixedPrimaryProviderId = 'anthropic' | 'codex';

class FakeOpenCodeRuntimeAdapter implements TeamLaunchRuntimeAdapter {
  readonly providerId = 'opencode' as const;
  readonly launchInputs: TeamRuntimeLaunchInput[] = [];
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
      diagnostics: this.launchState === 'partial_failure'
        ? ['fake OpenCode launch failed']
        : this.launchState === 'partial_pending'
          ? ['fake OpenCode launch awaiting permission']
          : ['fake OpenCode launch ready'],
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
      runtimeAlive: !failed,
      bootstrapConfirmed: !failed && !permissionPending && !bootstrapPending,
      hardFailure: failed,
      hardFailureReason: failed ? 'fake_open_code_launch_failure' : undefined,
      pendingPermissionRequestIds: permissionPending ? [`perm-${member.name}`] : undefined,
      runtimePid: failed ? undefined : 10_000 + index,
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
    const outcomes = members.map((member) => this.memberOutcomes[member.name] ?? this.defaultOutcome());
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

function trackLiveRun(svc: TeamProvisioningService, run: any): void {
  (svc as any).runs.set(run.runId, run);
  (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);
  (svc as any).aliveRunByTeam.set(run.teamName, run.runId);
}

async function writeOpenCodeTeamConfig(input: {
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
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  const primary = getMixedPrimaryFixture(input.primaryProviderId);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        providerId: primary.providerId,
        ...(primary.providerBackendId
          ? { providerBackendId: primary.providerBackendId }
          : {}),
        model: primary.leadModel,
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: primary.providerId,
            ...(primary.providerBackendId
              ? { providerBackendId: primary.providerBackendId }
              : {}),
            model: primary.leadModel,
          },
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: primary.providerId,
            ...(primary.providerBackendId
              ? { providerBackendId: primary.providerBackendId }
              : {}),
            model: primary.memberModel,
          },
          ...(input.includeGeminiPrimary
            ? [
                {
                  name: 'reviewer',
                  role: 'Reviewer',
                  providerId: 'gemini',
                  model: 'gemini-2.5-flash',
                },
              ]
            : []),
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
  });
  await fs.writeFile(
    path.join(teamDir, 'launch-state.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8'
  );
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

function getMixedPrimaryFixture(
  providerId: MixedPrimaryProviderId = 'codex'
): {
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
        ...(primary.providerBackendId
          ? { providerBackendId: primary.providerBackendId }
          : {}),
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

async function writeMembersMeta(
  teamName: string,
  options: { includeGeminiPrimary?: boolean; primaryProviderId?: MixedPrimaryProviderId } = {}
): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  const primary = getMixedPrimaryFixture(options.primaryProviderId);
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
            ...(primary.providerBackendId
              ? { providerBackendId: primary.providerBackendId }
              : {}),
            model: primary.memberModel,
          },
          ...(options.includeGeminiPrimary
            ? [
                {
                  name: 'reviewer',
                  providerId: 'gemini',
                  model: 'gemini-2.5-flash',
                },
              ]
            : []),
          {
            name: 'bob',
            providerId: 'opencode',
            model: 'opencode/minimax-m2.5-free',
          },
          {
            name: 'tom',
            providerId: 'opencode',
            model: 'opencode/nemotron-3-super-free',
          },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}
