// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { afterEach, expect, it } from 'vitest';

import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { projectTaskHistory } from '../../../src/features/agent-backend/main/adapters/output/projectTaskHistory';
import { projectTeamTask } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import { getCurrentReviewStage, getDerivedReviewStateFromHistory } from '../../../src/shared/utils/taskHistory';

import type { BackendOperationPayloads } from '../../../src/features/agent-backend/contracts/operations';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const handle = { handleId: 'TEST-review-history' };

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-review-history-')));
  roots.push(root);
  const teamName = 'test-review';
  const owner = createFilesystemTeamOwner({
    root,
    binding: { backendId: 'TEST-backend', teamId: 'TEST-team', teamName },
    members: ['lead', 'alice', 'bob'].map((name) => ({
      memberId: `${name}-id`, name, role: name === 'lead' ? 'lead' as const : 'member' as const,
    })),
    grants: ['user', 'lead', 'alice', 'bob'].map((name) => ({
      principalId: name, memberName: name, permissions: ['read', 'task.write', 'message.write'],
    })),
  });
  const human = owner.connect('user');
  human.execute({
    commandId: 'TEST-review-policy', operation: 'task.board.review-flow',
    payload: { settings: { reviewFlow: 'lead_then_human', reviewFlowPrompt: '' } },
  });
  const taskId = human.execute({
    commandId: 'TEST-create', operation: 'task.create',
    payload: { subject: 'Original review workflow', owner: 'bob' },
  }).effects.taskId;
  owner.connect('bob').execute({
    commandId: 'TEST-work-complete', operation: 'task.lifecycle', payload: { taskId, action: 'complete' },
  });
  const review = (actor: string, commandId: string, payload: BackendOperationPayloads['task.review']) => {
    const request = parseBackendOperation({ handle, commandId, operation: 'task.review', payload });
    if (request.operation !== 'task.review') throw new Error('Invalid review fixture');
    const receipt = owner.connect(actor).execute({
      commandId, operation: request.operation, payload: request.payload,
    });
    expect(receipt.phase).toBe('completed');
    const projected = projectBackendResult(request, { ok: true, value: receipt });
    expect(projected).toMatchObject({ ok: true, value: { commandId, operation: 'task.review', phase: 'completed' } });
    if (!projected.ok || !projected.value || !('task' in projected.value) || !projected.value.task)
      throw new Error('Missing projected original task');
    expect(projected.value.task.historyEvents).toEqual(projectTeamTask(receipt.result, teamName).historyEvents);
    return projected.value.task;
  };
  return { human, taskId, review };
}

it('projects actual reviewer completion, correlated lead sign-off and separate human acceptance with the full accepted note', () => {
  const f = fixture();
  const requested = f.review('user', 'TEST-request', { taskId: f.taskId, action: 'request', reviewer: 'alice' });
  const firstCycle = requested.historyEvents?.filter(event => event.type === 'review_requested').at(-1);
  expect(firstCycle?.type).toBe('review_requested');
  f.review('alice', 'TEST-review-start', { taskId: f.taskId, action: 'start' });
  const note = '漢'.repeat(200_000);
  const completed = f.review('alice', 'TEST-review-complete', {
    taskId: f.taskId, action: 'complete', expectedReviewRequestId: firstCycle!.id, note,
  });
  const leadCycle = completed.historyEvents?.filter(event => event.type === 'review_requested').at(-1);
  expect(leadCycle).toMatchObject({ stage: 'lead_signoff', afterReviewRequestId: firstCycle!.id, reviewer: 'lead' });
  expect(leadCycle?.note === note).toBe(true);
  expect(getCurrentReviewStage(completed)).toBe('lead_signoff');
  const signed = f.review('lead', 'TEST-lead-complete', {
    taskId: f.taskId, action: 'complete', expectedReviewRequestId: leadCycle!.id, note: 'Lead accepted',
  });
  expect(signed.historyEvents).toContainEqual(expect.objectContaining({
    type: 'review_completed', from: 'review', to: 'reviewed', reviewRequestId: leadCycle!.id, note: 'Lead accepted',
  }));
  expect(getDerivedReviewStateFromHistory(signed)).toBe('reviewed');
  const accepted = f.review('user', 'TEST-human-approve', { taskId: f.taskId, action: 'approve' });
  expect(accepted.historyEvents).toContainEqual(expect.objectContaining({
    type: 'human_approved', actor: 'user', from: 'reviewed', to: 'approved',
  }));
  expect(getDerivedReviewStateFromHistory(accepted)).toBe('approved');
  expect(getCurrentReviewStage(accepted)).toBeNull();
  expect(f.human.getTask(f.taskId).historyEvents).toEqual(accepted.historyEvents);
});

it('preserves the actual reason the original lead review skips a redundant sign-off', () => {
  const f = fixture();
  const requested = f.review('user', 'TEST-request-lead', { taskId: f.taskId, action: 'request', reviewer: 'lead' });
  const cycle = requested.historyEvents?.filter(event => event.type === 'review_requested').at(-1);
  const completed = f.review('lead', 'TEST-lead-review-complete', {
    taskId: f.taskId, action: 'complete', expectedReviewRequestId: cycle!.id, note: 'Original lead review',
  });
  expect(completed.historyEvents).toContainEqual(expect.objectContaining({
    type: 'review_completed', reviewRequestId: cycle!.id, leadSignoffSkipped: 'actor_is_lead',
  }));
  expect(getDerivedReviewStateFromHistory(completed)).toBe('reviewed');
  expect(getCurrentReviewStage(completed)).toBeNull();
});

it('keeps history authority, cycle fields, text and aggregate bounds fail-closed', () => {
  const event = {
    id: 'TEST-completed', timestamp: '2026-11-08T12:00:00.000Z', actor: 'alice',
    type: 'review_completed', from: 'review', to: 'reviewed', reviewRequestId: 'TEST-cycle',
  };
  expect(projectTaskHistory([{ ...event, privateReceipt: 'SECRET' }])).toEqual([event]);
  for (const invalid of [
    { from: 'reviewed' }, { to: 'approved' }, { reviewRequestId: undefined },
    { leadSignoffSkipped: 'caller_override' }, { note: 'x'.repeat(200_001) }, { note: 'bad\0note' },
    { id: 'x'.repeat(64 * 1024 + 1) }, { timestamp: 'invalid clock' }, { type: 'unknown' },
  ]) expect(() => projectTaskHistory([{ ...event, ...invalid }])).toThrow();
  expect(() => projectTaskHistory([event, event])).toThrow();
  expect(() => projectTaskHistory(Array.from({ length: 4097 }, (_, index) => ({ ...event, id: `TEST-${index}` })))).toThrow();
  expect(() => projectTaskHistory(Array.from({ length: 3 }, (_, index) => ({
    ...event, id: `TEST-${index}`, note: '漢'.repeat(200_000),
  })))).toThrow('Oversized task history');
  expect(() => parseBackendOperation({
    handle, commandId: 'TEST-too-large', operation: 'task.review',
    payload: { taskId: 'TEST-task', action: 'complete', expectedReviewRequestId: 'TEST-cycle', note: 'x'.repeat(200_001) },
  })).toThrow();
  const request = { ...event, type: 'review_requested', from: 'reviewed', to: 'review', reviewer: 'lead' };
  expect(() => projectTaskHistory([{ ...request, stage: 'caller_override' }])).toThrow();
  expect(() => projectTaskHistory([{ ...request, afterReviewRequestId: '' }])).toThrow();
  expect(() => projectTaskHistory([{ ...event, type: 'human_approved', to: 'reviewed' }])).toThrow();
});
