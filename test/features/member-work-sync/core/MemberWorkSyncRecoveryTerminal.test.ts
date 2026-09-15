import {
  applyMemberWorkSyncAcceptedReportRetirement,
  applyMemberWorkSyncDeliveredDispatch,
  applyMemberWorkSyncRetryableDispatch,
  applyMemberWorkSyncTerminalAck,
  applyMemberWorkSyncTerminalRetirement,
  findMemberWorkSyncCompactWitness,
  isMemberWorkSyncEarlyContinuationEnabled,
} from '@features/member-work-sync/core/domain/MemberWorkSyncRecoveryTerminal';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncRecoveryHealth } from '@features/member-work-sync/contracts';

const health: MemberWorkSyncRecoveryHealth = {
  schemaVersion: 1,
  episodes: [],
  unresolvedIntentId: 'intent-1',
  controlRevision: 1,
  reservations: [
    {
      intentId: 'intent-1',
      episodeId: 'episode-1',
      trigger: 'automatic',
      reservedAt: '2026-09-11T12:00:00.000Z',
      state: 'reserved',
      payloadHash: 'hash-a',
      controlRevision: 1,
    },
  ],
};

describe('member work sync recovery terminal protocol', () => {
  it('keeps the unresolved slot after a retryable refusal', () => {
    const next = applyMemberWorkSyncRetryableDispatch({ health, intentId: 'intent-1' });
    expect(next?.unresolvedIntentId).toBe('intent-1');
    expect(next?.reservations?.[0]).toMatchObject({
      state: 'uncertain',
      terminalOutcome: 'retryable_refusal',
    });
  });

  it('clears only I1 after terminal retirement and keeps a compact witness after ack', () => {
    const retired = applyMemberWorkSyncTerminalRetirement({
      health,
      intentId: 'intent-1',
      receiptId: 'receipt-1',
    });
    expect(retired?.unresolvedIntentId).toBeUndefined();
    expect(retired?.reservations?.[0]).toMatchObject({
      state: 'resolved',
      pendingAck: true,
      terminalReceiptId: 'receipt-1',
    });
    const acknowledged = applyMemberWorkSyncTerminalAck({
      health: retired,
      intentId: 'intent-1',
      ackIdentity: 'ack-1',
    });
    expect(acknowledged?.reservations?.[0]?.compactWitness).toBe(true);
    expect(findMemberWorkSyncCompactWitness(acknowledged, 'intent-1')?.payloadHash).toBe('hash-a');
    const lateI1 = applyMemberWorkSyncRetryableDispatch({
      health: {
        ...acknowledged!,
        unresolvedIntentId: 'intent-2',
        reservations: [
          ...(acknowledged?.reservations ?? []),
          {
            intentId: 'intent-2',
            episodeId: 'episode-2',
            trigger: 'automatic',
            reservedAt: '2026-09-11T12:05:00.000Z',
            state: 'reserved',
            payloadHash: 'hash-b',
            controlRevision: 1,
          },
        ],
      },
      intentId: 'intent-1',
    });
    expect(lateI1?.unresolvedIntentId).toBe('intent-2');
  });

  it('does not require ack after a proven pre-send refusal', () => {
    const retired = applyMemberWorkSyncTerminalRetirement({
      health,
      intentId: 'intent-1',
      receiptId: 'dispatch-superseded:intent-1',
      pendingAck: false,
    });
    expect(retired?.unresolvedIntentId).toBeUndefined();
    expect(retired?.reservations?.[0]?.pendingAck).toBeUndefined();
    expect(retired?.reservations?.[0]?.state).toBe('resolved');
  });

  it('fails closed for early continuation without protocol 2 and a ticket port', () => {
    expect(isMemberWorkSyncEarlyContinuationEnabled({ recoveryProtocol: { version: 0 } })).toBe(
      false
    );
    expect(isMemberWorkSyncEarlyContinuationEnabled({ recoveryProtocol: { version: 1 } })).toBe(
      false
    );
    expect(isMemberWorkSyncEarlyContinuationEnabled({ recoveryProtocol: { version: 2 } })).toBe(
      false
    );
    expect(
      isMemberWorkSyncEarlyContinuationEnabled({
        recoveryProtocol: { version: 2 },
        runtimeTicketAdmission: {},
      })
    ).toBe(true);
  });

  it('binds delivered dispatch to the outbox prompt identity', () => {
    const next = applyMemberWorkSyncDeliveredDispatch({
      health,
      intentId: 'intent-1',
      boundTurnId: 'msg_recovery_prompt',
      deliveredAt: '2026-09-11T12:00:30.000Z',
    });
    expect(next?.reservations?.[0]).toMatchObject({
      state: 'awaiting_outcome',
      boundTurnId: 'msg_recovery_prompt',
      deliveredAt: '2026-09-11T12:00:30.000Z',
    });
  });

  it('does not reopen a resolved reservation after a late delivered dispatch', () => {
    const retired = applyMemberWorkSyncTerminalRetirement({
      health,
      intentId: 'intent-1',
      receiptId: 'inbox-revoked:intent-1',
      pendingAck: false,
    });
    const late = applyMemberWorkSyncDeliveredDispatch({
      health: retired,
      intentId: 'intent-1',
      boundTurnId: 'msg_recovery_prompt',
      deliveredAt: '2026-09-11T12:00:30.000Z',
    });
    expect(late?.unresolvedIntentId).toBeUndefined();
    expect(late?.reservations?.[0]).toMatchObject({
      state: 'resolved',
      terminalReceiptId: 'inbox-revoked:intent-1',
    });
  });

  it('retires an awaiting reservation after a later accepted report', () => {
    const awaiting = applyMemberWorkSyncDeliveredDispatch({
      health,
      intentId: 'intent-1',
      boundTurnId: 'msg_recovery_prompt',
      deliveredAt: '2026-09-11T12:00:30.000Z',
    });
    const retired = applyMemberWorkSyncAcceptedReportRetirement({
      health: awaiting,
      reportedAt: '2026-09-11T12:01:00.000Z',
    });
    expect(retired?.unresolvedIntentId).toBeUndefined();
    expect(retired?.reservations?.[0]).toMatchObject({
      state: 'resolved',
      terminalOutcome: 'settled',
      terminalReceiptId: 'report-accepted:intent-1',
    });
  });

  it('does not retire an awaiting reservation from a report before delivery', () => {
    const awaiting = applyMemberWorkSyncDeliveredDispatch({
      health,
      intentId: 'intent-1',
      deliveredAt: '2026-09-11T12:05:00.000Z',
    });
    const next = applyMemberWorkSyncAcceptedReportRetirement({
      health: awaiting,
      reportedAt: '2026-09-11T12:01:00.000Z',
    });
    expect(next?.unresolvedIntentId).toBe('intent-1');
    expect(next?.reservations?.[0]?.state).toBe('awaiting_outcome');
  });

  it('does not retire an awaiting reservation without delivery proof', () => {
    const awaiting = applyMemberWorkSyncDeliveredDispatch({
      health,
      intentId: 'intent-1',
    });
    const next = applyMemberWorkSyncAcceptedReportRetirement({
      health: awaiting,
      reportedAt: '2026-09-11T12:01:00.000Z',
    });
    expect(next?.unresolvedIntentId).toBe('intent-1');
    expect(next?.reservations?.[0]?.state).toBe('awaiting_outcome');
    expect(next?.reservations?.[0]?.deliveredAt).toBeUndefined();
  });

  it('retires an uncertain reservation after a later accepted report', () => {
    const uncertain = applyMemberWorkSyncRetryableDispatch({ health, intentId: 'intent-1' });
    const retired = applyMemberWorkSyncAcceptedReportRetirement({
      health: uncertain,
      reportedAt: '2026-09-11T12:01:00.000Z',
    });
    expect(retired?.unresolvedIntentId).toBeUndefined();
    expect(retired?.reservations?.[0]).toMatchObject({
      state: 'resolved',
      terminalOutcome: 'settled',
      terminalReceiptId: 'report-accepted:intent-1',
    });
  });

  it('retires a stale uncertain slot even after the unresolved pointer was dropped', () => {
    const uncertain = applyMemberWorkSyncRetryableDispatch({ health, intentId: 'intent-1' });
    const orphaned = {
      ...uncertain!,
      unresolvedIntentId: undefined,
    };
    const retired = applyMemberWorkSyncAcceptedReportRetirement({
      health: orphaned,
      reportedAt: '2026-09-11T12:01:00.000Z',
    });
    expect(retired?.unresolvedIntentId).toBeUndefined();
    expect(retired?.reservations?.[0]).toMatchObject({
      state: 'resolved',
      terminalOutcome: 'settled',
      terminalReceiptId: 'report-accepted:intent-1',
    });
  });
});
