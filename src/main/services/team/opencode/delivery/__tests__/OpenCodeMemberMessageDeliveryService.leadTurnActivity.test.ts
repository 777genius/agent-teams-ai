import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeLeadTurnActivityNotification,
  type OpenCodeMemberLaneIdentity,
  type OpenCodeMemberMessageDeliveryInput,
  type OpenCodeMemberMessageDeliveryServiceDependencies,
} from '../OpenCodeMemberMessageDeliveryPorts';
import { OpenCodeMemberMessageDeliveryService } from '../OpenCodeMemberMessageDeliveryService';
import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
} from '../OpenCodePromptDeliveryLedger';
import { OPENCODE_STALE_PENDING_POLICY_CONFIG } from '../OpenCodePromptDeliveryStalePendingPolicy';

import type { OpenCodeTeamRuntimeMessageResult } from '../../../runtime';

const PRIMARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'primary',
  laneKind: 'primary',
  laneOwnerProviderId: 'opencode',
};

const SECONDARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'secondary:opencode:muse',
  laneKind: 'secondary',
  laneOwnerProviderId: 'opencode',
};

function acceptedResult(memberName: string): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName,
    sessionId: 'session-1',
    runtimePromptMessageId: 'prompt-1',
    diagnostics: [],
  };
}

/** Read-commit gate that settles only once the runtime has accepted the prompt. */
const settleAfterAcceptance = (record?: OpenCodePromptDeliveryLedgerRecord | null): boolean =>
  record != null && record.status !== 'pending';

function createDeps(input: {
  ledgerDir: string;
  laneIdentity: OpenCodeMemberLaneIdentity;
  memberName: string;
  send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  readAllowed: (record?: OpenCodePromptDeliveryLedgerRecord | null) => boolean;
  notify: ReturnType<typeof vi.fn>;
}): OpenCodeMemberMessageDeliveryServiceDependencies {
  const ledger = createOpenCodePromptDeliveryLedgerStore({
    filePath: join(input.ledgerDir, `${input.laneIdentity.laneId.replace(/:/g, '_')}.json`),
  });
  const passthroughProof = vi.fn(async ({ ledgerRecord }: { ledgerRecord: unknown }) => ({
    ledgerRecord,
    visibleReply: null,
  }));
  return {
    getOpenCodeRuntimeMessageAdapter: vi.fn(
      () => ({ sendMessageToMember: vi.fn(async () => await input.send()) }) as never
    ),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: { name: 'team-a', projectPath: '/repo', members: [] } as never,
      teamMeta: null,
      metaMembers: [{ name: input.memberName, providerId: 'opencode' as const }],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: true as const,
      canonicalMemberName: input.memberName,
      laneId: input.laneIdentity.laneId,
      laneIdentity: input.laneIdentity,
      metaMember: { name: input.memberName, providerId: 'opencode' as const },
      memberRuntimeCwd: '/repo',
    })),
    stoppingSecondaryRuntimeTeams: { has: () => false },
    readPersistedTeamProjectPath: vi.fn(() => '/repo'),
    resolveDeliverableTrackedRuntimeRunId: vi.fn(() => 'run-1'),
    runs: { get: vi.fn(() => ({ mixedSecondaryLanes: [] })) },
    getCurrentOpenCodeRuntimeRunId: vi.fn(() => 'runtime-run-1'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'runtime-run-1'),
    isOpenCodeRuntimeLaneIndexActive: vi.fn(async () => true),
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(async () => false),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: vi.fn(async () => false),
    deleteSecondaryRuntimeRun: vi.fn(),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    findDeliverableOpenCodeRuntimeBootstrapSessionEvidence: vi.fn(
      async () => ({ appMcpTransportHash: 'hash' }) as never
    ),
    getOpenCodeAppMcpTransportMismatchDiagnostic: vi.fn(() => null),
    stampOpenCodeAppMcpTransportEvidenceIfMissing: vi.fn(async () => undefined),
    resolveControlApiBaseUrl: vi.fn(async () => null),
    sendOpenCodeMemberMessageToRuntimeSerialized: vi.fn(
      async ({ send }: { send: () => Promise<OpenCodeTeamRuntimeMessageResult> }) => await send()
    ),
    rememberOpenCodeRuntimePidFromBridge: vi.fn(async () => undefined),
    maybeSyncOpenCodeRuntimePermissionsAfterDelivery: vi.fn(async () => undefined),
    isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: vi.fn(async () => true),
    createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
    openCodeVisibleReplyProofService: {
      applyDestinationProof: passthroughProof as never,
      materializePlainTextReplyIfNeeded: passthroughProof as never,
      findByRelayOfMessageId: vi.fn(async () => null),
    },
    openCodePromptDeliveryWatchdogScheduler: { isEnabled: () => true },
    openCodePromptDeliveryFollowUpPolicy: {
      schedule: vi.fn(
        async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) =>
          ledgerRecord
      ),
    },
    openCodeStalePendingPolicyConfig: OPENCODE_STALE_PENDING_POLICY_CONFIG,
    isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null }) =>
        input.readAllowed(ledgerRecord)
    ),
    getOpenCodeDeliveryPendingReason: vi.fn(() => 'opencode_delivery_response_pending'),
    markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
    logOpenCodePromptDeliveryEvent: vi.fn(),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    emitOpenCodePromptDeliveryTaskLogChange: vi.fn(),
    notifyOpenCodeLeadTurnActivity: input.notify as never,
    observeOpenCodeDirectUserDeliveryInlineIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ({
        ledgerRecord,
        visibleReply: null,
      })
    ),
  };
}

function states(notify: ReturnType<typeof vi.fn>): OpenCodeLeadTurnActivityNotification['state'][] {
  return notify.mock.calls.map(([call]) => (call as OpenCodeLeadTurnActivityNotification).state);
}

const leadMessage: OpenCodeMemberMessageDeliveryInput = {
  memberName: 'team-lead',
  text: 'plan the sprint',
  messageId: 'user-1',
  messageKind: 'default',
  source: 'ui-send',
};

describe('OpenCodeMemberMessageDeliveryService lead turn activity', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'opencode-lead-turn-activity-'));
  });

  afterEach(async () => {
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it("emits 'active' on acceptance and 'idle' once the primary-lane response is read-committable", async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => acceptedResult('team-lead'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', leadMessage);

    expect(delivery.accepted).toBe(true);
    expect(delivery.responsePending).toBe(false);
    expect(states(notify)).toEqual(['active', 'idle']);
    expect(notify).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'team-lead',
      laneId: 'primary',
      runId: 'run-1',
      state: 'active',
    });
  });

  it("keeps the lead 'active' while an accepted primary-lane turn is still pending", async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => acceptedResult('team-lead'),
        readAllowed: () => false,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', leadMessage);

    expect(delivery.accepted).toBe(true);
    expect(delivery.responsePending).toBe(true);
    expect(states(notify)).toEqual(['active']);
  });

  it("emits 'idle' when the primary-lane send throws", async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => {
          throw new Error('bridge down');
        },
        readAllowed: () => false,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', leadMessage);

    expect(delivery.delivered).toBe(false);
    expect(states(notify)).toEqual(['idle']);
  });

  it('never reports lead activity for a secondary lane', async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: SECONDARY_LANE,
        memberName: 'Muse',
        send: async () => acceptedResult('Muse'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', { ...leadMessage, memberName: 'Muse' });

    expect(delivery.accepted).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('never reports lead activity for a same-model primary teammate', async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'Muse',
        send: async () => acceptedResult('Muse'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', { ...leadMessage, memberName: 'Muse' });

    expect(delivery.accepted).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('swallows notification failures without affecting the delivery result', async () => {
    const notify = vi.fn(() => {
      throw new Error('renderer gone');
    });
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => acceptedResult('team-lead'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    try {
      const delivery = await service.deliver('team-a', leadMessage);

      expect(delivery.accepted).toBe(true);
      expect(delivery.responsePending).toBe(false);
      expect(states(notify)).toEqual(['active', 'idle']);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Service:OpenCodeMemberMessageDelivery]',
        expect.stringContaining('lead turn activity (active) notification failed: renderer gone')
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
