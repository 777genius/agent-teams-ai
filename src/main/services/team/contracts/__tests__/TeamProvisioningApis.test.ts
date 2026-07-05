import { describe, expect, it } from 'vitest';

import {
  bindTeamDiagnosticsApi,
  bindTeamLaunchApi,
  bindTeamMemberLifecycleApi,
  bindTeamRuntimeApi,
} from '../TeamProvisioningApis';

import type {
  OpenCodeRuntimeControlAck,
  TeamDiagnosticsApi,
  TeamLaunchApi,
  TeamMemberLifecycleApi,
  TeamRuntimeApi,
} from '../TeamProvisioningApis';
import type {
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberSpawnStatusesSnapshot,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamAgentRuntimeSnapshot,
  TeamCreateResponse,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types/team';

const TEST_TEAM_CWD = '/workspace/team';

describe('TeamProvisioning API binders', () => {
  it('binds launch methods and optional status repair to the source object', async () => {
    interface LaunchSource extends TeamLaunchApi {
      readonly runId: string;
      repairedTeamName: string | null;
    }

    const source: LaunchSource = {
      runId: 'run-bound',
      repairedTeamName: null,
      createTeam(this: LaunchSource): Promise<TeamCreateResponse> {
        return Promise.resolve({ runId: this.runId });
      },
      launchTeam(this: LaunchSource): Promise<TeamLaunchResponse> {
        return Promise.resolve({ runId: this.runId });
      },
      getProvisioningStatus(this: LaunchSource): Promise<TeamProvisioningProgress> {
        return Promise.resolve({
          runId: this.runId,
          teamName: 'team-bound',
          state: 'spawning',
          message: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        });
      },
      repairStaleTaskActivityIntervalsBeforeSnapshot(
        this: LaunchSource,
        teamName: string
      ): Promise<void> {
        this.repairedTeamName = teamName;
        return Promise.resolve();
      },
    };

    const api = bindTeamLaunchApi(source);
    const createTeam = api.createTeam.bind(undefined);
    const launchTeam = api.launchTeam.bind(undefined);
    const getProvisioningStatus = api.getProvisioningStatus.bind(undefined);
    const repairStaleTaskActivityIntervalsBeforeSnapshot =
      api.repairStaleTaskActivityIntervalsBeforeSnapshot?.bind(undefined);

    await expect(
      createTeam({ teamName: 'team-bound', cwd: TEST_TEAM_CWD, members: [] }, () => undefined)
    ).resolves.toEqual({
      runId: 'run-bound',
    });
    await expect(
      launchTeam({ teamName: 'team-bound', cwd: TEST_TEAM_CWD }, () => undefined)
    ).resolves.toEqual({
      runId: 'run-bound',
    });
    await expect(getProvisioningStatus('run-bound')).resolves.toMatchObject({
      runId: 'run-bound',
      teamName: 'team-bound',
    });
    await repairStaleTaskActivityIntervalsBeforeSnapshot?.('team-bound');
    expect(source.repairedTeamName).toBe('team-bound');
  });

  it('binds runtime control methods to the source object', async () => {
    interface RuntimeSource extends TeamRuntimeApi {
      readonly teamName: string;
      stoppedTeamName: string | null;
    }

    const ack = (source: RuntimeSource): OpenCodeRuntimeControlAck => ({
      ok: true,
      providerId: 'opencode',
      teamName: source.teamName,
      runId: 'run-bound',
      state: 'recorded',
      diagnostics: [],
      observedAt: '2026-01-01T00:00:00.000Z',
    });
    const source: RuntimeSource = {
      teamName: 'team-bound',
      stoppedTeamName: null,
      getRuntimeState(this: RuntimeSource): Promise<TeamRuntimeState> {
        return Promise.resolve({
          teamName: this.teamName,
          isAlive: true,
          runId: 'run-bound',
          progress: null,
        });
      },
      stopTeam(this: RuntimeSource, teamName: string): Promise<void> {
        this.stoppedTeamName = teamName;
        return Promise.resolve();
      },
      isTeamAlive(this: RuntimeSource, teamName: string): boolean {
        return teamName === this.teamName;
      },
      getAliveTeams(this: RuntimeSource): string[] {
        return [this.teamName];
      },
      getCurrentRunId(): string {
        return 'run-bound';
      },
      recordOpenCodeRuntimeBootstrapCheckin(
        this: RuntimeSource
      ): Promise<OpenCodeRuntimeControlAck> {
        return Promise.resolve(ack(this));
      },
      deliverOpenCodeRuntimeMessage(this: RuntimeSource): Promise<OpenCodeRuntimeControlAck> {
        return Promise.resolve({ ...ack(this), state: 'delivered' });
      },
      recordOpenCodeRuntimeTaskEvent(this: RuntimeSource): Promise<OpenCodeRuntimeControlAck> {
        return Promise.resolve(ack(this));
      },
      recordOpenCodeRuntimeHeartbeat(this: RuntimeSource): Promise<OpenCodeRuntimeControlAck> {
        return Promise.resolve(ack(this));
      },
    };

    const api = bindTeamRuntimeApi(source);
    const getRuntimeState = api.getRuntimeState.bind(undefined);
    const stopTeam = api.stopTeam.bind(undefined);
    const deliverOpenCodeRuntimeMessage = api.deliverOpenCodeRuntimeMessage.bind(undefined);

    await expect(getRuntimeState('team-bound')).resolves.toMatchObject({
      teamName: 'team-bound',
      runId: 'run-bound',
    });
    await stopTeam('team-bound');
    expect(source.stoppedTeamName).toBe('team-bound');
    await expect(deliverOpenCodeRuntimeMessage({})).resolves.toMatchObject({
      teamName: 'team-bound',
      state: 'delivered',
    });
  });

  it('binds member lifecycle and diagnostics methods to the source object', async () => {
    interface MemberLifecycleSource extends TeamMemberLifecycleApi {
      readonly runId: string;
      restartedMemberName: string | null;
      skippedMemberName: string | null;
    }
    interface DiagnosticsSource extends TeamDiagnosticsApi {
      readonly teamName: string;
    }

    const memberLifecycleSource: MemberLifecycleSource = {
      runId: 'run-bound',
      restartedMemberName: null,
      skippedMemberName: null,
      getMemberSpawnStatuses(this: MemberLifecycleSource): Promise<MemberSpawnStatusesSnapshot> {
        return Promise.resolve({ statuses: {}, runId: this.runId });
      },
      restartMember(
        this: MemberLifecycleSource,
        _teamName: string,
        memberName: string
      ): Promise<void> {
        this.restartedMemberName = memberName;
        return Promise.resolve();
      },
      retryFailedOpenCodeSecondaryLanes(
        this: MemberLifecycleSource
      ): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
        return Promise.resolve({
          attempted: [this.runId],
          confirmed: [],
          pending: [],
          failed: [],
          skipped: [],
        });
      },
      skipMemberForLaunch(
        this: MemberLifecycleSource,
        _teamName: string,
        memberName: string
      ): Promise<void> {
        this.skippedMemberName = memberName;
        return Promise.resolve();
      },
    };
    const diagnosticsSource: DiagnosticsSource = {
      teamName: 'team-bound',
      getLeadActivityState(this: DiagnosticsSource): LeadActivitySnapshot {
        return { state: 'active', runId: this.teamName };
      },
      getLeadContextUsage(this: DiagnosticsSource): LeadContextUsageSnapshot {
        return { usage: null, runId: this.teamName };
      },
      getTeamAgentRuntimeSnapshot(this: DiagnosticsSource): Promise<TeamAgentRuntimeSnapshot> {
        return Promise.resolve({
          teamName: this.teamName,
          updatedAt: '2026-01-01T00:00:00.000Z',
          runId: null,
          members: {},
        });
      },
    };

    const memberLifecycleApi = bindTeamMemberLifecycleApi(memberLifecycleSource);
    const diagnosticsApi = bindTeamDiagnosticsApi(diagnosticsSource);
    const restartMember = memberLifecycleApi.restartMember.bind(undefined);
    const skipMemberForLaunch = memberLifecycleApi.skipMemberForLaunch.bind(undefined);
    const getTeamAgentRuntimeSnapshot = diagnosticsApi.getTeamAgentRuntimeSnapshot.bind(undefined);

    await expect(memberLifecycleApi.getMemberSpawnStatuses('team-bound')).resolves.toEqual({
      statuses: {},
      runId: 'run-bound',
    });
    await restartMember('team-bound', 'worker');
    await skipMemberForLaunch('team-bound', 'blocked-worker');
    expect(memberLifecycleSource.restartedMemberName).toBe('worker');
    expect(memberLifecycleSource.skippedMemberName).toBe('blocked-worker');
    expect(diagnosticsApi.getLeadActivityState('team-bound')).toEqual({
      state: 'active',
      runId: 'team-bound',
    });
    await expect(getTeamAgentRuntimeSnapshot('team-bound')).resolves.toMatchObject({
      teamName: 'team-bound',
    });
  });
});
