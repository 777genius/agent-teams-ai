import { buildActionableWorkAgenda } from '@features/member-work-sync/core/domain';
import { describe, expect, it } from 'vitest';

const hash = (value: string) => `h${value.length}`;

describe('buildActionableWorkAgenda', () => {
  it('includes owned pending and in-progress work but excludes completed tasks', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'bob' }],
      tasks: [
        {
          id: 'task-1',
          displayId: '#11111111',
          subject: 'Pending',
          status: 'pending',
          owner: 'bob',
        },
        {
          id: 'task-2',
          displayId: '#22222222',
          subject: 'In progress',
          status: 'in_progress',
          owner: 'Bob',
        },
        {
          id: 'task-3',
          displayId: '#33333333',
          subject: 'Done',
          status: 'completed',
          owner: 'bob',
        },
      ],
      hash,
    });

    expect(agenda.items.map((item) => [item.taskId, item.kind, item.reason])).toEqual([
      ['task-1', 'work', 'owned_pending_task'],
      ['task-2', 'work', 'owned_in_progress_task'],
    ]);
  });

  it('does not keep stale terminal task state in the work agenda', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'jack',
      generatedAt: '2026-05-06T19:06:07.257Z',
      members: [{ name: 'jack' }],
      tasks: [
        {
          id: 'task-completed',
          displayId: '#6d4db591',
          subject: 'Completed after stale work-sync status',
          status: 'completed',
          owner: 'jack',
        },
        {
          id: 'task-deleted',
          subject: 'Deleted after stale work-sync status',
          status: 'in_progress',
          owner: 'jack',
          deletedAt: '2026-05-06T19:06:07.257Z',
        },
        {
          id: 'task-review-approved',
          subject: 'Approved review after stale work-sync status',
          status: 'in_progress',
          owner: 'jack',
          reviewState: 'approved',
        },
        {
          id: 'task-kanban-approved',
          subject: 'Approved kanban after stale work-sync status',
          status: 'in_progress',
          owner: 'jack',
          kanbanColumn: 'approved',
        },
        {
          id: 'task-stale-needsfix-approved',
          subject: 'Approved task after stale needsFix status',
          status: 'in_progress',
          owner: 'jack',
          reviewState: 'needsFix',
          kanbanColumn: 'approved',
        },
      ],
      hash,
    });

    expect(agenda.items).toEqual([]);
  });

  it('projects reopened in-progress work after a previous completion', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'jack',
      generatedAt: '2026-05-06T18:56:19.173Z',
      members: [{ name: 'jack' }],
      tasks: [
        {
          id: 'task-reopened',
          displayId: '#6d4db591',
          subject: 'Reopened work',
          status: 'in_progress',
          owner: 'jack',
          historyEvents: [
            {
              id: 'evt-completed',
              type: 'status_changed',
              timestamp: '2026-05-06T18:50:05.662Z',
              from: 'in_progress',
              to: 'completed',
            },
            {
              id: 'evt-reopened',
              type: 'status_changed',
              timestamp: '2026-05-06T18:56:19.173Z',
              from: 'completed',
              to: 'in_progress',
            },
          ],
        },
      ],
      hash,
    });

    expect(agenda.items.map((item) => [item.taskId, item.reason])).toEqual([
      ['task-reopened', 'owned_in_progress_task'],
    ]);
  });

  it('does not treat approved dependencies as waiting blockers', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'jack',
      generatedAt: '2026-05-06T19:06:07.257Z',
      members: [{ name: 'jack' }],
      tasks: [
        {
          id: 'task-approved',
          subject: 'Approved dependency',
          status: 'in_progress',
          owner: 'alice',
          kanbanColumn: 'approved',
        },
        {
          id: 'task-dependent',
          subject: 'Depends on approved task',
          status: 'in_progress',
          owner: 'jack',
          blockedBy: [' task-approved '],
        },
      ],
      hash,
    });

    expect(agenda.items.map((item) => [item.taskId, item.reason])).toEqual([
      ['task-dependent', 'owned_in_progress_task'],
    ]);
  });

  it('keeps dependencies blocked while completed work is still in review', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'jack',
      generatedAt: '2026-05-06T19:06:07.257Z',
      members: [{ name: 'jack' }, { name: 'alice' }],
      tasks: [
        {
          id: 'task-review',
          subject: 'Dependency waiting for review',
          status: 'completed',
          owner: 'alice',
          reviewState: 'review',
          kanbanColumn: 'review',
        },
        {
          id: 'task-dependent',
          subject: 'Depends on reviewed task',
          status: 'in_progress',
          owner: 'jack',
          blockedBy: ['task-review'],
        },
      ],
      hash,
    });

    expect(agenda.items).toEqual([]);
  });

  it('does not let stale kanban approved hide a reopened pending task', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'jack',
      generatedAt: '2026-05-06T19:06:07.257Z',
      members: [{ name: 'jack' }],
      tasks: [
        {
          id: 'task-reopened-pending',
          subject: 'Reopened pending work',
          status: 'pending',
          owner: 'jack',
          kanbanColumn: 'approved',
        },
      ],
      hash,
    });

    expect(agenda.items.map((item) => [item.taskId, item.reason])).toEqual([
      ['task-reopened-pending', 'owned_pending_task'],
    ]);
  });

  it('assigns active review work to the current-cycle reviewer only', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'alice',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }],
      tasks: [
        {
          id: 'task-1',
          subject: 'Review me',
          status: 'in_progress',
          owner: 'bob',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-1',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
          ],
        },
      ],
      hash,
    });

    expect(agenda.items).toHaveLength(1);
    expect(agenda.items[0]).toMatchObject({
      taskId: 'task-1',
      kind: 'review',
      assignee: 'alice',
      evidence: {
        reviewer: 'alice',
        reviewObligation: 'review_pickup_required',
        reviewRequestEventId: 'evt-1',
        canBypassDeliveryReadiness: true,
      },
    });
  });

  it('routes self-review to lead oversight instead of reviewer pickup', () => {
    const ownerAgenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'alice',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'team-lead', agentType: 'lead' }],
      tasks: [
        {
          id: 'task-self-review',
          subject: 'Self review should be reassigned',
          status: 'completed',
          owner: 'alice',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-self-review',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
          ],
        },
      ],
      hash,
    });
    const leadAgenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'team-lead',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'team-lead', agentType: 'lead' }],
      tasks: [
        {
          id: 'task-self-review',
          subject: 'Self review should be reassigned',
          status: 'completed',
          owner: 'alice',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-self-review',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
          ],
        },
      ],
      hash,
    });

    expect(ownerAgenda.items).toEqual([]);
    expect(leadAgenda.items).toHaveLength(1);
    expect(leadAgenda.items[0]).toMatchObject({
      taskId: 'task-self-review',
      kind: 'clarification',
      assignee: 'team-lead',
      reason: 'self_review_invalid',
      evidence: {
        owner: 'alice',
        reviewer: 'alice',
        reviewRequestEventId: 'evt-self-review',
        reviewDiagnostics: ['self_review_invalid'],
      },
    });
  });

  it('does not treat an older review_started event as progress for a newer review request', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'alice',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }],
      tasks: [
        {
          id: 'task-1',
          subject: 'Review current request',
          status: 'completed',
          owner: 'bob',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-old-start',
              type: 'review_started',
              timestamp: '2026-04-29T00:00:00.000Z',
              actor: 'alice',
            },
            {
              id: 'evt-old-approved',
              type: 'review_approved',
              timestamp: '2026-04-29T00:01:00.000Z',
              actor: 'alice',
            },
            {
              id: 'evt-new-request',
              type: 'review_requested',
              timestamp: '2026-04-29T00:02:00.000Z',
              reviewer: 'alice',
            },
          ],
        },
      ],
      hash,
    });

    expect(agenda.items).toHaveLength(1);
    expect(agenda.items[0]?.evidence).toMatchObject({
      reviewObligation: 'review_pickup_required',
      reviewRequestEventId: 'evt-new-request',
      canBypassDeliveryReadiness: true,
      historyEventIds: ['evt-new-request'],
    });
    expect(agenda.items[0]?.evidence.reviewStartedEventId).toBeUndefined();
  });

  it('routes a newer review request to the requested reviewer even when kanban reviewer is stale', () => {
    const aliceAgenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'alice',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }],
      kanbanReviewersByTaskId: { 'task-1': 'alice' },
      tasks: [
        {
          id: 'task-1',
          subject: 'Reviewer changed',
          status: 'completed',
          owner: 'tom',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-old-request',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
            {
              id: 'evt-new-request',
              type: 'review_requested',
              timestamp: '2026-04-29T00:01:00.000Z',
              reviewer: 'bob',
            },
          ],
        },
      ],
      hash,
    });
    const bobAgenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }],
      kanbanReviewersByTaskId: { 'task-1': 'alice' },
      tasks: [
        {
          id: 'task-1',
          subject: 'Reviewer changed',
          status: 'completed',
          owner: 'tom',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-old-request',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
            {
              id: 'evt-new-request',
              type: 'review_requested',
              timestamp: '2026-04-29T00:01:00.000Z',
              reviewer: 'bob',
            },
          ],
        },
      ],
      hash,
    });

    expect(aliceAgenda.items).toEqual([]);
    expect(bobAgenda.items).toHaveLength(1);
    expect(bobAgenda.items[0]?.evidence).toMatchObject({
      reviewer: 'bob',
      reviewObligation: 'review_pickup_required',
      reviewRequestEventId: 'evt-new-request',
      reviewDiagnostics: ['kanban_reviewer_differs_from_review_request'],
    });
  });

  it('marks a started review as in-progress evidence that cannot bypass delivery readiness', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'alice',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }],
      tasks: [
        {
          id: 'task-1',
          subject: 'Review already started',
          status: 'completed',
          owner: 'bob',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-request',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
            {
              id: 'evt-start',
              type: 'review_started',
              timestamp: '2026-04-29T00:01:00.000Z',
              actor: 'alice',
            },
          ],
        },
      ],
      hash,
    });

    expect(agenda.items[0]?.evidence).toMatchObject({
      reviewObligation: 'review_in_progress',
      reviewRequestEventId: 'evt-request',
      reviewStartedEventId: 'evt-start',
      reviewStartedBy: 'alice',
      canBypassDeliveryReadiness: false,
      historyEventIds: ['evt-request', 'evt-start'],
    });
  });

  it('keeps completed tasks actionable for the current reviewer while workflow is review', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'alice',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }],
      tasks: [
        {
          id: 'task-review',
          subject: 'Review completed work',
          status: 'completed',
          owner: 'bob',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-review',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
          ],
        },
      ],
      hash,
    });

    expect(agenda.items).toHaveLength(1);
    expect(agenda.items[0]).toMatchObject({
      taskId: 'task-review',
      kind: 'review',
      assignee: 'alice',
    });
  });

  it('does not assign owner work while stale in-progress task is in review workflow', () => {
    const ownerAgenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }],
      tasks: [
        {
          id: 'task-review',
          subject: 'Review in progress status',
          status: 'in_progress',
          owner: 'bob',
          reviewState: 'none',
          kanbanColumn: 'review',
          historyEvents: [
            {
              id: 'evt-review',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
          ],
        },
      ],
      hash,
    });
    const reviewerAgenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'alice',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }],
      tasks: [
        {
          id: 'task-review',
          subject: 'Review in progress status',
          status: 'in_progress',
          owner: 'bob',
          reviewState: 'none',
          kanbanColumn: 'review',
          historyEvents: [
            {
              id: 'evt-review',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
          ],
        },
      ],
      hash,
    });

    expect(ownerAgenda.items).toEqual([]);
    expect(reviewerAgenda.items.map((item) => [item.taskId, item.kind, item.reason])).toEqual([
      ['task-review', 'review', 'current_cycle_review_assigned'],
    ]);
  });

  it('does not resurrect a stale reviewer after review was approved', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'alice',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }],
      tasks: [
        {
          id: 'task-1',
          subject: 'Old review',
          status: 'in_progress',
          owner: 'bob',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-1',
              type: 'review_requested',
              timestamp: '2026-04-29T00:00:00.000Z',
              reviewer: 'alice',
            },
            {
              id: 'evt-2',
              type: 'review_approved',
              timestamp: '2026-04-29T00:01:00.000Z',
              actor: 'alice',
            },
          ],
        },
      ],
      hash,
    });

    expect(agenda.items).toEqual([]);
  });

  it('prefers current kanban reviewer over older review history while task remains in review', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'carol',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }],
      kanbanReviewersByTaskId: { 'task-1': 'carol' },
      tasks: [
        {
          id: 'task-1',
          subject: 'Review me',
          status: 'in_progress',
          owner: 'bob',
          reviewState: 'review',
          historyEvents: [
            {
              id: 'evt-1',
              type: 'review_started',
              timestamp: '2026-04-29T00:00:00.000Z',
              actor: 'alice',
            },
          ],
        },
      ],
      hash,
    });

    expect(agenda.items).toHaveLength(1);
    expect(agenda.items[0]).toMatchObject({
      taskId: 'task-1',
      kind: 'review',
      assignee: 'carol',
      evidence: { reviewer: 'carol' },
    });
  });

  it('does not nudge owners while work is waiting on user or unfinished dependencies', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'bob' }, { name: 'team-lead', agentType: 'team-lead' }],
      tasks: [
        {
          id: 'task-1',
          subject: 'Need user',
          status: 'in_progress',
          owner: 'bob',
          needsClarification: 'user',
        },
        {
          id: 'task-3',
          displayId: '#33333333',
          subject: 'Dependency',
          status: 'in_progress',
          owner: 'alice',
        },
        {
          id: 'task-2',
          subject: 'Waiting dependency',
          status: 'in_progress',
          owner: 'bob',
          blockedBy: ['#33333333'],
        },
      ],
      hash,
    });

    expect(agenda.items).toEqual([]);
  });

  it('does not project display-id dependencies as broken when the dependency exists', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'team-lead',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'bob' }, { name: 'team-lead', agentType: 'team-lead' }],
      tasks: [
        {
          id: 'task-dep',
          displayId: '#33333333',
          subject: 'Existing dependency',
          status: 'in_progress',
          owner: 'alice',
        },
        {
          id: 'task-2',
          subject: 'Waiting dependency',
          status: 'in_progress',
          owner: 'bob',
          blockedBy: ['33333333'],
        },
      ],
      hash,
    });

    expect(agenda.items).toEqual([]);
  });

  it('does not unblock owner work when a display-id dependency is ambiguous', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'bob' }],
      tasks: [
        {
          id: 'task-active-dep',
          displayId: '#33333333',
          subject: 'Active dependency',
          status: 'in_progress',
          owner: 'alice',
        },
        {
          id: 'task-completed-dep',
          displayId: '#33333333',
          subject: 'Duplicate completed dependency',
          status: 'completed',
          owner: 'alice',
        },
        {
          id: 'task-dependent',
          subject: 'Ambiguous dependency',
          status: 'in_progress',
          owner: 'bob',
          blockedBy: ['33333333'],
        },
      ],
      hash,
    });

    expect(agenda.items).toEqual([]);
  });

  it('prefers canonical task ids over colliding display ids for dependencies', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'bob' }],
      tasks: [
        {
          id: 'task-dep',
          displayId: '#33333333',
          subject: 'Completed dependency',
          status: 'completed',
          owner: 'alice',
        },
        {
          id: 'task-collision',
          displayId: '#task-dep',
          subject: 'Display collision',
          status: 'in_progress',
          owner: 'alice',
        },
        {
          id: 'task-dependent',
          subject: 'Canonical dependency',
          status: 'in_progress',
          owner: 'bob',
          blockedBy: ['task-dep'],
        },
      ],
      hash,
    });

    expect(agenda.items.map((item) => [item.taskId, item.reason])).toEqual([
      ['task-dependent', 'owned_in_progress_task'],
    ]);
  });

  it('projects lead-owned oversight for lead clarification and broken dependencies', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'team-lead',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'bob' }, { name: 'team-lead', agentType: 'team-lead' }],
      tasks: [
        {
          id: 'task-1',
          subject: 'Need lead',
          status: 'in_progress',
          owner: 'bob',
          needsClarification: 'lead',
        },
        {
          id: 'task-2',
          subject: 'Broken dependency',
          status: 'in_progress',
          owner: 'bob',
          blockedBy: ['missing-task'],
        },
      ],
      hash,
    });

    expect(agenda.items.map((item) => [item.taskId, item.kind, item.reason])).toEqual([
      ['task-1', 'clarification', 'task_needs_lead_clarification'],
      ['task-2', 'blocked_dependency', 'task_has_broken_dependency'],
    ]);
  });

  it('treats needsFix as owner work', () => {
    const agenda = buildActionableWorkAgenda({
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      members: [{ name: 'bob' }],
      tasks: [
        {
          id: 'task-1',
          subject: 'Fix review',
          status: 'in_progress',
          owner: 'bob',
          reviewState: 'needsFix',
        },
        {
          id: 'task-2',
          subject: 'Fix completed review',
          status: 'completed',
          owner: 'bob',
          reviewState: 'needsFix',
        },
      ],
      hash,
    });

    expect(agenda.items.map((item) => [item.taskId, item.kind, item.reason])).toEqual([
      ['task-1', 'work', 'review_changes_requested'],
      ['task-2', 'work', 'review_changes_requested'],
    ]);
  });

  it('keeps fingerprint stable across generatedAt changes and changes it on owner change', () => {
    const base = {
      teamName: 'team-a',
      memberName: 'bob',
      members: [{ name: 'bob' }, { name: 'alice' }],
      hash,
    };
    const first = buildActionableWorkAgenda({
      ...base,
      generatedAt: '2026-04-29T00:00:00.000Z',
      tasks: [{ id: 'task-1', subject: 'Work', status: 'pending', owner: 'bob' }],
    });
    const second = buildActionableWorkAgenda({
      ...base,
      generatedAt: '2026-04-29T00:05:00.000Z',
      tasks: [{ id: 'task-1', subject: 'Work', status: 'pending', owner: 'bob' }],
    });
    const third = buildActionableWorkAgenda({
      ...base,
      generatedAt: '2026-04-29T00:05:00.000Z',
      tasks: [{ id: 'task-1', subject: 'Work', status: 'pending', owner: 'alice' }],
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).not.toBe(third.fingerprint);
  });
});
