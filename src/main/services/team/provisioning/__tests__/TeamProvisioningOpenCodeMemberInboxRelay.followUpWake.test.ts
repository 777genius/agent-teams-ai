import { describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeMemberInboxRelayResult,
  type RelayOpenCodeMemberInboxMessagesPorts,
  relayOpenCodeMemberInboxMessagesWithPorts,
} from '../TeamProvisioningOpenCodeMemberInboxRelay';

import type { OpenCodePromptDeliveryLedgerRecord } from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { RelayInboxMessage } from '../TeamProvisioningInboxRelayPolicy';

const NOW_ISO = '2026-01-01T00:00:00.000Z';

function message(overrides: Partial<RelayInboxMessage> = {}): RelayInboxMessage {
  return {
    from: 'user',
    to: 'worker',
    text: 'please check this',
    timestamp: NOW_ISO,
    read: false,
    messageId: 'message-1',
    ...overrides,
  };
}

function ledgerRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'record-1',
    teamName: 'team',
    memberName: 'worker',
    laneId: 'lane-worker',
    runId: 'run-1',
    inboxMessageId: 'message-1',
    inboxTimestamp: NOW_ISO,
    source: 'watcher',
    replyRecipient: 'user',
    actionMode: null,
    messageKind: null,
    workSyncIntent: null,
    taskRefs: [],
    payloadHash: 'sha256:payload',
    status: 'pending',
    attempts: 0,
    diagnostics: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  } as OpenCodePromptDeliveryLedgerRecord;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createRelayPorts(
  overrides: Partial<RelayOpenCodeMemberInboxMessagesPorts> = {}
): RelayOpenCodeMemberInboxMessagesPorts {
  return {
    inFlight: new Map(),
    readInboxMessages: vi.fn().mockResolvedValue([]),
    scheduleOpenCodeMemberInboxDeliveryWake: vi.fn(),
    isOpenCodeRuntimeRecipient: vi.fn().mockResolvedValue(true),
    resolveOpenCodeMemberDeliveryIdentity: vi.fn().mockResolvedValue({
      ok: true,
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      laneIdentity: { laneId: 'lane-worker', laneKind: 'secondary' },
    }),
    createOpenCodePromptDeliveryLedger: vi.fn(() => ({
      getByInboxMessage: vi.fn().mockResolvedValue(null),
    })) as unknown as RelayOpenCodeMemberInboxMessagesPorts['createOpenCodePromptDeliveryLedger'],
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi
      .fn()
      .mockImplementation(({ ledgerRecord: record }) => Promise.resolve(record)),
    requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: vi
      .fn()
      .mockImplementation(({ ledgerRecord: record }) => Promise.resolve(record)),
    applyDestinationProof: vi.fn().mockRejectedValue(new Error('unused')),
    isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn().mockResolvedValue(false),
    markInboxMessagesRead: vi.fn().mockResolvedValue(undefined),
    logOpenCodePromptDeliveryEvent: vi.fn(),
    readTaskRefInferenceTasks: vi.fn().mockResolvedValue([]),
    resolveOpenCodeInboxAttachmentPayloads: vi.fn().mockResolvedValue({
      ok: true,
      attachments: [],
    }),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn().mockResolvedValue('run-1'),
    markOpenCodePromptLedgerFailedTerminal: vi.fn(),
    deliverOpenCodeMemberMessage: vi.fn().mockResolvedValue({ delivered: true }),
    suppressRuntimeInactiveWarning: vi.fn().mockReturnValue(false),
    logWarning: vi.fn(),
    nowIso: () => NOW_ISO,
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };
}

/**
 * A pass delivers at most one message and the design assumed the committed
 * anchor's inbox write re-fires the file watcher for whatever queued behind it.
 * "Usually" is not a trigger: a row left unexamined with no wake and no later
 * inbox write stays unread forever (run 12 lost bob's peer challenge exactly
 * this way). Every pass must arm the next pass for the rows it did not touch.
 */
describe('TeamProvisioningOpenCodeMemberInboxRelay follow-up wake', () => {
  it('arms a delivery wake for an unread row left behind after a one-message pass', async () => {
    const ports = createRelayPorts({
      readInboxMessages: vi
        .fn()
        .mockResolvedValue([
          message({ messageId: 'row-a', timestamp: '2026-01-01T00:00:00.000Z' }),
          message({ messageId: 'row-b', from: 'alice', timestamp: '2026-01-01T00:00:01.000Z' }),
        ]),
    });

    await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      ports
    );

    expect(ports.deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
    expect(ports.deliverOpenCodeMemberMessage).toHaveBeenCalledWith(
      'team',
      expect.objectContaining({ messageId: 'row-a' })
    );
    expect(ports.scheduleOpenCodeMemberInboxDeliveryWake).toHaveBeenCalledTimes(1);
    const wake = vi.mocked(ports.scheduleOpenCodeMemberInboxDeliveryWake).mock.calls[0][0];
    expect(wake).toMatchObject({ teamName: 'team', memberName: 'worker', messageId: 'row-b' });
    expect(wake.isCurrent).toBeUndefined();
  });

  it('arms a delivery wake for the queue left behind when the walk breaks on a pending delivery', async () => {
    const ports = createRelayPorts({
      readInboxMessages: vi
        .fn()
        .mockResolvedValue([
          message({ messageId: 'row-a', timestamp: '2026-01-01T00:00:00.000Z' }),
          message({ messageId: 'row-b', from: 'alice', timestamp: '2026-01-01T00:00:01.000Z' }),
        ]),
      deliverOpenCodeMemberMessage: vi.fn().mockResolvedValue({
        delivered: true,
        accepted: false,
        responsePending: true,
        reason: 'opencode_delivery_response_pending',
      }),
    });

    await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      ports
    );

    expect(ports.deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
    expect(ports.scheduleOpenCodeMemberInboxDeliveryWake).toHaveBeenCalledTimes(1);
    const wake = vi.mocked(ports.scheduleOpenCodeMemberInboxDeliveryWake).mock.calls[0][0];
    expect(wake).toMatchObject({ messageId: 'row-b' });
    expect(wake.isCurrent).toBeUndefined();
  });

  it('does not arm a follow-up wake when the pass consumed every eligible row', async () => {
    const ports = createRelayPorts({
      readInboxMessages: vi.fn().mockResolvedValue([message({ messageId: 'row-a' })]),
    });

    await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      ports
    );

    expect(ports.deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
    expect(ports.scheduleOpenCodeMemberInboxDeliveryWake).not.toHaveBeenCalled();
  });

  it('arms a delivery wake for rows behind the scoped wake target', async () => {
    const ports = createRelayPorts({
      readInboxMessages: vi
        .fn()
        .mockResolvedValue([
          message({ messageId: 'row-a', timestamp: '2026-01-01T00:00:00.000Z' }),
          message({ messageId: 'row-b', from: 'alice', timestamp: '2026-01-01T00:00:01.000Z' }),
        ]),
    });

    await relayOpenCodeMemberInboxMessagesWithPorts(
      {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
        options: { onlyMessageId: 'row-a', source: 'watchdog', isCurrent: () => true },
      },
      ports
    );

    expect(ports.deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
    expect(ports.deliverOpenCodeMemberMessage).toHaveBeenCalledWith(
      'team',
      expect.objectContaining({ messageId: 'row-a' })
    );
    expect(ports.scheduleOpenCodeMemberInboxDeliveryWake).toHaveBeenCalledTimes(1);
    const wake = vi.mocked(ports.scheduleOpenCodeMemberInboxDeliveryWake).mock.calls[0][0];
    expect(wake).toMatchObject({ messageId: 'row-b' });
    expect(wake.isCurrent).toBeUndefined();
  });

  it('does not re-arm a wake for a row whose delivery record already exists', async () => {
    const existing = ledgerRecord({ inboxMessageId: 'row-b' });
    const ports = createRelayPorts({
      readInboxMessages: vi
        .fn()
        .mockResolvedValue([
          message({ messageId: 'row-a', timestamp: '2026-01-01T00:00:00.000Z' }),
          message({ messageId: 'row-b', from: 'alice', timestamp: '2026-01-01T00:00:01.000Z' }),
        ]),
      createOpenCodePromptDeliveryLedger: vi.fn(() => ({
        getByInboxMessage: vi.fn(async ({ inboxMessageId }: { inboxMessageId: string }) =>
          inboxMessageId === 'row-b' ? existing : null
        ),
        ensurePending: vi.fn().mockResolvedValue(existing),
      })) as unknown as RelayOpenCodeMemberInboxMessagesPorts['createOpenCodePromptDeliveryLedger'],
      deliverOpenCodeMemberMessage: vi
        .fn()
        .mockResolvedValue({ delivered: true, accepted: true, responsePending: true }),
    });

    await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      ports
    );

    expect(ports.scheduleOpenCodeMemberInboxDeliveryWake).not.toHaveBeenCalled();
  });
});

describe('TeamProvisioningOpenCodeMemberInboxRelay coalesced full relay follow-up', () => {
  it('arms a delivery wake when a full request coalesces into an in-flight walk and unread rows remain', async () => {
    const existing = deferred<OpenCodeMemberInboxRelayResult>();
    const ports = createRelayPorts({
      readInboxMessages: vi
        .fn()
        .mockResolvedValue([message({ messageId: 'row-late', from: 'alice' })]),
    });
    ports.inFlight.set('team/worker', existing.promise);

    const coalesced = relayOpenCodeMemberInboxMessagesWithPorts(
      {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
        options: { isCurrent: () => true },
      },
      ports
    );
    existing.resolve({ attempted: 0, delivered: 0, relayed: 0, failed: 0 });
    await coalesced;

    expect(ports.scheduleOpenCodeMemberInboxDeliveryWake).toHaveBeenCalledTimes(1);
    const wake = vi.mocked(ports.scheduleOpenCodeMemberInboxDeliveryWake).mock.calls[0][0];
    expect(wake).toMatchObject({ messageId: 'row-late' });
    expect(wake.isCurrent).toBeUndefined();
  });
});

/**
 * Wakes are what chain: every scheduler wake runs a pass scoped to one row, and
 * that pass may arm the next wake. A pass that left the lane exactly as it found
 * it - its row queued behind another row's live delivery, or refused before any
 * ledger record existed - re-armed a wake for the other leftover row, whose pass
 * failed the same way and armed this row back. Two queued rows woke each other
 * every 500ms for as long as the blocker lasted. Drive the chain the way the
 * scheduler would and require it to stop.
 */
describe('TeamProvisioningOpenCodeMemberInboxRelay follow-up wake chains', () => {
  function createLane(input: {
    rows: RelayInboxMessage[];
    records?: Map<string, OpenCodePromptDeliveryLedgerRecord>;
    deliver: RelayOpenCodeMemberInboxMessagesPorts['deliverOpenCodeMemberMessage'];
  }): {
    ports: RelayOpenCodeMemberInboxMessagesPorts;
    scheduleWake: ReturnType<
      typeof vi.fn<RelayOpenCodeMemberInboxMessagesPorts['scheduleOpenCodeMemberInboxDeliveryWake']>
    >;
    deliver: ReturnType<
      typeof vi.fn<RelayOpenCodeMemberInboxMessagesPorts['deliverOpenCodeMemberMessage']>
    >;
  } {
    const records = input.records ?? new Map<string, OpenCodePromptDeliveryLedgerRecord>();
    const scheduleWake =
      vi.fn<RelayOpenCodeMemberInboxMessagesPorts['scheduleOpenCodeMemberInboxDeliveryWake']>();
    const deliver = vi.fn(input.deliver);
    const ports = createRelayPorts({
      readInboxMessages: vi.fn(async () => input.rows.map((row) => ({ ...row }))),
      markInboxMessagesRead: vi.fn(
        async (_teamName: string, _memberName: string, messages: RelayInboxMessage[]) => {
          const readIds = new Set(messages.map((row) => row.messageId));
          for (const row of input.rows) if (readIds.has(row.messageId)) row.read = true;
        }
      ),
      createOpenCodePromptDeliveryLedger: vi.fn(() => ({
        getByInboxMessage: vi.fn(
          async ({ inboxMessageId }: { inboxMessageId: string }) =>
            records.get(inboxMessageId) ?? null
        ),
      })) as unknown as RelayOpenCodeMemberInboxMessagesPorts['createOpenCodePromptDeliveryLedger'],
      scheduleOpenCodeMemberInboxDeliveryWake: scheduleWake,
      deliverOpenCodeMemberMessage: deliver,
    });
    return { ports, scheduleWake, deliver };
  }

  async function driveWakeChain(
    lane: ReturnType<typeof createLane>,
    maxPasses = 12
  ): Promise<string[]> {
    const { ports } = lane;
    await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      ports
    );
    const wakes = lane.scheduleWake.mock.calls;
    const woken: string[] = [];
    while (woken.length < wakes.length && woken.length < maxPasses) {
      const wake = wakes[woken.length][0];
      woken.push(wake.messageId);
      await relayOpenCodeMemberInboxMessagesWithPorts(
        {
          teamName: 'team',
          memberName: 'worker',
          relayKey: 'team/worker',
          options: {
            onlyMessageId: wake.messageId,
            source: 'watchdog',
            ...(wake.isCurrent ? { isCurrent: wake.isCurrent } : {}),
          },
        },
        ports
      );
    }
    return woken;
  }

  it('stops once the woken rows only queue behind a live delivery', async () => {
    const active = ledgerRecord({ id: 'record-active', inboxMessageId: 'row-active' });
    const lane = createLane({
      rows: [
        message({ messageId: 'row-active', timestamp: '2026-01-01T00:00:00.000Z' }),
        message({ messageId: 'row-b', timestamp: '2026-01-01T00:00:01.000Z' }),
        message({ messageId: 'row-c', timestamp: '2026-01-01T00:00:02.000Z' }),
      ],
      records: new Map([['row-active', active]]),
      deliver: async (_teamName, delivery) =>
        delivery.messageId === 'row-active'
          ? {
              delivered: true,
              accepted: true,
              responsePending: true,
              ledgerStatus: 'pending',
              ledgerRecordId: active.id,
            }
          : {
              delivered: true,
              accepted: false,
              responsePending: true,
              ledgerStatus: 'pending',
              ledgerRecordId: active.id,
              queuedBehindMessageId: 'row-active',
              reason: 'opencode_delivery_response_pending',
            },
    });

    const woken = await driveWakeChain(lane);

    expect(woken).toEqual(['row-b']);
  });

  it('stops once the woken rows are refused before any delivery record exists', async () => {
    const lane = createLane({
      rows: [
        message({ messageId: 'row-a', timestamp: '2026-01-01T00:00:00.000Z' }),
        message({ messageId: 'row-b', timestamp: '2026-01-01T00:00:01.000Z' }),
      ],
      deliver: async () => ({ delivered: false, reason: 'opencode_runtime_not_active' }),
    });

    const woken = await driveWakeChain(lane);

    expect(woken).toEqual(['row-b']);
  });

  it('keeps chaining while each woken pass delivers its row', async () => {
    const lane = createLane({
      rows: [
        message({ messageId: 'row-a', timestamp: '2026-01-01T00:00:00.000Z' }),
        message({ messageId: 'row-b', timestamp: '2026-01-01T00:00:01.000Z' }),
        message({ messageId: 'row-c', timestamp: '2026-01-01T00:00:02.000Z' }),
      ],
      deliver: async () => ({ delivered: true, accepted: true }),
    });

    const woken = await driveWakeChain(lane);

    expect(woken).toEqual(['row-b', 'row-c']);
    expect(lane.deliver).toHaveBeenCalledTimes(3);
  });
});
