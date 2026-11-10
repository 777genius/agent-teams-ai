import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  armSilentTeammateForward,
  consumePendingInboxRelayCandidate,
  forgetPendingInboxRelayCandidates,
  type InboxRelayCandidateRunState,
  InboxRelayInFlightTimeoutError,
  normalizeRelayCandidateSummary,
  normalizeRelayCandidateText,
  PENDING_INBOX_RELAY_TTL_MS,
  prunePendingInboxRelayCandidates,
  rememberPendingInboxRelayCandidates,
  type SilentTeammateForwardRunState,
  waitForInboxRelayInFlight,
} from '../TeamProvisioningInboxRelayCandidates';

function candidateRun(
  pendingInboxRelayCandidates: InboxRelayCandidateRunState['pendingInboxRelayCandidates'] = []
): InboxRelayCandidateRunState {
  return { pendingInboxRelayCandidates };
}

describe('TeamProvisioningInboxRelayCandidates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes relay candidate text and summaries like the service did inline', () => {
    expect(normalizeRelayCandidateText(`  ${wrapAgentBlock('internal')}\r\nhello\r\nworld  `)).toBe(
      'hello\nworld'
    );
    expect(normalizeRelayCandidateSummary('  short summary  ')).toBe('short summary');
    expect(normalizeRelayCandidateSummary()).toBe('');
  });

  it('remembers candidates after pruning stale rows and skipping unusable messages', () => {
    const nowMs = Date.now();
    const run = candidateRun([
      {
        recipient: 'dev',
        sourceMessageId: 'expired',
        normalizedText: 'old',
        normalizedSummary: '',
        queuedAtMs: nowMs - PENDING_INBOX_RELAY_TTL_MS - 1,
      },
      {
        recipient: 'dev',
        sourceMessageId: 'fresh',
        normalizedText: 'keep',
        normalizedSummary: '',
        queuedAtMs: nowMs,
      },
    ]);

    const rememberedIds = rememberPendingInboxRelayCandidates(
      run,
      'reviewer',
      [
        { messageId: ' msg-1 ', text: '  hello\r\nthere  ', summary: ' greeting ' },
        { messageId: 'blank-text', text: '   ' },
        { messageId: '', text: 'has text' },
      ],
      nowMs
    );

    expect(rememberedIds).toEqual(['msg-1']);
    expect(run.pendingInboxRelayCandidates).toEqual([
      {
        recipient: 'dev',
        sourceMessageId: 'fresh',
        normalizedText: 'keep',
        normalizedSummary: '',
        queuedAtMs: nowMs,
      },
      {
        recipient: 'reviewer',
        sourceMessageId: 'msg-1',
        normalizedText: 'hello\nthere',
        normalizedSummary: 'greeting',
        queuedAtMs: nowMs,
      },
    ]);
  });

  it('consumes exact summary matches first, then falls back to matching text', () => {
    const queuedAtMs = Date.now();
    const run = candidateRun([
      {
        recipient: 'dev',
        sourceMessageId: 'summary-a',
        normalizedText: 'same text',
        normalizedSummary: 'a',
        queuedAtMs,
      },
      {
        recipient: 'dev',
        sourceMessageId: 'summary-b',
        normalizedText: 'same text',
        normalizedSummary: 'b',
        queuedAtMs,
      },
    ]);

    expect(consumePendingInboxRelayCandidate(run, 'dev', 'same text', 'b')).toBe('summary-b');
    expect(consumePendingInboxRelayCandidate(run, 'dev', 'same text', 'missing')).toBe('summary-a');
    expect(consumePendingInboxRelayCandidate(run, 'dev', 'same text')).toBeUndefined();
  });

  it('forgets only matching recipient and source ids', () => {
    const queuedAtMs = Date.now();
    const run = candidateRun([
      {
        recipient: 'dev',
        sourceMessageId: 'drop',
        normalizedText: 'a',
        normalizedSummary: '',
        queuedAtMs,
      },
      {
        recipient: 'reviewer',
        sourceMessageId: 'drop',
        normalizedText: 'b',
        normalizedSummary: '',
        queuedAtMs,
      },
    ]);

    forgetPendingInboxRelayCandidates(run, 'dev', ['drop']);

    expect(run.pendingInboxRelayCandidates.map((candidate) => candidate.recipient)).toEqual([
      'reviewer',
    ]);
  });

  it('prunes stale relay candidates using the extracted TTL', () => {
    const nowMs = Date.now();
    const run = candidateRun([
      {
        recipient: 'dev',
        sourceMessageId: 'stale',
        normalizedText: 'stale',
        normalizedSummary: '',
        queuedAtMs: nowMs - PENDING_INBOX_RELAY_TTL_MS - 1,
      },
      {
        recipient: 'dev',
        sourceMessageId: 'fresh',
        normalizedText: 'fresh',
        normalizedSummary: '',
        queuedAtMs: nowMs - PENDING_INBOX_RELAY_TTL_MS,
      },
    ]);

    expect(
      prunePendingInboxRelayCandidates(run, nowMs).map((candidate) => candidate.sourceMessageId)
    ).toEqual(['fresh']);
  });

  it('waits for existing relay work or rejects with the relay timeout error', async () => {
    await expect(
      waitForInboxRelayInFlight({
        promise: Promise.resolve(3),
        relayName: 'lead_inbox_relay',
        relayKey: 'team-a',
        timeoutMs: 50,
      })
    ).resolves.toBe(3);

    await expect(
      waitForInboxRelayInFlight({
        promise: new Promise(() => undefined),
        relayName: 'member_inbox_relay',
        relayKey: 'team-a/dev',
        timeoutMs: 1,
      })
    ).rejects.toBeInstanceOf(InboxRelayInFlightTimeoutError);
  });

  it('arms and replaces the silent teammate forward clear timer', () => {
    const run: SilentTeammateForwardRunState = {
      silentUserDmForward: null,
      silentUserDmForwardClearHandle: null,
    };
    const clearSpy = vi.spyOn(global, 'clearTimeout');

    armSilentTeammateForward(run, 'dev', 'user_dm', '2026-01-01T00:00:00.000Z');
    const firstHandle = run.silentUserDmForwardClearHandle;

    expect(run.silentUserDmForward).toEqual({
      target: 'dev',
      startedAt: '2026-01-01T00:00:00.000Z',
      mode: 'user_dm',
    });
    expect(firstHandle).toBeTruthy();

    armSilentTeammateForward(run, 'reviewer', 'member_inbox_relay', '2026-01-01T00:00:01.000Z');

    expect(clearSpy).toHaveBeenCalledWith(firstHandle);
    expect(run.silentUserDmForward).toEqual({
      target: 'reviewer',
      startedAt: '2026-01-01T00:00:01.000Z',
      mode: 'member_inbox_relay',
    });
    if (run.silentUserDmForwardClearHandle) {
      clearTimeout(run.silentUserDmForwardClearHandle);
    }
  });
});
