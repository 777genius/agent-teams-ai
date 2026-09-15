import {
  applyOpenCodeWorkSyncLaneControl,
  bindOpenCodeWorkSyncLaneReservationRoot,
  reserveOpenCodeWorkSyncLane,
  resetOpenCodeWorkSyncLaneReservationsForTests,
} from '@features/member-work-sync/main/adapters/output/OpenCodeWorkSyncLaneReservationStore';
import {
  type OpenCodeMemberLaneIdentity,
  type OpenCodeMemberMessageDeliveryServiceDependencies,
} from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import { OpenCodeMemberMessageDeliveryService } from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryService';
import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { OPENCODE_STALE_PENDING_POLICY_CONFIG } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryStalePendingPolicy';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenCodeTeamRuntimeMessageResult } from '@main/services/team/runtime/OpenCodeTeamRuntimeAdapter';

const TEAM = 'team-a';
const MEMBER = 'bob';
const PRIMARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'primary',
  laneKind: 'primary',
  laneOwnerProviderId: 'opencode',
};

const ticket = {
  teamName: TEAM,
  teamIncarnation: 'inc-1',
  memberName: MEMBER,
  runtimeInstanceId: 'opencode:primary:ses-1',
  expectedGeneration: 3,
  ticketId: 'ticket-1',
  intentId: 'intent-c1',
  controlRevision: 1,
  admissionPayloadHash: 'hash-a',
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function okSend(): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName: MEMBER,
    sessionId: 'ses-1',
    runtimePromptMessageId: 'msg_prompt',
    diagnostics: [],
  };
}

function createHarness(input: {
  ledgerDir: string;
  serialize: (
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>
  ) => Promise<OpenCodeTeamRuntimeMessageResult>;
  send?: () => Promise<OpenCodeTeamRuntimeMessageResult>;
}): {
  service: OpenCodeMemberMessageDeliveryService;
  ledger: OpenCodePromptDeliveryLedgerStore;
  send: ReturnType<typeof vi.fn>;
} {
  const ledger = createOpenCodePromptDeliveryLedgerStore({
    filePath: join(input.ledgerDir, 'primary.json'),
  });
  const send = vi.fn(async () => {
    if (!input.send) {
      throw new Error('send not expected');
    }
    return await input.send();
  });
  const passthroughProof = vi.fn(async ({ ledgerRecord }: { ledgerRecord: unknown }) => ({
    ledgerRecord,
    visibleReply: null,
  }));
  const deps: OpenCodeMemberMessageDeliveryServiceDependencies = {
    getOpenCodeRuntimeMessageAdapter: vi.fn(() => ({ sendMessageToMember: send }) as never),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: { name: TEAM, projectPath: input.ledgerDir, members: [] } as never,
      teamMeta: null,
      metaMembers: [{ name: MEMBER, providerId: 'opencode' as const }],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: true as const,
      canonicalMemberName: MEMBER,
      laneId: PRIMARY_LANE.laneId,
      laneIdentity: PRIMARY_LANE,
      metaMember: { name: MEMBER, providerId: 'opencode' as const },
      memberRuntimeCwd: input.ledgerDir,
    })),
    stoppingSecondaryRuntimeTeams: { has: () => false },
    readPersistedTeamProjectPath: vi.fn(() => input.ledgerDir),
    resolveDeliverableTrackedRuntimeRunId: vi.fn(() => 'run-1'),
    runs: { get: vi.fn(() => ({ mixedSecondaryLanes: [] })) },
    getCurrentOpenCodeRuntimeRunId: vi.fn(() => 'run-1'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
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
    sendOpenCodeMemberMessageToRuntimeSerialized: vi.fn(async ({ send: run }) =>
      input.serialize(run)
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
    isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async () => false),
    getOpenCodeDeliveryPendingReason: vi.fn(() => 'assistant_response_pending'),
    markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
    logOpenCodePromptDeliveryEvent: vi.fn(),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    emitOpenCodePromptDeliveryTaskLogChange: vi.fn(),
    observeOpenCodeDirectUserDeliveryInlineIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ({
        ledgerRecord,
        visibleReply: null,
      })
    ),
  };
  return {
    service: new OpenCodeMemberMessageDeliveryService(deps),
    ledger,
    send,
  };
}

describe('OpenCodeMemberMessageDeliveryService work-sync admission', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'opencode-work-sync-admit-'));
    bindOpenCodeWorkSyncLaneReservationRoot(ledgerDir);
  });

  afterEach(async () => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it('terminals a never-sent C1 after Stop and lets the next user DM send', async () => {
    expect(reserveOpenCodeWorkSyncLane(ticket)).toEqual({ ok: true });
    const entered = deferred();
    const hold = deferred();
    const harness = createHarness({
      ledgerDir,
      serialize: async (run) => {
        entered.resolve();
        await hold.promise;
        return await run();
      },
      send: async () => okSend(),
    });

    const blocked = harness.service.deliver(TEAM, {
      memberName: MEMBER,
      text: 'Continue assigned work.',
      messageId: 'c1-nudge',
      messageKind: 'member_work_sync_nudge',
      workSyncRuntimeTicketId: 'ticket-1',
      workSyncControlRevision: 1,
      source: 'watcher',
    });
    await entered.promise;
    const [pending] = await harness.ledger.list();
    expect(pending).toMatchObject({
      inboxMessageId: 'c1-nudge',
      status: 'pending',
      acceptedAt: null,
      attempts: 0,
    });
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: TEAM,
        memberName: MEMBER,
        runtimeInstanceId: ticket.runtimeInstanceId,
        controlRevision: 11,
        stopped: true,
      })
    ).toEqual({ ok: true, code: 'closed', controlRevision: 11 });
    hold.resolve();
    await expect(blocked).resolves.toMatchObject({
      delivered: false,
      reason: 'work_sync_admission_stopped',
    });
    expect(harness.send).not.toHaveBeenCalled();
    const [retired] = await harness.ledger.list();
    expect(retired).toMatchObject({
      inboxMessageId: 'c1-nudge',
      status: 'failed_terminal',
      lastReason: 'work_sync_admission_stopped',
    });

    const delivery = await harness.service.deliver(TEAM, {
      memberName: MEMBER,
      text: 'Please ship the fix.',
      messageId: 'user-dm',
      source: 'ui-send',
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(delivery).toMatchObject({
      delivered: true,
      accepted: true,
    });
    expect(delivery.queuedBehindMessageId).toBeUndefined();
  });
});
