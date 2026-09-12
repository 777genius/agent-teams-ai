import { createHash } from 'node:crypto';

import {
  buildMemberWorkSyncReportRequestDigest,
  createMemberWorkSyncReportJournalInput,
  transferAcceptedReportReceipt,
} from '@features/member-work-sync/core/application/MemberWorkSyncReportJournalProtocol';
import { describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncReportReceipt,
  MemberWorkSyncReportRequest,
} from '@features/member-work-sync/contracts';
import type { MemberWorkSyncReportJournalPort } from '@features/member-work-sync/core/application/MemberWorkSyncReportJournalPort';

const hash = {
  sha256Hex: (value: string) => createHash('sha256').update(value).digest('hex'),
};

const request: MemberWorkSyncReportRequest = {
  teamName: 'sandbox',
  memberName: 'alice',
  state: 'still_working',
  agendaFingerprint: 'agenda:v1:abc',
  reportToken: 'token-1',
};

describe('MemberWorkSyncReportJournalProtocol', () => {
  it('keeps the online intent ID stable across retry timestamps', () => {
    const first = createMemberWorkSyncReportJournalInput({
      request,
      incarnation: 'inc-1',
      receivedAt: '2026-09-10T00:00:00.000Z',
      hash,
    });
    const retry = createMemberWorkSyncReportJournalInput({
      request,
      incarnation: 'inc-1',
      receivedAt: '2026-09-10T00:00:05.000Z',
      hash,
    });
    expect(first.intentId).toBe(`report:${first.requestDigest}`);
    expect(retry.intentId).toBe(first.intentId);
    expect(retry.receivedAt).toBe('2026-09-10T00:00:05.000Z');
  });

  it('allocates a distinct intent ID when later evidence changes the digest', () => {
    const first = createMemberWorkSyncReportJournalInput({
      request,
      incarnation: 'inc-1',
      receivedAt: '2026-09-10T00:00:00.000Z',
      hash,
    });
    const later = createMemberWorkSyncReportJournalInput({
      request: { ...request, reportToken: 'token-2', reportedAt: '2026-09-10T00:10:00.000Z' },
      incarnation: 'inc-1',
      receivedAt: '2026-09-10T00:10:00.000Z',
      hash,
    });
    expect(later.intentId).not.toBe(first.intentId);
    expect(later.requestDigest).not.toBe(first.requestDigest);
    expect(later.requestDigest).toBe(buildMemberWorkSyncReportRequestDigest(hash, later.request));
  });

  it('treats a present but degraded journal transfer as failure', async () => {
    const journal: MemberWorkSyncReportJournalPort = {
      ensure: async () => ({ state: 'unavailable' }),
      read: async () => ({ state: 'unavailable' }),
      transfer: async () => ({
        state: 'present',
        projectionDegraded: true,
        intent: {
          id: 'report:degraded',
          teamName: request.teamName,
          memberName: request.memberName,
          request,
          reason: 'online',
          status: 'accepted',
          recordedAt: '2026-09-10T00:00:00.000Z',
        },
      }),
    };
    const receipt: MemberWorkSyncReportReceipt = {
      intentId: 'report:degraded',
      incarnation: 'inc-1',
      requestDigest: 'digest',
      acceptedAt: '2026-09-10T00:00:00.000Z',
      appliedStatusRevision: {
        incarnation: 'inc-1',
        lineageId: 'lineage',
        sequence: 1,
        nonce: 'n1',
      },
    };
    await expect(
      transferAcceptedReportReceipt(
        journal,
        {
          teamName: request.teamName,
          memberName: request.memberName,
          incarnation: 'inc-1',
          intentId: receipt.intentId,
          requestDigest: receipt.requestDigest,
          receivedAt: receipt.acceptedAt,
          origin: 'online',
          request,
        },
        receipt
      )
    ).resolves.toBe(false);
  });
});
