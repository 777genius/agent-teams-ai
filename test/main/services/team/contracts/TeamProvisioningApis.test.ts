import {
  bindTeamApplicationDataApi,
  bindTeamApplicationProvisioningStartApi,
  bindTeamApplicationProvisioningStatusApi,
  bindTeamApplicationResumeApi,
  bindTeamApplicationRuntimeApi,
  bindTeamApplicationRuntimeIngressApi,
  bindTeamApplicationTaskActivityApi,
} from '@main/services/team/contracts/TeamApplicationCapabilityApiBinder';
import {
  bindTeamCrossTeamMessagingApi as bindTeamCrossTeamMessagingCapabilityApi,
  bindTeamMessagingApi as bindTeamMessagingCapabilityApi,
} from '@main/services/team/contracts/TeamMessagingApiBinder';
import {
  bindTeamClaudeLogsApi,
  bindTeamCrossTeamMessagingApi,
  bindTeamDiagnosticsApi,
  bindTeamHttpHandlerApis,
  bindTeamMemberLifecycleApi,
  bindTeamMessagingApi,
  bindTeamProvisioningPreflightApi,
  bindTeamProvisioningRunApi,
  bindTeamProvisioningStartApi,
  bindTeamProvisioningStatusApi,
  bindTeamRuntimeApi,
  bindTeamRuntimeControlCompatibilityApi,
  bindTeamTaskActivityRepairApi,
  bindTeamToolApprovalApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import {
  bindTeamDiagnosticsApi as bindTeamDiagnosticsCapabilityApi,
  bindTeamToolApprovalApi as bindTeamToolApprovalCapabilityApi,
} from '@main/services/team/contracts/TeamProvisioningCapabilityApiBinder';
import { bindTeamRuntimeControlCompatibilityApi as bindTeamRuntimeControlCapabilityApi } from '@main/services/team/contracts/TeamRuntimeApiBinder';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  TeamProvisioningRuntimeDeliveryApi,
  TeamProvisioningRuntimeSnapshotApi,
  TeamProvisioningToolApprovalApi,
} from '@features/team-provisioning/contracts';
import type {
  TeamApplicationDataApi,
  TeamApplicationProvisioningStartApi,
  TeamApplicationProvisioningStatusApi,
  TeamApplicationResumeApi,
  TeamApplicationRuntimeApi,
  TeamApplicationRuntimeIngressApi,
  TeamApplicationTaskActivityApi,
} from '@main/services/team/contracts/TeamApplicationCapabilityApis';
import type {
  TeamCrossTeamMessagingApi,
  TeamDiagnosticsApi,
  TeamHttpHandlerApis,
  TeamMessagingApi,
  TeamProvisioningPreflightApi,
  TeamRuntimeControlCompatibilityApi,
  TeamToolApprovalApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { ToolApprovalSettings } from '@shared/types';

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

const TEST_TIMESTAMP = '2026-01-01T00:00:00.000Z';

interface TestSourceExtras {
  marker: string;
  extraServiceMethod: unknown;
}

type ApplicationTestSource = TeamApplicationDataApi &
  TeamApplicationProvisioningStartApi &
  TeamApplicationProvisioningStatusApi &
  TeamApplicationResumeApi &
  TeamApplicationRuntimeApi &
  TeamApplicationRuntimeIngressApi &
  TeamApplicationTaskActivityApi &
  TestSourceExtras;

function createApplicationSource(): ApplicationTestSource {
  return {
    marker: 'application-owner',
    extraServiceMethod: vi.fn(),
    listTeams: vi.fn(() => Promise.resolve([])),
    getTeamData: vi.fn(() => Promise.resolve({} as never)),
    getSavedRequest: vi.fn(() => Promise.resolve(null)),
    createTeamConfig: vi.fn(() => Promise.resolve()),
    createTeam: vi.fn(function (this: ApplicationTestSource) {
      return Promise.resolve({ runId: this.marker });
    }),
    launchTeam: vi.fn(() => Promise.resolve({ runId: 'application-launch' })),
    getProvisioningStatus: vi.fn(() =>
      Promise.resolve({
        runId: 'application-run',
        teamName: 'application-team',
        state: 'ready' as const,
        message: 'ready',
        startedAt: TEST_TIMESTAMP,
        updatedAt: TEST_TIMESTAMP,
      })
    ),
    getRuntimeState: vi.fn((teamName: string) =>
      Promise.resolve({ teamName, isAlive: false, runId: null, progress: null })
    ),
    stopTeam: vi.fn(() => Promise.resolve()),
    getAliveTeams: vi.fn(() => []),
    recordRuntimeBootstrapCheckin: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        providerId: 'application-runtime',
        teamName: 'application-team',
        runId: 'application-run',
        state: 'accepted' as const,
        diagnostics: [],
        observedAt: TEST_TIMESTAMP,
      })
    ),
    deliverRuntimeMessage: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        providerId: 'application-runtime',
        teamName: 'application-team',
        runId: 'application-run',
        state: 'delivered' as const,
        diagnostics: [],
        observedAt: TEST_TIMESTAMP,
      })
    ),
    recordRuntimeTaskEvent: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        providerId: 'application-runtime',
        teamName: 'application-team',
        runId: 'application-run',
        state: 'recorded' as const,
        diagnostics: [],
        observedAt: TEST_TIMESTAMP,
      })
    ),
    recordRuntimeHeartbeat: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        providerId: 'application-runtime',
        teamName: 'application-team',
        runId: 'application-run',
        state: 'recorded' as const,
        diagnostics: [],
        observedAt: TEST_TIMESTAMP,
      })
    ),
    repairStaleTaskActivityIntervalsBeforeSnapshot: vi.fn(() => Promise.resolve()),
    resumeTeam: vi.fn(),
  };
}

type TestSource = Parameters<typeof bindTeamHttpHandlerApis>[0] &
  Parameters<typeof bindTeamClaudeLogsApi>[0] &
  Parameters<typeof bindTeamDiagnosticsApi>[0] &
  Parameters<typeof bindTeamMemberLifecycleApi>[0] &
  Parameters<typeof bindTeamMessagingApi>[0] &
  Parameters<typeof bindTeamProvisioningPreflightApi>[0] &
  Parameters<typeof bindTeamProvisioningRunApi>[0] &
  Parameters<typeof bindTeamRuntimeApi>[0] &
  Parameters<typeof bindTeamToolApprovalApi>[0] &
  TeamCrossTeamMessagingApi &
  TestSourceExtras;

function createSource() {
  return {
    marker: 'bound-run',
    extraServiceMethod: vi.fn(),
    createTeam: vi.fn(function (this: { marker: string }) {
      return Promise.resolve({ runId: this.marker });
    }),
    launchTeam: vi.fn(() => Promise.resolve({ runId: 'launch-run' })),
    getProvisioningStatus: vi.fn(() =>
      Promise.resolve({
        runId: 'run-1',
        teamName: 'team',
        state: 'spawning' as const,
        message: 'spawning',
        startedAt: TEST_TIMESTAMP,
        updatedAt: TEST_TIMESTAMP,
      })
    ),
    repairStaleTaskActivityIntervalsBeforeSnapshot: vi.fn(() => Promise.resolve()),
    getCliHelpOutput: vi.fn(() => Promise.resolve('Usage')),
    prepareForProvisioning: vi.fn<TeamProvisioningPreflightApi['prepareForProvisioning']>(() =>
      Promise.resolve({ ready: true, message: 'ready' })
    ),
    cancelProvisioning: vi.fn(() => Promise.resolve()),
    hasProvisioningRun: vi.fn(() => false),
    getRuntimeState: vi.fn(() =>
      Promise.resolve({
        teamName: 'team',
        isAlive: false,
        runId: null,
        progress: null,
      })
    ),
    stopTeam: vi.fn(() => Promise.resolve()),
    isTeamAlive: vi.fn(() => false),
    getAliveTeams: vi.fn(() => []),
    getCurrentRunId: vi.fn(() => null),
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(),
    deliverOpenCodeRuntimeMessage: vi.fn(),
    recordOpenCodeRuntimeTaskEvent: vi.fn(),
    recordOpenCodeRuntimeHeartbeat: vi.fn(),
    answerOpenCodeRuntimePermission: vi.fn(),
    getMemberSpawnStatuses: vi.fn(() =>
      Promise.resolve({ statuses: {}, runId: 'run-1', updatedAt: TEST_TIMESTAMP })
    ),
    runLiveRosterMutation: vi.fn(
      async (_teamName: string, mutation: () => Promise<void>): Promise<void> => mutation()
    ),
    attachLiveRosterMember: vi.fn(() => Promise.resolve()),
    detachLiveRosterMember: vi.fn(() => Promise.resolve()),
    restartMember: vi.fn(() => Promise.resolve()),
    retryFailedOpenCodeSecondaryLanes: vi.fn(() =>
      Promise.resolve({
        attempted: [],
        confirmed: [],
        pending: [],
        failed: [],
        skipped: [],
      })
    ),
    skipMemberForLaunch: vi.fn(() => Promise.resolve()),
    getLeadActivityState: vi.fn(() => ({ state: 'idle' as const, runId: 'run-1' })),
    getLeadContextUsage: vi.fn(() => ({ usage: null, runId: 'run-1' })),
    getTeamAgentRuntimeSnapshot: vi.fn(() =>
      Promise.resolve({
        teamName: 'team',
        members: {},
        runId: 'run-1',
        updatedAt: TEST_TIMESTAMP,
      })
    ),
    getClaudeLogs: vi.fn(() => Promise.resolve({ lines: [], total: 0, hasMore: false })),
    sendMessageToTeam: vi.fn(() => Promise.resolve()),
    relayOpenCodeMemberInboxMessages: vi.fn(() =>
      Promise.resolve({
        relayed: 0,
        attempted: 0,
        delivered: 0,
        failed: 0,
      })
    ),
    relayInboxFileToLiveRecipient: vi.fn<
      TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']
    >(() =>
      Promise.resolve({
        kind: 'native_lead',
        relayed: 0,
      })
    ),
    relayLeadInboxMessages: vi.fn(() => Promise.resolve(0)),
    getOpenCodeRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(null)),
    resolveRuntimeRecipientProviderId: vi.fn(() => Promise.resolve(undefined)),
    getLiveLeadProcessMessages: vi.fn(() => []),
    getCurrentLeadSessionId: vi.fn(() => null),
    pushLiveLeadProcessMessage: vi.fn(),
    resolveCrossTeamReplyMetadata: vi.fn(function (this: { marker: string }) {
      return {
        conversationId: `${this.marker}:conversation`,
        replyToConversationId: 'reply-conversation',
      };
    }),
    registerPendingCrossTeamReplyExpectation: vi.fn(),
    clearPendingCrossTeamReplyExpectation: vi.fn(),
    getPendingToolApprovalFilePath: vi.fn(() => null),
    getPendingToolApprovalFileTarget: vi.fn(() => null),
    respondToToolApproval: vi.fn(() => Promise.resolve()),
    updateToolApprovalSettings: vi.fn(),
  } satisfies TestSource;
}

describe('TeamApplication capability binders', () => {
  it('exposes exact provider-neutral application facets and preserves owner binding', async () => {
    const source = createApplicationSource();
    const data = bindTeamApplicationDataApi(source);
    const provisioningStart = bindTeamApplicationProvisioningStartApi(source);
    const provisioningStatus = bindTeamApplicationProvisioningStatusApi(source);
    const runtime = bindTeamApplicationRuntimeApi(source);
    const runtimeIngress = bindTeamApplicationRuntimeIngressApi(source);
    const taskActivity = bindTeamApplicationTaskActivityApi(source);
    const resume = bindTeamApplicationResumeApi(source);

    expect(sortedKeys(data)).toEqual([
      'createTeamConfig',
      'getSavedRequest',
      'getTeamData',
      'listTeams',
    ]);
    expect(sortedKeys(provisioningStart)).toEqual(['createTeam', 'launchTeam']);
    expect(sortedKeys(provisioningStatus)).toEqual(['getProvisioningStatus']);
    expect(sortedKeys(runtime)).toEqual(['getAliveTeams', 'getRuntimeState', 'stopTeam']);
    expect(sortedKeys(runtimeIngress)).toEqual([
      'deliverRuntimeMessage',
      'recordRuntimeBootstrapCheckin',
      'recordRuntimeHeartbeat',
      'recordRuntimeTaskEvent',
    ]);
    expect(sortedKeys(taskActivity)).toEqual(['repairStaleTaskActivityIntervalsBeforeSnapshot']);
    expect(sortedKeys(resume)).toEqual(['resumeTeam']);
    expect((data as unknown as Record<string, unknown>).extraServiceMethod).toBeUndefined();

    await expect(provisioningStart.createTeam({} as never, () => undefined)).resolves.toEqual({
      runId: 'application-owner',
    });
    await expect(runtimeIngress.deliverRuntimeMessage({})).resolves.toMatchObject({
      providerId: 'application-runtime',
      state: 'delivered',
    });
    expect(source.createTeam).toHaveBeenCalledOnce();
  });
});

describe('bindTeamHttpHandlerApis', () => {
  it('returns one complete aggregate with every nested HTTP facade required', () => {
    const api = bindTeamHttpHandlerApis(createSource());

    expectTypeOf<TeamHttpHandlerApis>().toEqualTypeOf<Required<TeamHttpHandlerApis>>();
    expect(sortedKeys(api)).toEqual([
      'provisioningStart',
      'provisioningStatus',
      'runtime',
      'runtimeIngress',
      'taskActivity',
    ]);
  });
});

describe('TeamProvisioningApis compatibility exports', () => {
  it('preserves legacy binder identities while narrow modules own implementations', () => {
    expect(bindTeamDiagnosticsApi).toBe(bindTeamDiagnosticsCapabilityApi);
    expect(bindTeamToolApprovalApi).toBe(bindTeamToolApprovalCapabilityApi);
    expect(bindTeamMessagingApi).toBe(bindTeamMessagingCapabilityApi);
    expect(bindTeamCrossTeamMessagingApi).toBe(bindTeamCrossTeamMessagingCapabilityApi);
    expect(bindTeamRuntimeControlCompatibilityApi).toBe(bindTeamRuntimeControlCapabilityApi);
  });
});

describe('narrow Desktop capability binders', () => {
  it('exposes only the methods owned by each capability', () => {
    const source = createSource();

    expect(sortedKeys(bindTeamProvisioningStartApi(source))).toEqual(['createTeam', 'launchTeam']);
    expect(sortedKeys(bindTeamProvisioningStatusApi(source))).toEqual(['getProvisioningStatus']);
    expect(sortedKeys(bindTeamProvisioningPreflightApi(source))).toEqual([
      'getCliHelpOutput',
      'prepareForProvisioning',
    ]);
    expect(sortedKeys(bindTeamProvisioningRunApi(source))).toEqual([
      'cancelProvisioning',
      'hasProvisioningRun',
    ]);
    expect(sortedKeys(bindTeamTaskActivityRepairApi(source))).toEqual([
      'repairStaleTaskActivityIntervalsBeforeSnapshot',
    ]);
    expect(sortedKeys(bindTeamRuntimeApi(source))).toEqual([
      'getAliveTeams',
      'getCurrentRunId',
      'getRuntimeState',
      'isTeamAlive',
      'stopTeam',
    ]);
    expect(sortedKeys(bindTeamMemberLifecycleApi(source))).toEqual([
      'attachLiveRosterMember',
      'detachLiveRosterMember',
      'getMemberSpawnStatuses',
      'restartMember',
      'retryFailedOpenCodeSecondaryLanes',
      'runLiveRosterMutation',
      'skipMemberForLaunch',
    ]);
    expect(sortedKeys(bindTeamDiagnosticsApi(source))).toEqual([
      'getLeadActivityState',
      'getLeadContextUsage',
      'getTeamAgentRuntimeSnapshot',
    ]);
    expect(sortedKeys(bindTeamClaudeLogsApi(source))).toEqual(['getClaudeLogs']);
    expect(sortedKeys(bindTeamMessagingApi(source))).toEqual([
      'getCurrentLeadSessionId',
      'getLiveLeadProcessMessages',
      'getOpenCodeRuntimeDeliveryStatus',
      'pushLiveLeadProcessMessage',
      'relayLeadInboxMessages',
      'relayOpenCodeMemberInboxMessages',
      'resolveRuntimeRecipientProviderId',
      'sendMessageToTeam',
    ]);
    expect(sortedKeys(bindTeamToolApprovalApi(source))).toEqual([
      'getPendingToolApprovalFilePath',
      'getPendingToolApprovalFileTarget',
      'respondToToolApproval',
      'updateToolApprovalSettings',
    ]);
  });

  it('binds facade methods to the source service instance', async () => {
    const source = createSource();
    const createTeam = bindTeamProvisioningStartApi(source).createTeam;
    const getProvisioningStatus = bindTeamProvisioningStatusApi(source).getProvisioningStatus;

    await expect(createTeam({} as never, () => undefined)).resolves.toEqual({
      runId: 'bound-run',
    });
    await expect(getProvisioningStatus('run-1')).resolves.toMatchObject({
      runId: 'run-1',
      state: 'spawning',
    });
  });

  it('keeps accepted feature contracts exact across narrow capabilities and HTTP', async () => {
    expectTypeOf<TeamDiagnosticsApi>().toMatchTypeOf<TeamProvisioningRuntimeSnapshotApi>();
    expectTypeOf<TeamToolApprovalApi>().toMatchTypeOf<TeamProvisioningToolApprovalApi>();
    expectTypeOf<TeamToolApprovalApi['getPendingToolApprovalFilePath']>().toEqualTypeOf<
      (teamName: string, runId: string, requestId: string) => string | null
    >();
    expectTypeOf<TeamToolApprovalApi['getPendingToolApprovalFileTarget']>().toEqualTypeOf<
      (
        teamName: string,
        runId: string,
        requestId: string
      ) => {
        authorizationGeneration: string;
        authorizationPath: string;
        readPath: string;
      } | null
    >();
    expectTypeOf<
      TeamRuntimeControlCompatibilityApi['deliverOpenCodeRuntimeMessage']
    >().toEqualTypeOf<TeamProvisioningRuntimeDeliveryApi['deliverOpenCodeRuntimeMessage']>();
    expectTypeOf<TeamMessagingApi['getOpenCodeRuntimeDeliveryStatus']>().toEqualTypeOf<
      TeamProvisioningRuntimeDeliveryApi['getOpenCodeRuntimeDeliveryStatus']
    >();

    const source = createSource();
    const snapshot = {
      teamName: 'team',
      members: {},
      runId: 'run-1',
      updatedAt: TEST_TIMESTAMP,
    };
    const snapshotPromise = Promise.resolve(snapshot);
    const approvalPromise = Promise.resolve();
    const deliveryAck = {
      ok: true,
      providerId: 'opencode' as const,
      teamName: 'team',
      runId: 'run-1',
      state: 'delivered' as const,
      diagnostics: [],
      observedAt: TEST_TIMESTAMP,
    };
    const deliveryPromise = Promise.resolve(deliveryAck);
    const statusPromise = Promise.resolve(null);
    const settings = {} as ToolApprovalSettings;
    source.getTeamAgentRuntimeSnapshot.mockReturnValueOnce(snapshotPromise);
    source.respondToToolApproval.mockReturnValueOnce(approvalPromise);
    source.deliverOpenCodeRuntimeMessage.mockReturnValueOnce(deliveryPromise);
    source.getOpenCodeRuntimeDeliveryStatus.mockReturnValueOnce(statusPromise);
    const diagnostics = bindTeamDiagnosticsApi(source);
    const toolApproval = bindTeamToolApprovalApi(source);
    const runtimeControl = bindTeamRuntimeControlCompatibilityApi(source);
    const messaging = bindTeamMessagingApi(source);

    const snapshotResult = diagnostics.getTeamAgentRuntimeSnapshot('team');
    const approvalResult = toolApproval.respondToToolApproval('team', 'run-1', 'request-1', true);
    const deliveryResult = runtimeControl.deliverOpenCodeRuntimeMessage({});
    const statusResult = messaging.getOpenCodeRuntimeDeliveryStatus('team', 'message-1');
    const settingsResult = toolApproval.updateToolApprovalSettings('team', settings);

    expect(snapshotResult).toBe(snapshotPromise);
    expect(approvalResult).toBe(approvalPromise);
    expect(deliveryResult).toBe(deliveryPromise);
    expect(statusResult).toBe(statusPromise);
    expect(settingsResult).toBeUndefined();
    expect(source.updateToolApprovalSettings).toHaveBeenCalledWith('team', settings);
    await expect(snapshotResult).resolves.toBe(snapshot);
    await expect(approvalResult).resolves.toBeUndefined();
    await expect(deliveryResult).resolves.toBe(deliveryAck);
    await expect(statusResult).resolves.toBeNull();

    const settingsFailure = new Error('settings update failed');
    source.updateToolApprovalSettings.mockImplementationOnce(() => {
      throw settingsFailure;
    });
    expect(() => toolApproval.updateToolApprovalSettings('team', settings)).toThrow(
      settingsFailure
    );
  });

  it('forwards dense model indexes through the IPC preflight facade', async () => {
    const source = createSource();
    const api = bindTeamProvisioningPreflightApi(source);
    const options = {
      modelIds: ['gpt-5.4'],
      modelChecks: [{ providerId: 'codex' as const, model: 'gpt-5.4', effort: 'medium' as const }],
    };

    await expect(api.prepareForProvisioning('/workspace/team', options)).resolves.toEqual({
      ready: true,
      message: 'ready',
    });
    expect(source.prepareForProvisioning).toHaveBeenCalledWith('/workspace/team', options);
  });

  it('rejects a sparse model index before dispatching through the IPC preflight facade', async () => {
    const source = createSource();
    const sparseModelIds: string[] = [];
    sparseModelIds.length = 1;
    const api = bindTeamProvisioningPreflightApi(source);

    await expect(
      api.prepareForProvisioning(undefined, { modelIds: sparseModelIds })
    ).rejects.toThrow('TeamProvisioningPrepareOptions.modelIds must not contain missing indices');
    expect(source.prepareForProvisioning).not.toHaveBeenCalled();
  });

  it('rejects an explicitly undefined model-check index through the IPC preflight facade', async () => {
    const source = createSource();
    const modelChecks = [undefined] as unknown as NonNullable<
      Parameters<TeamProvisioningPreflightApi['prepareForProvisioning']>[1]
    >['modelChecks'];
    const api = bindTeamProvisioningPreflightApi(source);

    await expect(api.prepareForProvisioning(undefined, { modelChecks })).rejects.toThrow(
      'TeamProvisioningPrepareOptions.modelChecks must not contain missing indices'
    );
    expect(source.prepareForProvisioning).not.toHaveBeenCalled();
  });

  it.each([
    ['modelIds', null],
    ['modelChecks', { length: 0 }],
  ] as const)(
    'rejects a non-array %s value before dispatching through the IPC preflight facade',
    async (field, value) => {
      const source = createSource();
      const api = bindTeamProvisioningPreflightApi(source);
      const options = { [field]: value } as unknown as NonNullable<
        Parameters<TeamProvisioningPreflightApi['prepareForProvisioning']>[1]
      >;

      await expect(api.prepareForProvisioning(undefined, options)).rejects.toThrow(
        `TeamProvisioningPrepareOptions.${field} must be an array when provided`
      );
      expect(source.prepareForProvisioning).not.toHaveBeenCalled();
    }
  );
});

describe('bindTeamCrossTeamMessagingApi', () => {
  it('preserves the closed live-inbox relay kind union', () => {
    type RelayResult = Awaited<
      ReturnType<TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']>
    >;

    expectTypeOf<RelayResult['kind']>().toEqualTypeOf<
      'ignored' | 'native_lead' | 'native_member_noop' | 'opencode_member'
    >();
  });

  it('exposes only cross-team relay methods and binds them to the source service', async () => {
    const source = createSource();
    const api = bindTeamCrossTeamMessagingApi(source);
    const resolveCrossTeamReplyMetadata = api.resolveCrossTeamReplyMetadata;
    const relayInboxFileToLiveRecipient = api.relayInboxFileToLiveRecipient;
    const relayLeadInboxMessages = api.relayLeadInboxMessages;

    source.relayInboxFileToLiveRecipient.mockResolvedValueOnce({
      kind: 'opencode_member',
      relayed: 1,
      lastDelivery: { delivered: true },
    });

    expect(sortedKeys(api)).toEqual([
      'clearPendingCrossTeamReplyExpectation',
      'isTeamAlive',
      'registerPendingCrossTeamReplyExpectation',
      'relayInboxFileToLiveRecipient',
      'relayLeadInboxMessages',
      'resolveCrossTeamReplyMetadata',
    ]);
    expect((api as unknown as Record<string, unknown>).createTeam).toBeUndefined();
    expect((api as unknown as Record<string, unknown>).sendMessageToTeam).toBeUndefined();
    expect(resolveCrossTeamReplyMetadata('from-team', 'to-team')).toEqual({
      conversationId: 'bound-run:conversation',
      replyToConversationId: 'reply-conversation',
    });

    api.registerPendingCrossTeamReplyExpectation('from-team', 'to-team', 'conversation-1');
    api.clearPendingCrossTeamReplyExpectation('from-team', 'to-team', 'conversation-1');
    expect(source.registerPendingCrossTeamReplyExpectation).toHaveBeenCalledWith(
      'from-team',
      'to-team',
      'conversation-1'
    );
    expect(source.clearPendingCrossTeamReplyExpectation).toHaveBeenCalledWith(
      'from-team',
      'to-team',
      'conversation-1'
    );
    await expect(
      relayInboxFileToLiveRecipient('to-team', 'worker', { onlyMessageId: 'message-1' })
    ).resolves.toEqual({
      kind: 'opencode_member',
      relayed: 1,
      lastDelivery: { delivered: true },
    });
    expect(source.relayInboxFileToLiveRecipient).toHaveBeenCalledWith('to-team', 'worker', {
      onlyMessageId: 'message-1',
    });
    await expect(relayInboxFileToLiveRecipient('to-team', 'team-lead')).resolves.toEqual({
      kind: 'native_lead',
      relayed: 0,
    });
    expect(source.relayInboxFileToLiveRecipient).toHaveBeenCalledWith('to-team', 'team-lead');
    await expect(relayLeadInboxMessages('to-team')).resolves.toBe(0);
  });
});
