import {
  buildChangeReviewScopeProjection,
  getReviewDecisionHydrationGuard,
} from '@features/change-review/renderer';
import { describe, expect, it } from 'vitest';

import type { AgentChangeSet, TaskChangeSetV2 } from '@shared/types';

function makeTaskChangeSet(overrides: Partial<TaskChangeSetV2> = {}): TaskChangeSetV2 {
  return {
    teamName: 'team-a',
    taskId: 'task-a',
    files: [],
    totalFiles: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    confidence: 'high',
    computedAt: '2026-07-23T07:00:00.000Z',
    scope: {
      taskId: 'task-a',
      memberName: 'alice',
      startLine: 1,
      endLine: 2,
      startTimestamp: '2026-07-23T06:00:00.000Z',
      endTimestamp: '2026-07-23T06:30:00.000Z',
      toolUseIds: [],
      filePaths: [],
      confidence: { tier: 1, label: 'high', reason: 'test' },
    },
    warnings: [],
    ...overrides,
  };
}

function buildTaskProjection(
  overrides: Partial<Parameters<typeof buildChangeReviewScopeProjection>[0]> = {}
) {
  return buildChangeReviewScopeProjection({
    teamName: 'team-a',
    mode: 'task',
    taskId: 'task-a',
    taskChangeRequestOptions: {
      owner: 'alice',
      status: 'in_progress',
      since: '2026-07-23T06:00:00.000Z',
    },
    activeChangeSet: makeTaskChangeSet(),
    decisionHydrationScopeKey: null,
    decisionHydrationStatus: 'idle',
    draftHistoryHydration: { key: null, status: 'idle' },
    ...overrides,
  });
}

describe('changeReviewScope', () => {
  it('builds the exact logical, persistence, and storage identities', () => {
    const projection = buildTaskProjection();

    expect(projection.scopeKey).toBe('task:task-a');
    expect(projection.decisionScopeKey).toBe('task-task-a');
    expect(projection.decisionScopeToken).toContain('task:task-a:');
    expect(projection.decisionScopeToken).toContain('"owner":"alice"');
    expect(projection.decisionHydrationKey).toBe(
      `team-a:task-task-a:${projection.decisionScopeToken}`
    );
    expect(projection.reviewScope).toEqual({
      teamName: 'team-a',
      taskId: 'task-a',
      memberName: undefined,
    });
    expect(projection.collapseStorageKey).toBe('review:collapsed:team-a:task-task-a');
  });

  it('refuses to bind a stale change set from another team or task', () => {
    const projection = buildTaskProjection({
      activeChangeSet: makeTaskChangeSet({ teamName: 'team-b', taskId: 'task-b' }),
      decisionHydrationScopeKey: 'stale-loaded-scope',
      decisionHydrationStatus: 'loaded',
      draftHistoryHydration: { key: 'stale-loaded-scope', status: 'loaded' },
    });

    expect(projection.decisionScopeToken).toBeNull();
    expect(projection.decisionHydrationKey).toBeNull();
    expect(projection.decisionHydrationReady).toBe(false);
    expect(projection.decisionHydrationPending).toBe(false);
    expect(projection.draftHistoryHydrationReady).toBe(true);
  });

  it('builds agent scope identities without task-only fields', () => {
    const activeChangeSet: AgentChangeSet = {
      teamName: 'team-a',
      memberName: 'alice',
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      computedAt: '2026-07-23T07:00:00.000Z',
    };
    const projection = buildChangeReviewScopeProjection({
      teamName: 'team-a',
      mode: 'agent',
      memberName: 'alice',
      activeChangeSet,
      decisionHydrationScopeKey: null,
      decisionHydrationStatus: 'idle',
      draftHistoryHydration: { key: null, status: 'idle' },
    });

    expect(projection).toMatchObject({
      scopeKey: 'agent:alice',
      decisionScopeKey: 'agent-alice',
      reviewScope: { teamName: 'team-a', memberName: 'alice', taskId: undefined },
      collapseStorageKey: 'review:collapsed:team-a:agent-alice',
    });
    expect(projection.decisionScopeToken).toContain('agent:alice:');
  });

  it('changes the durable token when request intent or change-set provenance changes', () => {
    const baseline = buildTaskProjection();
    const changedRequest = buildTaskProjection({
      taskChangeRequestOptions: {
        owner: 'alice',
        status: 'completed',
        since: '2026-07-23T06:00:00.000Z',
      },
    });
    const changedChangeSet = buildTaskProjection({
      activeChangeSet: makeTaskChangeSet({
        provenance: {
          sourceKind: 'ledger',
          sourceFingerprint: 'different-fingerprint',
          integrity: 'ok',
        },
      }),
    });

    expect(changedRequest.decisionScopeToken).not.toBe(baseline.decisionScopeToken);
    expect(changedChangeSet.decisionScopeToken).not.toBe(baseline.decisionScopeToken);
  });

  it('requires exact hydration identity before exposing persisted state', () => {
    const unhydrated = buildTaskProjection();
    const hydrationKey = unhydrated.decisionHydrationKey!;

    expect(
      buildTaskProjection({
        decisionHydrationScopeKey: 'another-scope',
        decisionHydrationStatus: 'loaded',
      })
    ).toMatchObject({
      decisionHydrationReady: false,
      decisionHydrationPending: true,
      decisionHydrationFailed: false,
    });
    expect(
      buildTaskProjection({
        decisionHydrationScopeKey: hydrationKey,
        decisionHydrationStatus: 'loaded',
        draftHistoryHydration: { key: hydrationKey, status: 'loaded' },
      })
    ).toMatchObject({
      decisionHydrationReady: true,
      decisionHydrationPending: false,
      decisionHydrationFailed: false,
      draftHistoryHydrationReady: true,
      draftHistoryHydrationPending: false,
      draftHistoryHydrationFailed: false,
    });
    expect(
      buildTaskProjection({
        decisionHydrationScopeKey: hydrationKey,
        decisionHydrationStatus: 'error',
        draftHistoryHydration: { key: hydrationKey, status: 'error' },
      })
    ).toMatchObject({
      decisionHydrationReady: false,
      decisionHydrationPending: false,
      decisionHydrationFailed: true,
      draftHistoryHydrationReady: false,
      draftHistoryHydrationPending: false,
      draftHistoryHydrationFailed: true,
    });
  });

  it.each([
    [null, null, 'loaded', 'not-required'],
    ['scope-a', 'scope-b', 'loaded', 'pending'],
    ['scope-a', 'scope-a', 'idle', 'pending'],
    ['scope-a', 'scope-a', 'loading', 'pending'],
    ['scope-a', 'scope-a', 'loaded', 'ready'],
    ['scope-a', 'scope-a', 'error', 'error'],
  ] as const)(
    'keeps the hydration guard truth table for %s / %s / %s',
    (expectedScopeKey, hydratedScopeKey, status, expected) => {
      expect(getReviewDecisionHydrationGuard({ expectedScopeKey, hydratedScopeKey, status })).toBe(
        expected
      );
    }
  );
});
