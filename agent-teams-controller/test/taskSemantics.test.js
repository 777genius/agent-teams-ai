/* global describe, expect, it, require */
/* eslint-disable @typescript-eslint/no-require-imports -- Proves the CommonJS package subpath. */
const {
  resolveReview,
  resolveTaskSemantics,
  resolveBlockers,
  planColumnTransition,
  resolveColumnOrder,
} = require('agent-teams-controller/task-semantics');
/* eslint-enable @typescript-eslint/no-require-imports */

const task = (overrides = {}) => ({
  key: 'task-1',
  status: 'completed',
  reviewState: 'none',
  history: [],
  placement: null,
  ...overrides,
});

describe('public task semantics', () => {
  it('keeps completed needs-fix actionable without history and blocks dependents', () => {
    const needsFix = task({ reviewState: 'needsFix' });
    expect(resolveReview(needsFix).state).toBe('needsFix');
    expect(resolveTaskSemantics(needsFix)).toMatchObject({
      needsFixActionable: true,
      finishedForDependency: false,
      terminalForActionableWork: false,
    });
    expect(resolveBlockers([{ kind: 'known_task', key: 'task-1', task: needsFix }]))
      .toEqual({ allowed: false, reason: 'blocked_open_dependency' });
  });

  it('does not finish a reviewed completion until approval', () => {
    const reviewed = task({ history: [{ kind: 'review_requested' }] });
    const approved = task({ history: [{ kind: 'review_requested' }, { kind: 'review_approved' }] });
    expect(resolveTaskSemantics(reviewed).finishedForDependency).toBe(false);
    expect(resolveTaskSemantics(approved).finishedForDependency).toBe(true);
  });

  it('respects append order, pending reset and explicit review reset over stale placement', () => {
    const history = [
      { kind: 'review_requested' },
      { kind: 'status_changed', to: 'pending' },
      { kind: 'review_changes_requested' },
      { kind: 'review_reset' },
      { kind: 'other' },
    ];
    expect(resolveReview(task({ history, placement: { column: 'review' } })).state).toBe('none');
    expect(resolveReview(task({ history: history.slice(0, 2) })).state).toBe('none');
    expect(resolveReview(task({ history: history.slice(0, 3), status: 'pending' })).state)
      .toBe('needsFix');
  });

  it('distinguishes unknown blocker from authoritative absence', () => {
    expect(resolveBlockers([{ kind: 'unknown', key: 'missing' }]))
      .toEqual({ allowed: false, reason: 'insufficient_knowledge' });
    expect(resolveBlockers([{ kind: 'known_absent', key: 'missing' }]))
      .toEqual({ allowed: true, reason: 'allowed' });
    expect(planColumnTransition({
      task: task({ status: 'pending' }),
      targetColumn: 'in_progress',
      blockers: [{ kind: 'unknown', key: 'missing' }],
    })).toEqual({ allowed: false, reason: 'insufficient_knowledge' });
  });

  it('plans a completed review exit as one reset, without a fake status cycle', () => {
    const reviewed = task({
      reviewState: 'review',
      history: [{ kind: 'review_requested' }],
      placement: { column: 'review' },
    });
    expect(planColumnTransition({ task: reviewed, targetColumn: 'done', blockers: [] }))
      .toEqual({
        allowed: true,
        reason: 'allowed',
        transition: {
          kind: 'set_status',
          status: 'completed',
          clearPlacement: true,
          resetReview: true,
        },
      });
    expect(planColumnTransition({
      task: task({ ...reviewed, history: [{ kind: 'review_reset' }], placement: null }),
      targetColumn: 'done',
      blockers: [],
    }).transition.kind).toBe('none');
  });

  it('reconciles matching visible columns when task facts still need a transition', () => {
    expect(planColumnTransition({
      task: task({ reviewState: 'needsFix' }),
      targetColumn: 'done',
      blockers: [],
    })).toMatchObject({
      allowed: true,
      transition: { kind: 'set_status', status: 'completed', resetReview: true },
    });
    expect(planColumnTransition({
      task: task({
        history: [{ kind: 'review_requested' }],
        placement: { column: 'done' },
      }),
      targetColumn: 'done',
      blockers: [],
    })).toEqual({
      allowed: true,
      reason: 'allowed',
      transition: {
        kind: 'set_status',
        status: 'completed',
        clearPlacement: true,
        resetReview: true,
      },
    });
    expect(planColumnTransition({
      task: task({ status: 'pending', placement: { column: 'in_progress' } }),
      targetColumn: 'in_progress',
      blockers: [{ kind: 'unknown', key: 'blocker' }],
    })).toEqual({ allowed: false, reason: 'insufficient_knowledge' });
  });

  it('checks approval admission and distinguishes open from deleted blockers', () => {
    expect(planColumnTransition({
      task: task({ status: 'pending', placement: { column: 'approved' } }),
      targetColumn: 'approved',
      blockers: [],
    })).toEqual({ allowed: false, reason: 'state_conflict' });
    expect(planColumnTransition({
      task: task({ history: [{ kind: 'review_requested' }] }),
      targetColumn: 'approved',
      blockers: [],
    })).toMatchObject({ allowed: true, transition: { kind: 'approve_review' } });
    expect(planColumnTransition({
      task: task(),
      targetColumn: 'approved',
      blockers: [],
    })).toMatchObject({ allowed: true, transition: { kind: 'manual_approve' } });
    expect(planColumnTransition({
      task: task({
        history: [{ kind: 'review_approved' }],
        placement: { column: 'review' },
      }),
      targetColumn: 'review',
      blockers: [],
    })).toEqual({ allowed: false, reason: 'state_conflict' });
    const input = {
      task: task({ status: 'pending' }),
      targetColumn: 'in_progress',
    };
    expect(planColumnTransition({
      ...input,
      blockers: [{ kind: 'known_task', key: 'blocker', task: task({ status: 'in_progress' }) }],
    })).toEqual({ allowed: false, reason: 'blocked_open_dependency' });
    expect(planColumnTransition({
      ...input,
      blockers: [{ kind: 'known_task', key: 'blocker', task: task({ status: 'deleted' }) }],
    })).toMatchObject({
      allowed: true,
      transition: { kind: 'set_status', status: 'in_progress' },
    });
  });

  it('treats in-progress and deleted status history as review resets', () => {
    for (const status of ['in_progress', 'deleted']) {
      const snapshot = task({
        status,
        reviewState: 'review',
        history: [{ kind: 'review_requested' }, { kind: 'status_changed', to: status }],
      });
      expect(resolveReview(snapshot).state).toBe('none');
    }
    expect(planColumnTransition({
      task: task({
        history: [{ kind: 'review_requested' }, { kind: 'review_reset' }],
        placement: { column: 'approved' },
      }),
      targetColumn: 'done',
      blockers: [],
    })).toMatchObject({
      allowed: true,
      transition: { kind: 'set_status', clearPlacement: true, resetReview: false },
    });
  });

  it('requires a complete revision-bound column before ordering', () => {
    const input = {
      canonicalKeys: ['a', 'b', 'c'],
      explicitKeys: ['orphan', 'c', 'c', 'a'],
      canonicalColumnComplete: true,
      sourceRevision: 'generation:12',
      explicitOrderRevision: 'generation:12',
    };
    expect(resolveColumnOrder(input)).toEqual({
      allowed: true,
      reason: 'allowed',
      orderedKeys: ['c', 'a', 'b'],
    });
    expect(resolveColumnOrder({ ...input, canonicalColumnComplete: false }))
      .toEqual({ allowed: false, reason: 'insufficient_knowledge' });
    expect(resolveColumnOrder({ ...input, explicitOrderRevision: 'generation:11' }))
      .toEqual({ allowed: false, reason: 'insufficient_knowledge' });
  });
});
