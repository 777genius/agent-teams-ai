import {
  bindTeamCrossTeamMessagingApi,
  bindTeamHttpHandlerApis,
  bindTeamIpcHandlerApis,
} from '@main/services/team/contracts/TeamProvisioningApis';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  TeamCrossTeamMessagingApi,
  TeamHttpHandlerApis,
  TeamIpcHandlerApis,
} from '@main/services/team/contracts/TeamProvisioningApis';

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

const TEST_TIMESTAMP = '2026-01-01T00:00:00.000Z';

interface TestSourceExtras {
  marker: string;
  extraServiceMethod: unknown;
}

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
    prepareForProvisioning: vi.fn(() => Promise.resolve({ ready: true, message: 'ready' })),
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
    relayInboxFileToLiveRecipient: vi.fn(() =>
      Promise.resolve({
        kind: 'native_lead' as const,
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
    respondToToolApproval: vi.fn(() => Promise.resolve()),
    updateToolApprovalSettings: vi.fn(),
  } satisfies Parameters<typeof bindTeamIpcHandlerApis>[0] &
    Parameters<typeof bindTeamHttpHandlerApis>[0] &
    TeamCrossTeamMessagingApi &
    TestSourceExtras;
}

describe('bindTeamHttpHandlerApis', () => {
  it('returns one complete aggregate with every nested HTTP facade required', () => {
    const api = bindTeamHttpHandlerApis(createSource());

    expectTypeOf<TeamHttpHandlerApis>().toEqualTypeOf<Required<TeamHttpHandlerApis>>();
    expect(sortedKeys(api)).toEqual([
      'provisioningStart',
      'provisioningStatus',
      'runtime',
      'runtimeControl',
      'taskActivity',
    ]);
  });
});

describe('bindTeamIpcHandlerApis', () => {
  it('groups TeamProvisioningService behind IPC-facing facade ports only', () => {
    const api = bindTeamIpcHandlerApis(createSource());

    expect(sortedKeys(api)).toEqual([
      'claudeLogs',
      'diagnostics',
      'memberLifecycle',
      'messaging',
      'preflight',
      'provisioningRun',
      'provisioningStart',
      'provisioningStatus',
      'runtime',
      'taskActivity',
      'toolApproval',
    ]);
    expect(sortedKeys(api.provisioningStart)).toEqual(['createTeam', 'launchTeam']);
    expect(sortedKeys(api.provisioningStatus)).toEqual(['getProvisioningStatus']);
    expect(sortedKeys(api.preflight)).toEqual(['getCliHelpOutput', 'prepareForProvisioning']);
    expect(sortedKeys(api.provisioningRun)).toEqual(['cancelProvisioning', 'hasProvisioningRun']);
    expect(sortedKeys(api.taskActivity)).toEqual([
      'repairStaleTaskActivityIntervalsBeforeSnapshot',
    ]);
    expect(sortedKeys(api.runtime)).toEqual([
      'getAliveTeams',
      'getCurrentRunId',
      'getRuntimeState',
      'isTeamAlive',
      'stopTeam',
    ]);
    expect(sortedKeys(api.memberLifecycle)).toEqual([
      'attachLiveRosterMember',
      'detachLiveRosterMember',
      'getMemberSpawnStatuses',
      'restartMember',
      'retryFailedOpenCodeSecondaryLanes',
      'skipMemberForLaunch',
    ]);
    expect(sortedKeys(api.diagnostics)).toEqual([
      'getLeadActivityState',
      'getLeadContextUsage',
      'getTeamAgentRuntimeSnapshot',
    ]);
    expect(sortedKeys(api.claudeLogs)).toEqual(['getClaudeLogs']);
    expect(sortedKeys(api.messaging)).toEqual([
      'getCurrentLeadSessionId',
      'getLiveLeadProcessMessages',
      'getOpenCodeRuntimeDeliveryStatus',
      'pushLiveLeadProcessMessage',
      'relayLeadInboxMessages',
      'relayOpenCodeMemberInboxMessages',
      'resolveRuntimeRecipientProviderId',
      'sendMessageToTeam',
    ]);
    expect(sortedKeys(api.toolApproval)).toEqual([
      'respondToToolApproval',
      'updateToolApprovalSettings',
    ]);
    expect((api as unknown as Record<string, unknown>).extraServiceMethod).toBeUndefined();
  });

  it('binds facade methods to the source service instance', async () => {
    const api = bindTeamIpcHandlerApis(createSource());
    const createTeam = api.provisioningStart.createTeam;
    const getProvisioningStatus = api.provisioningStatus.getProvisioningStatus;

    await expect(createTeam({} as never, () => undefined)).resolves.toEqual({
      runId: 'bound-run',
    });
    await expect(getProvisioningStatus('run-1')).resolves.toMatchObject({
      runId: 'run-1',
      state: 'spawning',
    });
  });

  it('rejects a sparse model index before dispatching through the IPC preflight facade', async () => {
    const source = createSource();
    const sparseModelIds: string[] = [];
    sparseModelIds.length = 1;
    const api: TeamIpcHandlerApis = bindTeamIpcHandlerApis(source);

    await expect(
      api.preflight.prepareForProvisioning(undefined, { modelIds: sparseModelIds })
    ).rejects.toThrow('TeamProvisioningPrepareOptions.modelIds must not contain missing indices');
    expect(source.prepareForProvisioning).not.toHaveBeenCalled();
  });
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
    await expect(relayInboxFileToLiveRecipient('to-team', 'team-lead')).resolves.toEqual({
      kind: 'native_lead',
      relayed: 0,
    });
    expect(source.relayInboxFileToLiveRecipient).toHaveBeenCalledWith('to-team', 'team-lead');
    await expect(relayLeadInboxMessages('to-team')).resolves.toBe(0);
  });
});
