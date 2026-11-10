import { mergeDomainSnapshots } from '@features/member-work-sync/main/infrastructure/memberWorkSyncDomainSnapshotMerge';
import { mergeMemberWorkSyncSnapshots } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSnapshotMerge';
import { statusToRecord } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncStatus,
  MemberWorkSyncStatusRevision,
} from '@features/member-work-sync/contracts';

const time = '2026-09-10T00:00:00.000Z';
function status(sequence?: number): MemberWorkSyncStatus {
  return {
    teamName: 'sandbox',
    memberName: 'alice',
    state: 'needs_sync',
    evaluatedAt: time,
    diagnostics: [],
    agenda: {
      teamName: 'sandbox',
      memberName: 'alice',
      generatedAt: time,
      fingerprint: 'agenda',
      items: [],
      diagnostics: [],
    },
    ...(sequence === undefined
      ? {}
      : {
          statusRevision: {
            incarnation: 'team-1',
            lineageId: 'lineage-1',
            sequence,
            nonce: `mutation-${sequence}`,
          },
        }),
  };
}

function merge(
  kind: 'domain' | 'record',
  left: MemberWorkSyncStatus[],
  right: MemberWorkSyncStatus[]
): MemberWorkSyncStatus[] {
  const empty = { reportIntents: [], outboxItems: [], metricEvents: [] };
  if (kind === 'domain') {
    return mergeDomainSnapshots(
      { ...empty, statuses: left, filesToArchive: [] },
      { ...empty, statuses: right, filesToArchive: [] }
    ).statuses;
  }
  return mergeMemberWorkSyncSnapshots(
    'sandbox',
    { ...empty, statuses: left.map(statusToRecord) },
    { ...empty, statuses: right.map(statusToRecord) }
  ).statuses.map((row) => JSON.parse(row.statusJson) as MemberWorkSyncStatus);
}

describe.each(['domain', 'record'] as const)('%s status revision merge', (kind) => {
  it('selects the whole later sequence even when its timestamp is older', () => {
    const older = { ...status(10), evaluatedAt: '2026-09-11T00:00:00.000Z', diagnostics: ['old'] };
    const newer = { ...status(11), diagnostics: ['new'] };
    expect(merge(kind, [older], [newer])).toEqual([newer]);
    expect(merge(kind, [newer], [older])).toEqual([newer]);
  });

  it('does not replace a versioned status with legacy data or restart its lineage', () => {
    const versioned = status(11);
    const legacy = { ...status(), evaluatedAt: '2026-09-12T00:00:00.000Z' };
    expect(merge(kind, [versioned], [legacy])).toEqual([versioned]);
    expect(merge(kind, [legacy], [versioned])).toEqual([versioned]);
    expect(merge(kind, [], [versioned])).toEqual([versioned]);
  });

  it('folds duplicate canonical identities rather than keeping the last array element', () => {
    const newest = status(11);
    const staleAlias = { ...status(10), memberName: ' Alice ' };
    expect(merge(kind, [newest, staleAlias], [])).toEqual([newest]);
    expect(merge(kind, [staleAlias, newest], [])).toEqual([newest]);
    const divergent = {
      ...status(11),
      statusRevision: { ...newest.statusRevision!, nonce: 'other' },
    };
    expect(() => merge(kind, [newest, divergent], [])).toThrow('revision_divergence');
  });

  it('accepts equal revision with same-team spelling aliases without changing its input', () => {
    const left = status(11);
    const alias = {
      ...left,
      teamName: ' Sandbox ',
      agenda: { ...left.agenda, teamName: 'Sandbox' },
    };
    const before = JSON.stringify(alias);
    expect(merge(kind, [left], [alias])).toEqual([left]);
    expect(JSON.stringify(alias)).toBe(before);
  });

  it('accepts identical revision and JSON payload regardless of property order', () => {
    const left = status(11);
    const right = Object.fromEntries(
      Object.entries(left).reverse()
    ) as unknown as MemberWorkSyncStatus;
    expect(merge(kind, [left], [right])).toEqual([left]);
  });

  it.each([
    ['nonce', 'other-mutation', 'revision_divergence'],
    ['lineageId', 'other-lineage', 'lineage_mismatch'],
    ['incarnation', 'other-team', 'incarnation_mismatch'],
  ] as const)('refuses conflicting %s instead of ordering by time', (field, value, reason) => {
    const left = status(11);
    const right = { ...status(11), statusRevision: { ...left.statusRevision!, [field]: value } };
    expect(() => merge(kind, [left], [right])).toThrow(reason);
  });

  it('refuses different payload under the same revision and nonce', () => {
    expect(() => merge(kind, [status(11)], [{ ...status(11), diagnostics: ['changed'] }])).toThrow(
      'revision_divergence'
    );
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    'refuses invalid sequence %s even for an unpaired incoming row',
    (sequence) => {
      expect(() => merge(kind, [], [status(sequence)])).toThrow('invalid_revision');
    }
  );

  it('does not downgrade corrupt revision metadata into legacy', () => {
    const corrupt = {
      ...status(),
      statusRevision: null as unknown as MemberWorkSyncStatusRevision,
    };
    expect(() => merge(kind, [corrupt], [])).toThrow('invalid_revision');
  });

  it('keeps existing legacy tie behavior until one-time adoption', () => {
    const right = { ...status(), diagnostics: ['incoming'] };
    expect(merge(kind, [status()], [right])).toEqual([right]);
  });
});

it('validates and folds canonical domain rows even without an active overlay', () => {
  const empty = { reportIntents: [], outboxItems: [], metricEvents: [], filesToArchive: [] };
  expect(
    mergeDomainSnapshots({ ...empty, statuses: [status(11), status(10)] }, null).statuses
  ).toEqual([status(11)]);
  const divergent = { ...status(11), diagnostics: ['divergent'] };
  expect(() => mergeDomainSnapshots({ ...empty, statuses: [status(11), divergent] }, null)).toThrow(
    'revision_divergence'
  );
});
