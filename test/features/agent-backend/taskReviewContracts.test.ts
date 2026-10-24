import { describe, expect, it } from 'vitest';

import { resolveReviewerFromHistory } from '../../../src/main/services/team/stallMonitor/reviewerResolution';
import { projectTaskHistory } from '../../../src/features/agent-backend/main/adapters/output/projectTaskHistory';
import { getDerivedReviewStateFromHistory } from '../../../src/shared/utils/taskHistory';

import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';

describe('captured task review contract', () => {
  const request = {
    handle: { handleId: 'TEST-handle' },
    commandId: 'TEST-review',
    operation: 'task.review',
    payload: {
      taskId: 'TEST-task',
      action: 'request_changes',
      comment: 'Fix this',
      taskRefs: [{ taskId: 'TEST-other', displayId: '2', teamName: 'TEST-team' }],
    },
  };
  it('retains product review fields while excluding actor/native selectors and mismatched action fields', () => {
    expect(parseBackendOperation(request)).toEqual(request);
    for (const override of [
      { from: 'lead' },
      { actor: 'lead' },
      { leadSessionId: 'TEST-native' },
      { notifyOwner: true },
    ])
      expect(() =>
        parseBackendOperation({ ...request, payload: { ...request.payload, ...override } })
      ).toThrow();
    expect(() =>
      parseBackendOperation({
        ...request,
        payload: { taskId: 'TEST-task', action: 'approve', notifyOwner: 'yes' },
      })
    ).toThrow();
  });
  it('projects original review receipt and product state without private fields', () => {
    expect(
      projectBackendResult(parseBackendOperation(request), {
        ok: true,
        value: {
          commandId: request.commandId,
          command: { operation: 'task.review' },
          phase: 'completed',
          result: {
            id: 'TEST-task',
            subject: 'Review work',
            status: 'pending',
            reviewState: 'needsFix',
            nativeSessionId: 'SECRET',
            principalId: 'SECRET',
          },
        },
      })
    ).toEqual({
      ok: true,
      value: {
        commandId: request.commandId,
        operation: 'task.review',
        phase: 'completed',
        task: {
          id: 'TEST-task',
          subject: 'Review work',
          status: 'pending',
          reviewState: 'needsFix',
        },
      },
    });
  });
});


it('admits only the explicit Disapprove action and projects its approval reset without reviving approval', () => {
  const input = { handle: { handleId: 'TEST-owner' }, commandId: 'TEST-disapprove', operation: 'task.review', payload: { taskId: 'TEST-task', action: 'disapprove' } };
  expect(parseBackendOperation(input)).toEqual(input);
  for (const extra of [{ from: 'user' }, { actor: 'user' }, { notifyOwner: true }, { transition: 'status_reset' }])
    expect(() => parseBackendOperation({ ...input, payload: { ...input.payload, ...extra } })).toThrow();
  const approved = { id: 'TEST-approved', timestamp: '2026-10-24T00:00:00Z', type: 'review_approved', from: 'review', to: 'approved', actor: 'user' };
  const disapproved = { id: 'TEST-disapproved', timestamp: '2026-10-24T00:00:01Z', type: 'review_disapproved', from: 'approved', to: 'none', actor: 'user' };
  const historyEvents = projectTaskHistory([approved, disapproved]);
  expect(historyEvents).toEqual([approved, disapproved]);
  expect(getDerivedReviewStateFromHistory({ historyEvents })).toBe('none');
  expect(resolveReviewerFromHistory({ historyEvents } as never)).toEqual({ reviewer: null, source: 'none' });
  expect(() => projectTaskHistory([{ ...disapproved, from: 'review' }])).toThrow();
  expect(() => projectTaskHistory([{ ...disapproved, to: 'approved' }])).toThrow();
});
