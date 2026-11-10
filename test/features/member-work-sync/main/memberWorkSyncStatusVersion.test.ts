import { decodeMemberWorkSyncStoredStatus } from '@features/member-work-sync/main/infrastructure/decodeMemberWorkSyncStoredStatus';
import {
  createMemberWorkSyncStatusToken,
  createMemberWorkSyncStatusVersion,
  readMemberWorkSyncStatusToken,
} from '@features/member-work-sync/main/infrastructure/memberWorkSyncStatusVersion';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
import type { MemberWorkSyncStatusBinding } from '@features/member-work-sync/main/infrastructure/memberWorkSyncStatusVersion';

const binding: MemberWorkSyncStatusBinding = {
  teamName: 'sandbox',
  memberName: 'alice',
  incarnation: 'inc-1',
  backend: 'json',
};
const at = '2026-09-10T00:00:00.000Z';
function status(): MemberWorkSyncStatus {
  return {
    teamName: binding.teamName,
    memberName: binding.memberName,
    evaluatedAt: at,
    diagnostics: [],
    state: 'needs_sync',
    agenda: {
      teamName: binding.teamName,
      memberName: binding.memberName,
      generatedAt: at,
      fingerprint: 'agenda',
      items: [],
      diagnostics: [],
    },
  };
}

describe('storage-owned status version and token', () => {
  it.each([null, '{ "memberName": " Alice " }\n'])('retains exact raw snapshot %s', (raw) => {
    const token = createMemberWorkSyncStatusToken(binding, raw);
    expect(
      readMemberWorkSyncStatusToken(token, {
        ...binding,
        teamName: ' SANDBOX ',
        memberName: 'Alice',
      })
    ).toEqual({ ok: true, raw });
  });

  it.each([
    { teamName: 'other' },
    { memberName: 'bob' },
    { incarnation: 'inc-2' },
    { backend: 'sqlite' as const },
  ])('refuses a token with another binding %j', (change) => {
    expect(
      readMemberWorkSyncStatusToken(createMemberWorkSyncStatusToken(binding, '{}'), {
        ...binding,
        ...change,
      })
    ).toEqual({ ok: false });
  });

  it.each(['null', '{bad', '{}', '{"formatVersion":2,"raw":null}'])(
    'refuses malformed or unsupported token %s',
    (token) => {
      expect(readMemberWorkSyncStatusToken(token, binding)).toEqual({ ok: false });
    }
  );

  it('adds a lineage to legacy data without changing the caller or its history', () => {
    const current = status();
    current.report = {
      teamName: binding.teamName,
      memberName: binding.memberName,
      state: 'blocked',
      agendaFingerprint: 'agenda',
      reportedAt: at,
      accepted: true,
      note: 'Waiting for test input',
    };
    const raw = JSON.stringify(current);
    let sequence = 0;
    const next = createMemberWorkSyncStatusVersion(
      current,
      current,
      binding,
      () => `uuid-${++sequence}`
    );
    expect(next.statusRevision).toEqual({
      incarnation: 'inc-1',
      lineageId: 'uuid-1',
      sequence: 1,
      nonce: 'uuid-2',
    });
    expect(next.report).toEqual(current.report);
    expect(JSON.stringify(current)).toBe(raw);
  });

  it('preserves lineage, increments sequence and replaces caller-supplied revision metadata', () => {
    const current = status();
    current.statusRevision = {
      incarnation: 'inc-1',
      lineageId: 'existing',
      sequence: 7,
      nonce: 'old',
    };
    const caller = status();
    caller.statusRevision = {
      incarnation: 'forged',
      lineageId: 'forged',
      sequence: 500,
      nonce: 'forged',
    };
    expect(
      createMemberWorkSyncStatusVersion(current, caller, binding, () => 'new').statusRevision
    ).toEqual({
      incarnation: 'inc-1',
      lineageId: 'existing',
      sequence: 8,
      nonce: 'new',
    });
    expect(caller.statusRevision.nonce).toBe('forged');
  });

  it('does not reset overflow or a different incarnation into a fresh lineage', () => {
    const current = status();
    current.statusRevision = {
      incarnation: 'inc-1',
      lineageId: 'existing',
      sequence: Number.MAX_SAFE_INTEGER,
      nonce: 'old',
    };
    expect(() => createMemberWorkSyncStatusVersion(current, status(), binding)).toThrow(
      'invalid_revision'
    );
    current.statusRevision.sequence = 1;
    current.statusRevision.incarnation = 'other';
    expect(() => createMemberWorkSyncStatusVersion(current, status(), binding)).toThrow(
      'incarnation_mismatch'
    );
  });
});

const receiptDraft = {
  intentId: 'intent-1',
  incarnation: binding.incarnation,
  requestDigest: 'digest-1',
  acceptedAt: at,
  originalExpiresAt: '2026-09-10T00:05:00.000Z',
};

function acceptedStatus(): MemberWorkSyncStatus {
  return {
    ...status(),
    lastAcceptedReport: {
      teamName: binding.teamName,
      memberName: binding.memberName,
      state: 'still_working',
      agendaFingerprint: 'agenda',
      reportedAt: at,
      expiresAt: receiptDraft.originalExpiresAt,
      accepted: true,
    },
  };
}

describe('authority report receipt checkpoint', () => {
  it('refuses a receipt without its accepted report in the same write', () => {
    for (const next of [
      status(),
      {
        ...acceptedStatus(),
        lastAcceptedReport: { ...acceptedStatus().lastAcceptedReport!, accepted: false },
      },
      {
        ...acceptedStatus(),
        lastAcceptedReport: {
          ...acceptedStatus().lastAcceptedReport!,
          reportedAt: '2026-09-10T00:01:00.000Z',
        },
      },
    ]) {
      expect(() =>
        createMemberWorkSyncStatusVersion(null, next, binding, () => 'uuid', receiptDraft)
      ).toThrow();
    }
    const stored = createMemberWorkSyncStatusVersion(
      null,
      acceptedStatus(),
      binding,
      () => 'uuid',
      receiptDraft
    );
    expect(() =>
      createMemberWorkSyncStatusVersion(stored, status(), binding, () => 'retry', receiptDraft)
    ).toThrow();
  });

  it('rejects inconsistent same-revision receipt but keeps historical carry readable', () => {
    const stored = createMemberWorkSyncStatusVersion(
      null,
      acceptedStatus(),
      binding,
      () => 'uuid',
      receiptDraft
    );
    expect(() =>
      decodeMemberWorkSyncStoredStatus(
        { ...stored, report: undefined, lastAcceptedReport: undefined },
        binding
      )
    ).toThrow();
    expect(() =>
      decodeMemberWorkSyncStoredStatus(
        {
          ...stored,
          pendingReportReceipt: {
            ...stored.pendingReportReceipt!,
            acceptedAt: '2026-09-10T00:02:00.000Z',
          },
        },
        binding
      )
    ).toThrow();
    const carried = createMemberWorkSyncStatusVersion(stored, status(), binding, () => 'next');
    expect(decodeMemberWorkSyncStoredStatus(carried, binding).pendingReportReceipt).toEqual(
      stored.pendingReportReceipt
    );
  });

  it.each(['json', 'sqlite'] as const)(
    'stamps and round-trips %s receipt atomically',
    (backend) => {
      const stored = createMemberWorkSyncStatusVersion(
        null,
        acceptedStatus(),
        { ...binding, backend },
        () => 'uuid',
        receiptDraft
      );
      expect(stored.pendingReportReceipt).toEqual({
        ...receiptDraft,
        appliedStatusRevision: stored.statusRevision,
      });
      expect(decodeMemberWorkSyncStoredStatus(JSON.parse(JSON.stringify(stored)), binding)).toEqual(
        stored
      );
    }
  );

  it('preserves the checkpoint through omitted fields and retries without extending expiry', () => {
    const stored = createMemberWorkSyncStatusVersion(
      null,
      acceptedStatus(),
      binding,
      () => 'uuid',
      receiptDraft
    );
    const carried = createMemberWorkSyncStatusVersion(
      stored,
      acceptedStatus(),
      binding,
      () => 'next'
    );
    const retried = createMemberWorkSyncStatusVersion(
      carried,
      carried,
      binding,
      () => 'retry',
      receiptDraft
    );
    expect(carried.pendingReportReceipt).toEqual(stored.pendingReportReceipt);
    expect(retried.pendingReportReceipt).toEqual(stored.pendingReportReceipt);
    expect(retried.statusRevision?.sequence).toBe(3);
    expect(stored.statusRevision?.sequence).toBe(1);
  });

  it('replaces a checkpoint only with the exact transferred receipt proof', () => {
    const stored = createMemberWorkSyncStatusVersion(
      null,
      acceptedStatus(),
      binding,
      () => 'uuid',
      receiptDraft
    );
    const nextDraft = {
      intentId: 'intent-2',
      incarnation: binding.incarnation,
      requestDigest: 'digest-2',
      acceptedAt: '2026-09-10T00:01:00.000Z',
      originalExpiresAt: '2026-09-10T00:16:00.000Z',
    };
    const nextAccepted = {
      ...acceptedStatus(),
      lastAcceptedReport: {
        ...acceptedStatus().lastAcceptedReport!,
        reportedAt: nextDraft.acceptedAt,
        expiresAt: nextDraft.originalExpiresAt,
      },
    };
    expect(() =>
      createMemberWorkSyncStatusVersion(stored, nextAccepted, binding, () => 'next', nextDraft)
    ).toThrow();
    expect(() =>
      createMemberWorkSyncStatusVersion(
        stored,
        nextAccepted,
        binding,
        () => 'next',
        nextDraft,
        { ...stored.pendingReportReceipt!, intentId: 'other' }
      )
    ).toThrow();
    const replaced = createMemberWorkSyncStatusVersion(
      stored,
      nextAccepted,
      binding,
      () => 'next',
      nextDraft,
      stored.pendingReportReceipt
    );
    expect(replaced.pendingReportReceipt).toEqual({
      ...nextDraft,
      appliedStatusRevision: replaced.statusRevision,
    });
    expect(replaced.pendingReportReceipt?.intentId).toBe('intent-2');
    expect(replaced.statusRevision?.sequence).toBe(2);
  });

  it('refuses caller-installed committed receipts and checkpoint replacement', () => {
    const stored = createMemberWorkSyncStatusVersion(
      null,
      acceptedStatus(),
      binding,
      () => 'uuid',
      receiptDraft
    );
    expect(() => createMemberWorkSyncStatusVersion(null, stored, binding)).toThrow();
    for (const change of [
      { intentId: 'intent-2' },
      { requestDigest: 'other' },
      { incarnation: 'other' },
      { acceptedAt: 'invalid' },
      { originalExpiresAt: 'invalid' },
    ]) {
      expect(() =>
        createMemberWorkSyncStatusVersion(stored, stored, binding, () => 'next', {
          ...receiptDraft,
          ...change,
        })
      ).toThrow();
    }
  });

  it('rejects malformed stored receipts and incomparable revisions', () => {
    const stored = createMemberWorkSyncStatusVersion(
      null,
      acceptedStatus(),
      binding,
      () => 'uuid',
      receiptDraft
    );
    const revision = stored.statusRevision!;
    for (const receipt of [
      null,
      {},
      receiptDraft,
      { ...stored.pendingReportReceipt, intentId: ' ' },
      { ...stored.pendingReportReceipt, incarnation: 'other' },
      { ...stored.pendingReportReceipt, acceptedAt: 'infinity' },
      ...[
        { incarnation: 'other' },
        { lineageId: 'other' },
        { sequence: 2 },
        { nonce: 'other' },
      ].map((change) => ({
        ...stored.pendingReportReceipt,
        appliedStatusRevision: { ...revision, ...change },
      })),
    ]) {
      expect(() =>
        decodeMemberWorkSyncStoredStatus({ ...stored, pendingReportReceipt: receipt }, binding)
      ).toThrow();
    }
  });
});
