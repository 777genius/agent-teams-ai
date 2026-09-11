import { describe, expect, it } from 'vitest';

import {
  applyMemberWorkSyncRetryableDispatch,
  applyMemberWorkSyncTerminalAck,
  applyMemberWorkSyncTerminalRetirement,
  findMemberWorkSyncCompactWitness,
  isMemberWorkSyncEarlyContinuationEnabled,
} from '@features/member-work-sync/core/domain/MemberWorkSyncRecoveryTerminal';

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
});
