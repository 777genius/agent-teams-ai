import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS,
  type PendingInboxRelayCandidate,
} from '../TeamProvisioningInboxRelayCandidates';
import { type RelayInboxMessage } from '../TeamProvisioningInboxRelayPolicy';
import {
  type MemberInboxRelayFlowRun,
  type RelayMemberInboxMessagesPorts,
  relayMemberInboxMessagesWithPorts,
} from '../TeamProvisioningMemberInboxRelayFlow';

interface TestRun extends MemberInboxRelayFlowRun {
  runId: string;
}

function createRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'run-1',
    child: {},
    processKilled: false,
    cancelRequested: false,
    provisioningComplete: true,
    pendingInboxRelayCandidates: [],
    silentUserDmForward: null,
    silentUserDmForwardClearHandle: null,
    ...overrides,
  };
}

function message(overrides: Partial<RelayInboxMessage> = {}): RelayInboxMessage {
  return {
    from: 'user',
    to: 'worker',
    text: 'please check this',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    messageId: 'message-1',
    ...overrides,
  };
}

function createPorts(
  overrides: Partial<RelayMemberInboxMessagesPorts<TestRun>> = {}
): RelayMemberInboxMessagesPorts<TestRun> {
  const run = createRun();
  const runs = new Map([[run.runId, run]]);

  return {
    inFlight: new Map(),
    getAliveRunId: vi.fn().mockReturnValue(run.runId),
    getRun: vi.fn((runId: string) => runs.get(runId)),
    isCurrentTrackedRun: vi.fn().mockReturnValue(true),
    readInboxMessages: vi.fn().mockResolvedValue([]),
    markInboxMessagesRead: vi.fn().mockResolvedValue(undefined),
    sendMessageToRun: vi.fn().mockResolvedValue(undefined),
    hasAcceptedMemberWorkSyncReport: vi.fn().mockResolvedValue(false),
    relayedMemberInboxMessageIds: new Map(),
    trimRelayedSet: vi.fn((relayedIds: Set<string>) => relayedIds),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    nowIso: () => '2026-01-01T00:00:00.000Z',
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TeamProvisioningMemberInboxRelayFlow', () => {
  it('waits on existing in-flight relay work and cleans the in-flight map on timeout', async () => {
    vi.useFakeTimers();
    const existing = new Promise<number>(() => {});
    const inFlight = new Map([['team/worker', existing]]);
    const ports = createPorts({ inFlight });

    const result = relayMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      ports
    );

    await vi.advanceTimersByTimeAsync(INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS);

    await expect(result).resolves.toBe(0);
    expect(inFlight.has('team/worker')).toBe(false);
    expect(ports.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('member_inbox_relay_timed_out')
    );
    expect(ports.readInboxMessages).not.toHaveBeenCalled();
  });

  it('marks ignored read-only messages read without sending', async () => {
    const ignored = [
      message({
        messageId: 'silent-heartbeat',
        text: JSON.stringify({ type: 'idle_notification', idleReason: 'available' }),
      }),
      message({
        messageId: 'passive-heartbeat',
        timestamp: '2026-01-01T00:00:01.000Z',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: 'still reviewing',
        }),
      }),
    ];
    const ports = createPorts({
      readInboxMessages: vi.fn().mockResolvedValue(ignored),
    });

    await expect(
      relayMemberInboxMessagesWithPorts(
        { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
        ports
      )
    ).resolves.toBe(0);

    expect(ports.markInboxMessagesRead).toHaveBeenCalledWith('team', 'worker', ignored);
    expect(ports.sendMessageToRun).not.toHaveBeenCalled();
  });

  it('sends actionable prompts, remembers candidates, and marks non-work-sync messages read', async () => {
    const run = createRun();
    const runs = new Map([[run.runId, run]]);
    const normal = message({ messageId: 'normal' });
    const workSync = message({
      messageId: 'work-sync',
      timestamp: '2026-01-01T00:00:01.000Z',
      messageKind: 'member_work_sync_nudge',
    });
    const sendMessageToRun = vi.fn().mockResolvedValue(undefined);
    const ports = createPorts({
      getRun: vi.fn((runId: string) => runs.get(runId)),
      readInboxMessages: vi.fn().mockResolvedValue([normal, workSync]),
      sendMessageToRun,
    });

    await expect(
      relayMemberInboxMessagesWithPorts(
        { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
        ports
      )
    ).resolves.toBe(2);

    expect(sendMessageToRun).toHaveBeenCalledWith(run, expect.stringContaining('Inbox relay'));
    expect(sendMessageToRun.mock.calls[0]?.[1]).toContain('member_work_sync_nudge');
    expect(run.pendingInboxRelayCandidates.map((candidate) => candidate.sourceMessageId)).toEqual([
      'work-sync',
      'normal',
    ]);
    expect(ports.markInboxMessagesRead).toHaveBeenCalledWith('team', 'worker', [normal]);
    expect(ports.relayedMemberInboxMessageIds.get('team/worker')).toEqual(new Set(['normal']));
  });

  it('forgets remembered relay candidates and returns 0 when sending fails', async () => {
    const run = createRun({
      pendingInboxRelayCandidates: [
        {
          recipient: 'worker',
          sourceMessageId: 'keep',
          normalizedText: 'already queued',
          normalizedSummary: '',
          queuedAtMs: Date.now(),
        },
      ] satisfies PendingInboxRelayCandidate[],
    });
    const runs = new Map([[run.runId, run]]);
    const failed = message({ messageId: 'drop', text: 'send this' });
    const ports = createPorts({
      getRun: vi.fn((runId: string) => runs.get(runId)),
      readInboxMessages: vi.fn().mockResolvedValue([failed]),
      sendMessageToRun: vi.fn().mockRejectedValue(new Error('send failed')),
    });

    await expect(
      relayMemberInboxMessagesWithPorts(
        { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
        ports
      )
    ).resolves.toBe(0);

    expect(run.pendingInboxRelayCandidates.map((candidate) => candidate.sourceMessageId)).toEqual([
      'keep',
    ]);
    expect(ports.markInboxMessagesRead).not.toHaveBeenCalled();
    expect(ports.relayedMemberInboxMessageIds.has('team/worker')).toBe(false);
  });
});
