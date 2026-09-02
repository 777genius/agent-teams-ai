import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeMemberLaneIdentity,
  type OpenCodeMemberMessageDeliveryInput,
  type OpenCodeMemberMessageDeliveryServiceDependencies,
} from '../OpenCodeMemberMessageDeliveryPorts';
import { OpenCodeMemberMessageDeliveryService } from '../OpenCodeMemberMessageDeliveryService';
import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';
import { OPENCODE_STALE_PENDING_POLICY_CONFIG } from '../OpenCodePromptDeliveryStalePendingPolicy';

import type {
  OpenCodeTeamRuntimeMessageInput,
  OpenCodeTeamRuntimeMessageResult,
} from '../../../runtime';

const PRIMARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'primary',
  laneKind: 'primary',
  laneOwnerProviderId: 'opencode',
};

const COALESCED_BLOCK = [
  '<opencode_coalesced_notices count="1">',
  '1 further informational notice(s) arrived after the message above.',
  '--- notice 1 (from Scribe, messageId notice-2) ---',
  'section 3 done',
  '</opencode_coalesced_notices>',
].join('\n');

const anchorMessage: OpenCodeMemberMessageDeliveryInput = {
  memberName: 'team-lead',
  text: 'section 2 done',
  messageId: 'notice-1',
  messageKind: 'default',
  replyRecipient: 'Scribe',
  source: 'watcher',
};

function acceptedResult(): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName: 'team-lead',
    sessionId: 'session-1',
    runtimePromptMessageId: 'prompt-1',
    diagnostics: [],
  };
}

function rejectedResult(): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: false,
    providerId: 'opencode',
    memberName: 'team-lead',
    diagnostics: ['opencode runtime is not active'],
  };
}

function createHarness(
  ledgerDir: string,
  runtimeResponse: () => OpenCodeTeamRuntimeMessageResult = acceptedResult
): {
  service: OpenCodeMemberMessageDeliveryService;
  ledger: OpenCodePromptDeliveryLedgerStore;
  sentTexts: () => string[];
} {
  const ledger = createOpenCodePromptDeliveryLedgerStore({
    filePath: join(ledgerDir, 'primary.json'),
  });
  const sendMessageToMember = vi.fn(async (_input: OpenCodeTeamRuntimeMessageInput) =>
    runtimeResponse()
  );
  const passthroughProof = vi.fn(async ({ ledgerRecord }: { ledgerRecord: unknown }) => ({
    ledgerRecord,
    visibleReply: null,
  }));
  const deps: OpenCodeMemberMessageDeliveryServiceDependencies = {
    getOpenCodeRuntimeMessageAdapter: vi.fn(() => ({ sendMessageToMember }) as never),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: { name: 'team-a', projectPath: '/repo', members: [] } as never,
      teamMeta: null,
      metaMembers: [{ name: 'team-lead', providerId: 'opencode' as const }],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: true as const,
      canonicalMemberName: 'team-lead',
      laneId: PRIMARY_LANE.laneId,
      laneIdentity: PRIMARY_LANE,
      metaMember: { name: 'team-lead', providerId: 'opencode' as const },
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
    // The response never settles, so the same inbox row can be delivered twice
    // against one ledger record - exactly the retry this test is about.
    isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async () => false),
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
    notifyOpenCodeLeadTurnActivity: vi.fn(),
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
    sentTexts: () => sendMessageToMember.mock.calls.map(([call]) => String(call.text ?? '')),
  };
}

async function readRecord(
  ledger: OpenCodePromptDeliveryLedgerStore,
  inboxMessageId: string
): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
  return await ledger.getByInboxMessage({
    teamName: 'team-a',
    memberName: 'team-lead',
    laneId: PRIMARY_LANE.laneId,
    inboxMessageId,
  });
}

describe('OpenCodeMemberMessageDeliveryService coalesced notices', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'opencode-coalesced-notices-'));
  });

  afterEach(async () => {
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it('appends the coalesced block to the dispatched prompt body', async () => {
    const harness = createHarness(ledgerDir);

    await harness.service.deliver('team-a', {
      ...anchorMessage,
      coalescedNoticeText: COALESCED_BLOCK,
    });

    const [sent] = harness.sentTexts();
    expect(sent).toContain('section 2 done');
    expect(sent).toContain('<opencode_coalesced_notices count="1">');
    expect(sent).toContain('section 3 done');
    // The anchor text stays first and the block is a separate paragraph.
    expect(sent?.indexOf('section 2 done')).toBeLessThan(
      sent?.indexOf('<opencode_coalesced_notices') ?? -1
    );
  });

  // Negative control 3: the ledger payload hash identifies the inbox row, not
  // the composed prompt. A retry after the riders were already read must not
  // look like a different payload, or the ledger fails the row terminally with
  // opencode_prompt_delivery_payload_mismatch and the row is never delivered.
  it('keeps the payload hash of an inbox row identical with and without coalescing', async () => {
    const harness = createHarness(ledgerDir);

    await harness.service.deliver('team-a', {
      ...anchorMessage,
      coalescedNoticeText: COALESCED_BLOCK,
    });
    const afterCoalescedAttempt = await readRecord(harness.ledger, 'notice-1');

    await harness.service.deliver('team-a', anchorMessage);
    const afterPlainRetry = await readRecord(harness.ledger, 'notice-1');

    expect(afterCoalescedAttempt?.payloadHash).toBeTruthy();
    expect(afterPlainRetry?.payloadHash).toBe(afterCoalescedAttempt?.payloadHash);
    expect(afterPlainRetry?.status).not.toBe('failed_terminal');
    expect(afterPlainRetry?.lastReason).not.toBe('opencode_prompt_delivery_payload_mismatch');
    expect(
      (afterPlainRetry?.diagnostics ?? []).some((diagnostic) =>
        diagnostic.includes('opencode_prompt_delivery_payload_mismatch')
      )
    ).toBe(false);
    // The first attempt really did carry the riders into the prompt.
    expect(harness.sentTexts()[0]).toContain('<opencode_coalesced_notices');
  });

  it('keeps the payload hash identical in the reverse order too', async () => {
    const harness = createHarness(ledgerDir);

    await harness.service.deliver('team-a', anchorMessage);
    const afterPlainAttempt = await readRecord(harness.ledger, 'notice-1');

    await harness.service.deliver('team-a', {
      ...anchorMessage,
      coalescedNoticeText: COALESCED_BLOCK,
    });
    const afterCoalescedRetry = await readRecord(harness.ledger, 'notice-1');

    expect(afterCoalescedRetry?.payloadHash).toBe(afterPlainAttempt?.payloadHash);
    expect(afterCoalescedRetry?.status).not.toBe('failed_terminal');
  });

  // The settlement rule: only the prompt that actually carried the riders may
  // settle them. Every other delivery outcome leaves them unread.
  it('proves dispatch when an accepted prompt carried the block', async () => {
    const harness = createHarness(ledgerDir);

    const delivery = await harness.service.deliver('team-a', {
      ...anchorMessage,
      coalescedNoticeText: COALESCED_BLOCK,
    });

    expect(delivery.accepted).toBe(true);
    expect(delivery.coalescedNoticesDelivered).toBe(true);
  });

  it('never proves dispatch for a delivery that carried no block', async () => {
    const harness = createHarness(ledgerDir);

    const delivery = await harness.service.deliver('team-a', anchorMessage);

    expect(delivery.accepted).toBe(true);
    expect(delivery.coalescedNoticesDelivered).toBeUndefined();
  });

  // `delivered: true` without dispatch: this call sent nothing, it only queued
  // behind the row that is still occupying the lane.
  it('withholds the dispatch proof from a delivery that only queued behind another row', async () => {
    const harness = createHarness(ledgerDir);

    await harness.service.deliver('team-a', anchorMessage);
    const queued = await harness.service.deliver('team-a', {
      ...anchorMessage,
      messageId: 'notice-3',
      coalescedNoticeText: COALESCED_BLOCK,
    });

    expect(queued.delivered).toBe(true);
    expect(queued.queuedBehindMessageId).toBe('notice-1');
    expect(queued.coalescedNoticesDelivered).toBeUndefined();
  });

  it('withholds the dispatch proof when the runtime did not accept the prompt', async () => {
    const harness = createHarness(ledgerDir, rejectedResult);

    const delivery = await harness.service.deliver('team-a', {
      ...anchorMessage,
      coalescedNoticeText: COALESCED_BLOCK,
    });

    expect(delivery.accepted).toBe(false);
    expect(delivery.coalescedNoticesDelivered).toBeUndefined();
  });

  it('withholds the dispatch proof when a blank block means nothing rode along', async () => {
    const harness = createHarness(ledgerDir);

    const delivery = await harness.service.deliver('team-a', {
      ...anchorMessage,
      coalescedNoticeText: '   ',
    });

    expect(delivery.accepted).toBe(true);
    expect(delivery.coalescedNoticesDelivered).toBeUndefined();
  });

  it('ignores a blank coalesced block entirely', async () => {
    const harness = createHarness(ledgerDir);

    await harness.service.deliver('team-a', { ...anchorMessage, coalescedNoticeText: '   ' });

    expect(harness.sentTexts()[0]).toBe('section 2 done');
  });
});
