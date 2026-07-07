import { describe, expect, it } from 'vitest';

import {
  bindTeamClaudeLogsApi,
  bindTeamDiagnosticsApi,
  bindTeamHttpDataApi,
  bindTeamHttpRuntimeApi,
  bindTeamLaunchApi,
  bindTeamMemberLifecycleApi,
  bindTeamMessagingApi,
  bindTeamProvisioningPreflightApi,
  bindTeamProvisioningRunApi,
  bindTeamRuntimeApi,
  bindTeamRuntimeControlCompatibilityApi,
  bindTeamTaskActivityRepairApi,
  bindTeamToolApprovalApi,
} from '../TeamProvisioningApis';

import type {
  OpenCodeRuntimeControlAck,
  TeamClaudeLogsApi,
  TeamDiagnosticsApi,
  TeamHttpDataApi,
  TeamLaunchApi,
  TeamMemberLifecycleApi,
  TeamMessagingApi,
  TeamOpenCodeMemberInboxRelayOptions,
  TeamProvisioningPreflightApi,
  TeamProvisioningRunApi,
  TeamRuntimeApi,
  TeamRuntimeControlCompatibilityApi,
  TeamTaskActivityRepairApi,
  TeamToolApprovalApi,
} from '../TeamProvisioningApis';
import type {
  InboxMessage,
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberSpawnStatusesSnapshot,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamAgentRuntimeSnapshot,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchResponse,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamRuntimeState,
  TeamSummary,
  TeamViewSnapshot,
  ToolApprovalSettings,
} from '@shared/types/team';

const TEST_TEAM_CWD = '/workspace/team';

describe('TeamProvisioning API binders', () => {
  it('binds launch methods to the source object', async () => {
    interface LaunchSource extends TeamLaunchApi {
      readonly runId: string;
    }

    const source: LaunchSource = {
      runId: 'run-bound',
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
    };

    const api = bindTeamLaunchApi(source);
    const createTeam = api.createTeam.bind(undefined);
    const launchTeam = api.launchTeam.bind(undefined);
    const getProvisioningStatus = api.getProvisioningStatus.bind(undefined);

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
  });

  it('binds provisioning preflight methods to the source object', async () => {
    interface PreflightSource extends TeamProvisioningPreflightApi {
      readonly cwd: string;
    }

    const source: PreflightSource = {
      cwd: TEST_TEAM_CWD,
      getCliHelpOutput(this: PreflightSource): Promise<string> {
        return Promise.resolve(`Usage ${this.cwd}`);
      },
      prepareForProvisioning(
        this: PreflightSource,
        cwd?: string
      ): Promise<TeamProvisioningPrepareResult> {
        return Promise.resolve({
          ready: true,
          message: cwd ?? this.cwd,
        });
      },
    };

    const api = bindTeamProvisioningPreflightApi(source);
    const getCliHelpOutput = api.getCliHelpOutput.bind(undefined);
    const prepareForProvisioning = api.prepareForProvisioning.bind(undefined);

    await expect(getCliHelpOutput()).resolves.toBe(`Usage ${TEST_TEAM_CWD}`);
    await expect(prepareForProvisioning('/workspace/preflight')).resolves.toEqual({
      ready: true,
      message: '/workspace/preflight',
    });
  });

  it('binds provisioning run and log diagnostic methods to the source object', async () => {
    interface RunSource extends TeamProvisioningRunApi {
      activeTeamName: string | null;
      canceledRunId: string | null;
    }
    interface ClaudeLogsSource extends TeamClaudeLogsApi {
      readonly sourceName: string;
    }

    const runSource: RunSource = {
      activeTeamName: 'team-bound',
      canceledRunId: null,
      cancelProvisioning(this: RunSource, runId: string): Promise<void> {
        this.canceledRunId = runId;
        return Promise.resolve();
      },
      hasProvisioningRun(this: RunSource, teamName: string): boolean {
        return teamName === this.activeTeamName;
      },
    };
    const claudeLogsSource: ClaudeLogsSource = {
      sourceName: 'logs-bound',
      getClaudeLogs(this: ClaudeLogsSource, teamName: string) {
        return Promise.resolve({
          lines: [`${this.sourceName}:${teamName}`],
          total: 1,
          hasMore: false,
        });
      },
    };

    const runApi = bindTeamProvisioningRunApi(runSource);
    const logsApi = bindTeamClaudeLogsApi(claudeLogsSource);
    const cancelProvisioning = runApi.cancelProvisioning.bind(undefined);
    const getClaudeLogs = logsApi.getClaudeLogs.bind(undefined);

    expect(runApi.hasProvisioningRun('team-bound')).toBe(true);
    await cancelProvisioning('run-bound');
    expect(runSource.canceledRunId).toBe('run-bound');
    await expect(getClaudeLogs('team-bound')).resolves.toEqual({
      lines: ['logs-bound:team-bound'],
      total: 1,
      hasMore: false,
    });
  });

  it('binds task activity repair to the source object', async () => {
    interface TaskActivityRepairSource extends TeamTaskActivityRepairApi {
      repairedTeamName: string | null;
    }

    const source: TaskActivityRepairSource = {
      repairedTeamName: null,
      repairStaleTaskActivityIntervalsBeforeSnapshot(
        this: TaskActivityRepairSource,
        teamName: string
      ): Promise<void> {
        this.repairedTeamName = teamName;
        return Promise.resolve();
      },
    };

    const api = bindTeamTaskActivityRepairApi(source);
    const repairStaleTaskActivityIntervalsBeforeSnapshot =
      api.repairStaleTaskActivityIntervalsBeforeSnapshot.bind(undefined);

    await repairStaleTaskActivityIntervalsBeforeSnapshot('team-bound');
    expect(source.repairedTeamName).toBe('team-bound');
  });

  it('binds HTTP team data methods to the source object', async () => {
    interface TeamDataSource extends TeamHttpDataApi {
      readonly suffix: string;
      createdTeamName: string | null;
    }

    const source: TeamDataSource = {
      suffix: 'bound',
      createdTeamName: null,
      listTeams(this: TeamDataSource): Promise<TeamSummary[]> {
        return Promise.resolve([
          {
            teamName: `team-${this.suffix}`,
            displayName: 'Bound Team',
            memberCount: 0,
            taskCount: 0,
            lastActivity: null,
          } as TeamSummary,
        ]);
      },
      getTeamData(this: TeamDataSource, teamName: string): Promise<TeamViewSnapshot> {
        return Promise.resolve({
          teamName: `${teamName}-${this.suffix}`,
          config: null,
          tasks: [],
          messages: [],
          processes: [],
          kanban: null,
        } as unknown as TeamViewSnapshot);
      },
      getSavedRequest(teamName: string): Promise<TeamCreateRequest | null> {
        return Promise.resolve({ teamName, cwd: TEST_TEAM_CWD, members: [] });
      },
      createTeamConfig(this: TeamDataSource, request: TeamCreateConfigRequest): Promise<void> {
        this.createdTeamName = request.teamName;
        return Promise.resolve();
      },
    };

    const api = bindTeamHttpDataApi(source);
    const listTeams = api.listTeams.bind(undefined);
    const getTeamData = api.getTeamData.bind(undefined);
    const getSavedRequest = api.getSavedRequest.bind(undefined);
    const createTeamConfig = api.createTeamConfig.bind(undefined);

    await expect(listTeams()).resolves.toEqual([
      expect.objectContaining({ teamName: 'team-bound' }),
    ]);
    await expect(getTeamData('demo')).resolves.toMatchObject({ teamName: 'demo-bound' });
    await expect(getSavedRequest('draft-team')).resolves.toMatchObject({
      teamName: 'draft-team',
      cwd: TEST_TEAM_CWD,
    });
    await createTeamConfig({
      teamName: 'created-team',
      cwd: TEST_TEAM_CWD,
      members: [],
    } as TeamCreateConfigRequest);
    expect(source.createdTeamName).toBe('created-team');
  });

  it('binds runtime control methods to the source object', async () => {
    interface RuntimeSource extends TeamRuntimeApi, TeamRuntimeControlCompatibilityApi {
      readonly teamName: string;
      stoppedTeamName: string | null;
      compatibilityCalls: number;
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
      compatibilityCalls: 0,
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
        this.compatibilityCalls += 1;
        return Promise.resolve(ack(this));
      },
      deliverOpenCodeRuntimeMessage(this: RuntimeSource): Promise<OpenCodeRuntimeControlAck> {
        this.compatibilityCalls += 1;
        return Promise.resolve({ ...ack(this), state: 'delivered' });
      },
      recordOpenCodeRuntimeTaskEvent(this: RuntimeSource): Promise<OpenCodeRuntimeControlAck> {
        this.compatibilityCalls += 1;
        return Promise.resolve(ack(this));
      },
      recordOpenCodeRuntimeHeartbeat(this: RuntimeSource): Promise<OpenCodeRuntimeControlAck> {
        this.compatibilityCalls += 1;
        return Promise.resolve(ack(this));
      },
    };

    const api = bindTeamRuntimeApi(source);
    const controlCompatibilityApi: TeamRuntimeControlCompatibilityApi =
      bindTeamRuntimeControlCompatibilityApi(source);
    const getRuntimeState = api.getRuntimeState.bind(undefined);
    const stopTeam = api.stopTeam.bind(undefined);
    const deliverOpenCodeRuntimeMessage =
      controlCompatibilityApi.deliverOpenCodeRuntimeMessage.bind(undefined);
    const recordOpenCodeRuntimeHeartbeat =
      controlCompatibilityApi.recordOpenCodeRuntimeHeartbeat.bind(undefined);

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
    await expect(recordOpenCodeRuntimeHeartbeat({})).resolves.toMatchObject({
      teamName: 'team-bound',
      state: 'recorded',
    });
    expect(source.compatibilityCalls).toBe(2);
  });

  it('keeps runtime, runtime-control, task activity, and member lifecycle APIs as separate control surfaces', () => {
    const ack: OpenCodeRuntimeControlAck = {
      ok: true,
      providerId: 'opencode',
      teamName: 'team-bound',
      runId: 'run-bound',
      state: 'recorded',
      diagnostics: [],
      observedAt: '2026-01-01T00:00:00.000Z',
    };
    const runtimeSource: TeamRuntimeApi = {
      getRuntimeState: () =>
        Promise.resolve({
          teamName: 'team-bound',
          isAlive: true,
          runId: 'run-bound',
          progress: null,
        }),
      stopTeam: () => Promise.resolve(),
      isTeamAlive: () => true,
      getAliveTeams: () => ['team-bound'],
      getCurrentRunId: () => 'run-bound',
    };
    const runtimeControlSource: TeamRuntimeControlCompatibilityApi = {
      recordOpenCodeRuntimeBootstrapCheckin: () => Promise.resolve(ack),
      deliverOpenCodeRuntimeMessage: () => Promise.resolve({ ...ack, state: 'delivered' }),
      recordOpenCodeRuntimeTaskEvent: () => Promise.resolve(ack),
      recordOpenCodeRuntimeHeartbeat: () => Promise.resolve(ack),
    };
    const taskActivitySource: TeamTaskActivityRepairApi = {
      repairStaleTaskActivityIntervalsBeforeSnapshot: () => Promise.resolve(),
    };
    const lifecycleSource: TeamMemberLifecycleApi = {
      getMemberSpawnStatuses: () => Promise.resolve({ statuses: {}, runId: 'run-bound' }),
      attachLiveRosterMember: () => Promise.resolve(),
      detachLiveRosterMember: () => Promise.resolve(),
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

    const runtimeApi = bindTeamRuntimeApi(runtimeSource);
    const httpRuntimeApi = bindTeamHttpRuntimeApi(runtimeSource);
    const runtimeControlApi = bindTeamRuntimeControlCompatibilityApi(runtimeControlSource);
    const taskActivityApi = bindTeamTaskActivityRepairApi(taskActivitySource);
    const lifecycleApi = bindTeamMemberLifecycleApi(lifecycleSource);

    expect(Object.keys(runtimeApi).sort()).toEqual([
      'getAliveTeams',
      'getCurrentRunId',
      'getRuntimeState',
      'isTeamAlive',
      'stopTeam',
    ]);
    expect(Object.keys(httpRuntimeApi).sort()).toEqual([
      'getAliveTeams',
      'getRuntimeState',
      'stopTeam',
    ]);
    expect(Object.keys(runtimeControlApi).sort()).toEqual([
      'deliverOpenCodeRuntimeMessage',
      'recordOpenCodeRuntimeBootstrapCheckin',
      'recordOpenCodeRuntimeHeartbeat',
      'recordOpenCodeRuntimeTaskEvent',
    ]);
    expect(Object.keys(taskActivityApi).sort()).toEqual([
      'repairStaleTaskActivityIntervalsBeforeSnapshot',
    ]);
    expect(Object.keys(lifecycleApi).sort()).toEqual([
      'attachLiveRosterMember',
      'detachLiveRosterMember',
      'getMemberSpawnStatuses',
      'restartMember',
      'retryFailedOpenCodeSecondaryLanes',
      'skipMemberForLaunch',
    ]);
    const runtimeKeys = new Set(Object.keys(runtimeApi));
    const runtimeControlKeys = new Set(Object.keys(runtimeControlApi));
    const taskActivityKeys = new Set(Object.keys(taskActivityApi));
    expect(Object.keys(runtimeControlApi).filter((key) => runtimeKeys.has(key))).toEqual([]);
    expect(Object.keys(taskActivityApi).filter((key) => runtimeKeys.has(key))).toEqual([]);
    expect(Object.keys(taskActivityApi).filter((key) => runtimeControlKeys.has(key))).toEqual([]);
    expect(Object.keys(lifecycleApi).filter((key) => runtimeKeys.has(key))).toEqual([]);
    expect(Object.keys(lifecycleApi).filter((key) => runtimeControlKeys.has(key))).toEqual([]);
    expect(Object.keys(lifecycleApi).filter((key) => taskActivityKeys.has(key))).toEqual([]);
  });

  it('binds member lifecycle and diagnostics methods to the source object', async () => {
    interface MemberLifecycleSource extends TeamMemberLifecycleApi {
      readonly runId: string;
      attachedMemberName: string | null;
      attachedReason: string | undefined;
      detachedMemberName: string | null;
      restartedMemberName: string | null;
      skippedMemberName: string | null;
    }
    interface DiagnosticsSource extends TeamDiagnosticsApi {
      readonly teamName: string;
    }

    const memberLifecycleSource: MemberLifecycleSource = {
      runId: 'run-bound',
      attachedMemberName: null,
      attachedReason: undefined,
      detachedMemberName: null,
      restartedMemberName: null,
      skippedMemberName: null,
      getMemberSpawnStatuses(this: MemberLifecycleSource): Promise<MemberSpawnStatusesSnapshot> {
        return Promise.resolve({ statuses: {}, runId: this.runId });
      },
      attachLiveRosterMember(
        this: MemberLifecycleSource,
        _teamName: string,
        memberName: string,
        options?: { reason?: 'member_added' | 'member_restored' | 'member_updated' }
      ): Promise<void> {
        this.attachedMemberName = memberName;
        this.attachedReason = options?.reason;
        return Promise.resolve();
      },
      detachLiveRosterMember(
        this: MemberLifecycleSource,
        _teamName: string,
        memberName: string
      ): Promise<void> {
        this.detachedMemberName = memberName;
        return Promise.resolve();
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
    const attachLiveRosterMember = memberLifecycleApi.attachLiveRosterMember.bind(undefined);
    const detachLiveRosterMember = memberLifecycleApi.detachLiveRosterMember.bind(undefined);
    const restartMember = memberLifecycleApi.restartMember.bind(undefined);
    const skipMemberForLaunch = memberLifecycleApi.skipMemberForLaunch.bind(undefined);
    const getTeamAgentRuntimeSnapshot = diagnosticsApi.getTeamAgentRuntimeSnapshot.bind(undefined);

    await expect(memberLifecycleApi.getMemberSpawnStatuses('team-bound')).resolves.toEqual({
      statuses: {},
      runId: 'run-bound',
    });
    await attachLiveRosterMember('team-bound', 'live-worker', { reason: 'member_added' });
    await detachLiveRosterMember('team-bound', 'stale-worker');
    await restartMember('team-bound', 'worker');
    await skipMemberForLaunch('team-bound', 'blocked-worker');
    expect(memberLifecycleSource.attachedMemberName).toBe('live-worker');
    expect(memberLifecycleSource.attachedReason).toBe('member_added');
    expect(memberLifecycleSource.detachedMemberName).toBe('stale-worker');
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

  it('binds messaging and relay methods to the source object', async () => {
    interface MessagingSource extends TeamMessagingApi {
      readonly teamName: string;
      sentMessage: { teamName: string; message: string } | null;
      leadRelayTeamName: string | null;
      liveMessages: InboxMessage[];
    }

    const source: MessagingSource = {
      teamName: 'team-bound',
      sentMessage: null,
      leadRelayTeamName: null,
      liveMessages: [],
      sendMessageToTeam(this: MessagingSource, teamName: string, message: string): Promise<void> {
        this.sentMessage = { teamName, message };
        return Promise.resolve();
      },
      relayOpenCodeMemberInboxMessages(
        this: MessagingSource,
        _teamName: string,
        memberName: string,
        options?: TeamOpenCodeMemberInboxRelayOptions
      ) {
        const diagnostics = options?.onlyMessageId ? [`message:${options.onlyMessageId}`] : null;
        return Promise.resolve({
          relayed: 1,
          attempted: 1,
          delivered: 1,
          failed: 0,
          ...(diagnostics ? { diagnostics } : {}),
          lastDelivery: {
            delivered: true,
            accepted: true,
            responseState: 'responded_visible_message',
            ledgerStatus: 'responded',
            laneId: `${this.teamName}:${memberName}`,
          },
        });
      },
      relayLeadInboxMessages(this: MessagingSource, teamName: string): Promise<number> {
        this.leadRelayTeamName = teamName;
        return Promise.resolve(2);
      },
      getOpenCodeRuntimeDeliveryStatus(_teamName: string, messageId: string) {
        return Promise.resolve({
          providerId: 'opencode',
          attempted: true,
          delivered: true,
          accepted: true,
          messageId,
        });
      },
      resolveRuntimeRecipientProviderId(): Promise<'opencode'> {
        return Promise.resolve('opencode');
      },
      getLiveLeadProcessMessages(this: MessagingSource): InboxMessage[] {
        return this.liveMessages;
      },
      getCurrentLeadSessionId(this: MessagingSource): string {
        return `session:${this.teamName}`;
      },
      pushLiveLeadProcessMessage(this: MessagingSource, _teamName: string, message: InboxMessage) {
        this.liveMessages.push(message);
      },
    };

    const api = bindTeamMessagingApi(source);
    const sendMessageToTeam = api.sendMessageToTeam.bind(undefined);
    const relayOpenCodeMemberInboxMessages = api.relayOpenCodeMemberInboxMessages.bind(undefined);
    const getOpenCodeRuntimeDeliveryStatus = api.getOpenCodeRuntimeDeliveryStatus.bind(undefined);
    const pushLiveLeadProcessMessage = api.pushLiveLeadProcessMessage.bind(undefined);

    await sendMessageToTeam('team-bound', 'hello lead');
    expect(source.sentMessage).toEqual({ teamName: 'team-bound', message: 'hello lead' });
    await expect(
      relayOpenCodeMemberInboxMessages('team-bound', 'worker', {
        onlyMessageId: 'message-1',
        source: 'ui-send',
        deliveryMetadata: { replyRecipient: 'user', actionMode: 'ask', taskRefs: [] },
      })
    ).resolves.toMatchObject({
      delivered: 1,
      diagnostics: ['message:message-1'],
      lastDelivery: {
        accepted: true,
        laneId: 'team-bound:worker',
      },
    });
    await expect(api.relayLeadInboxMessages('team-bound')).resolves.toBe(2);
    expect(source.leadRelayTeamName).toBe('team-bound');
    await expect(
      getOpenCodeRuntimeDeliveryStatus('team-bound', 'message-1')
    ).resolves.toMatchObject({
      providerId: 'opencode',
      messageId: 'message-1',
    });
    await expect(api.resolveRuntimeRecipientProviderId('team-bound', 'worker')).resolves.toBe(
      'opencode'
    );

    pushLiveLeadProcessMessage('team-bound', {
      from: 'user',
      to: 'lead',
      text: 'visible',
      timestamp: '2026-01-01T00:00:00.000Z',
      read: true,
    });
    expect(api.getCurrentLeadSessionId('team-bound')).toBe('session:team-bound');
    expect(api.getLiveLeadProcessMessages('team-bound')).toHaveLength(1);
  });

  it('binds tool approval methods to the source object', async () => {
    interface ToolApprovalSource extends TeamToolApprovalApi {
      readonly sourceName: string;
      response: {
        teamName: string;
        runId: string;
        requestId: string;
        allow: boolean;
        message?: string;
        sourceName: string;
      } | null;
      settingsUpdate: {
        teamName: string;
        settings: ToolApprovalSettings;
        sourceName: string;
      } | null;
    }

    const settings: ToolApprovalSettings = {
      autoAllowAll: false,
      autoAllowFileEdits: true,
      autoAllowSafeBash: false,
      timeoutAction: 'deny',
      timeoutSeconds: 45,
    };
    const source: ToolApprovalSource = {
      sourceName: 'approval-source',
      response: null,
      settingsUpdate: null,
      respondToToolApproval(
        this: ToolApprovalSource,
        teamName: string,
        runId: string,
        requestId: string,
        allow: boolean,
        message?: string
      ): Promise<void> {
        this.response = {
          teamName,
          runId,
          requestId,
          allow,
          ...(message !== undefined ? { message } : {}),
          sourceName: this.sourceName,
        };
        return Promise.resolve();
      },
      updateToolApprovalSettings(
        this: ToolApprovalSource,
        teamName: string,
        nextSettings: ToolApprovalSettings
      ): void {
        this.settingsUpdate = {
          teamName,
          settings: nextSettings,
          sourceName: this.sourceName,
        };
      },
    };

    const api = bindTeamToolApprovalApi(source);
    const respondToToolApproval = api.respondToToolApproval.bind(undefined);
    const updateToolApprovalSettings = api.updateToolApprovalSettings.bind(undefined);

    await respondToToolApproval('team-bound', 'run-1', 'request-1', true, 'approved');
    updateToolApprovalSettings('team-bound', settings);

    expect(source.response).toEqual({
      teamName: 'team-bound',
      runId: 'run-1',
      requestId: 'request-1',
      allow: true,
      message: 'approved',
      sourceName: 'approval-source',
    });
    expect(source.settingsUpdate).toEqual({
      teamName: 'team-bound',
      settings,
      sourceName: 'approval-source',
    });
  });
});
