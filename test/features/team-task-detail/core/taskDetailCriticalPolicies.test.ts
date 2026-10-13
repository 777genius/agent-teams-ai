import { describe, expect, it, vi } from 'vitest';

import { createTaskDetailReadAuthority } from '../../../../src/features/team-task-detail/core/application/taskDetailReadAuthority';
import {
  applyTaskDetailCompact,
  beginTaskDetailSave,
  beginTaskDetailSubmit,
  commitTaskDetailFull,
  completeTaskDetailSave,
  completeTaskDetailSubmit,
  createTaskDetailReadEntry,
  EMPTY_TASK_DETAIL_SESSION,
  updateTaskDetailPart,
} from '../../../../src/features/team-task-detail/core/domain';

import type { TaskDetailSaveRevision } from '../../../../src/features/team-task-detail/contracts';
import type { TeamTaskWithKanban } from '../../../../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

const fullTask = (taskId: string, suffix: string): TeamTaskWithKanban => ({
  id: taskId,
  subject: `subject-${suffix}`,
  description: `description-${suffix}`,
  prompt: `prompt-${suffix}`,
  status: 'in_progress',
  comments: [
    {
      id: 'comment-1',
      text: `comment-${suffix}`,
      author: 'lead',
      createdAt: '2026-10-13T12:00:00Z',
      type: 'regular',
    },
  ],
  kanbanColumn: 'approved',
  reviewer: `reviewer-${suffix}`,
  changePresence: 'has_changes',
});

describe('task detail critical read policies', () => {
  it('joins only the same origin scope and shares exact physical provenance', async () => {
    const authority = createTaskDetailReadAuthority();
    const first = deferred<string>();
    const second = deferred<string>();
    const afterSettled = deferred<string>();
    const read = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(afterSettled.promise);
    const base = {
      contextId: 'local',
      teamName: 'shared-team',
      contextEpoch: 4,
      teamStateEpoch: 7,
    };
    const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };

    const joined = authority.readFull(identity, base, read);
    const duplicate = authority.readFull(identity, base, read);
    const otherContext = authority.readFull(identity, { ...base, contextId: 'remote' }, read);

    expect(read).toHaveBeenCalledTimes(2);
    expect(duplicate.token).toBe(joined.token);
    expect(otherContext.token).not.toBe(joined.token);
    first.resolve('X-first');
    second.resolve('X-remote');
    expect((await duplicate.result).token).toBe(joined.token);
    expect((await duplicate.result).value).toBe('X-first');
    const afterSettledRead = authority.readFull(identity, base, read);
    expect(read).toHaveBeenCalledTimes(3);
    expect(afterSettledRead.token).not.toBe(joined.token);
    afterSettled.resolve('X-after-settled');
    expect((await afterSettledRead.result).value).toBe('X-after-settled');
  });

  it('shares one physical provenance across forceNew overlap without extra transport starts', async () => {
    const authority = createTaskDetailReadAuthority();
    const transport = deferred<string>();
    const scope = {
      contextId: 'local',
      teamName: 'shared-team',
      contextEpoch: 1,
      teamStateEpoch: 1,
    };
    let physicalStarts = 0;
    const read = vi.fn((_token: unknown, markPhysicalStart: () => void) => {
      if (physicalStarts === 0) {
        physicalStarts += 1;
        markPhysicalStart();
      }
      return transport.promise;
    });
    const first = authority.readSnapshot('shared-team', scope, read, {
      mode: 'full',
      deferPhysicalStart: true,
    });
    const overlap = authority.readSnapshot('shared-team', scope, read, {
      mode: 'full',
      deferPhysicalStart: true,
      forceNew: true,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(physicalStarts).toBe(1);
    expect(overlap.token.physicalStartOrder).toBe(first.token.physicalStartOrder);
    transport.resolve('shared-current');
    expect((await first.result).token.physicalStartOrder).toBe(first.token.physicalStartOrder);
    expect((await overlap.result).token.physicalStartOrder).toBe(first.token.physicalStartOrder);
  });

  it('coalesces repeated invalidation to one after-settle successor and keeps X/Y independent', async () => {
    const authority = createTaskDetailReadAuthority();
    const xFirst = deferred<string>();
    const xSuccessor = deferred<string>();
    const y = deferred<string>();
    const readX = vi
      .fn()
      .mockReturnValueOnce(xFirst.promise)
      .mockReturnValueOnce(xSuccessor.promise);
    const readY = vi.fn(() => y.promise);
    const scope = {
      contextId: 'local',
      teamName: 'shared-team',
      contextEpoch: 1,
      teamStateEpoch: 1,
    };
    const identityX = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
    const identityY = { contextId: 'local', teamName: 'shared-team', taskId: 'Y' };

    const first = authority.readFull(identityX, scope, readX);
    const yHandle = authority.readFull(identityY, scope, readY);
    authority.invalidateFull(identityX);
    authority.invalidateFull(identityX);
    const successorA = authority.readFull(identityX, scope, readX);
    const successorB = authority.readFull(identityX, scope, readX);

    expect(readX).toHaveBeenCalledTimes(1);
    expect(readY).toHaveBeenCalledTimes(1);
    expect(successorA.token).toBe(successorB.token);
    expect(successorA.token.sourceEpoch).toBe(3);
    expect(successorA.token.serial).toBeGreaterThan(first.token.serial);
    expect(successorA.token.physicalStartOrder).toBe(0);

    xFirst.resolve('X-stale');
    expect(await first.result).toMatchObject({ value: 'X-stale' });
    expect(readX).toHaveBeenCalledTimes(2);
    expect(successorA.token.physicalStartOrder).toBeGreaterThan(0);
    xSuccessor.resolve('X-current');
    y.resolve('Y-current');
    expect(await successorA.result).toMatchObject({ token: successorA.token, value: 'X-current' });
    expect(await successorB.result).toMatchObject({ token: successorB.token, value: 'X-current' });
    expect(await yHandle.result).toMatchObject({ token: yHandle.token, value: 'Y-current' });
  });

  it('does not let a late compact S0 overwrite a newer full S1 or remove full tails', async () => {
    const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
    const scope = { ...identity, contextEpoch: 1, teamStateEpoch: 1 };
    const authority = createTaskDetailReadAuthority();
    const compactResult = deferred<TeamTaskWithKanban>();
    const fullResult = deferred<TeamTaskWithKanban>();
    const compactRead = authority.readSnapshot(
      identity.teamName,
      scope,
      async (_token, markPhysicalStart) => {
        markPhysicalStart();
        return compactResult.promise;
      },
      { mode: 'thin', deferPhysicalStart: true }
    );
    const fullRead = authority.readFull(identity, scope, async () => fullResult.promise);
    let entry = createTaskDetailReadEntry(identity);
    fullResult.resolve({
      ...fullTask('X', 'S1'),
      description: 'D'.repeat(2_000) + 'description-S1-tail',
      prompt: 'P'.repeat(2_000) + 'prompt-S1-tail',
      comments: [
        {
          id: 'comment-1',
          text: 'C'.repeat(120) + 'comment-S1-tail',
          author: 'lead',
          createdAt: '2026-10-13T12:00:00Z',
          type: 'regular',
        },
      ],
      historyEvents: [
        {
          id: 'history-1',
          timestamp: '2026-10-13T12:00:00Z',
          type: 'review_requested',
          from: 'none',
          to: 'review',
          note: 'H'.repeat(500) + 'history-S1-tail',
        },
      ],
      sourceMessage: {
        text: 'M'.repeat(1_000) + 'source-S1-tail',
        from: 'user',
        timestamp: '2026-10-13T12:00:00Z',
      },
    });
    const completedFull = await fullRead.result;
    entry = commitTaskDetailFull(
      entry,
      completedFull.token,
      completedFull.value as TeamTaskWithKanban
    );
    const fullBeforeCompact = entry.full;

    compactResult.resolve({
      ...fullTask('X', 'S0'),
      description: 'D'.repeat(2_000),
      prompt: 'P'.repeat(2_000),
      comments: [
        {
          id: 'comment-1',
          text: 'C'.repeat(120),
          author: 'lead',
          createdAt: '2026-10-13T12:00:00Z',
          type: 'regular',
        },
      ],
      kanbanColumn: 'review',
      reviewer: 'reviewer-S0',
      changePresence: 'no_changes',
    });
    const completedCompact = await compactRead.result;
    const lateCompact = applyTaskDetailCompact(
      entry,
      completedCompact.value as TeamTaskWithKanban,
      completedCompact.token
    );

    expect(lateCompact).toBe(entry);
    expect(lateCompact.full).toBe(fullBeforeCompact);
    expect(lateCompact.full).toMatchObject({
      subject: 'subject-S1',
      description: 'D'.repeat(2_000) + 'description-S1-tail',
      prompt: 'P'.repeat(2_000) + 'prompt-S1-tail',
      comments: [{ id: 'comment-1', text: 'C'.repeat(120) + 'comment-S1-tail' }],
      historyEvents: [{ id: 'history-1', note: 'H'.repeat(500) + 'history-S1-tail' }],
      sourceMessage: { text: 'M'.repeat(1_000) + 'source-S1-tail' },
      kanbanColumn: 'approved',
      reviewer: 'reviewer-S1',
      changePresence: 'has_changes',
    });
    expect(applyTaskDetailCompact(entry, undefined, completedCompact.token)).toBe(entry);
    expect(authority.isTokenCurrent(completedFull.token, scope)).toBe(true);
    authority.invalidateFull(identity);
    expect(authority.isTokenCurrent(completedFull.token, scope)).toBe(false);
  });

  it('orders a queued snapshot by physical start, not request metadata', async () => {
    const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
    const scope = { ...identity, contextEpoch: 1, teamStateEpoch: 1 };
    const authority = createTaskDetailReadAuthority();
    const compactResult = deferred<TeamTaskWithKanban>();
    const fullResult = deferred<TeamTaskWithKanban>();
    let markCompactPhysicalStart!: () => void;
    const compactRead = authority.readSnapshot(
      identity.teamName,
      scope,
      async (_token, markPhysicalStart) => {
        markCompactPhysicalStart = markPhysicalStart;
        return compactResult.promise;
      },
      { mode: 'thin', deferPhysicalStart: true }
    );
    expect(compactRead.token.physicalStartOrder).toBe(0);

    const fullRead = authority.readFull(identity, scope, async () => fullResult.promise);
    fullResult.resolve(fullTask('X', 'full-later'));
    const completedFull = await fullRead.result;
    let entry = commitTaskDetailFull(
      createTaskDetailReadEntry(identity),
      completedFull.token,
      completedFull.value as TeamTaskWithKanban
    );

    markCompactPhysicalStart();
    compactResult.resolve({
      ...fullTask('X', 'compact-later'),
      kanbanColumn: 'review',
      reviewer: 'reviewer-later',
      changePresence: 'no_changes',
    });
    const completedCompact = await compactRead.result;
    expect(completedCompact.token.physicalStartOrder).toBeGreaterThan(
      completedFull.token.physicalStartOrder
    );
    entry = applyTaskDetailCompact(
      entry,
      completedCompact.value as TeamTaskWithKanban,
      completedCompact.token
    );
    expect(entry.full).toMatchObject({
      subject: 'subject-full-later',
      description: 'description-full-later',
      prompt: 'prompt-full-later',
      kanbanColumn: 'review',
      reviewer: 'reviewer-later',
      changePresence: 'no_changes',
    });
  });

  it('keeps the newer A value through a literal submit A/B/A race', () => {
    let session = updateTaskDetailPart(EMPTY_TASK_DETAIL_SESSION, 'commentText', 'A');
    session = beginTaskDetailSubmit(session, {
      commentText: 'A',
      commentChips: [],
      pendingAttachments: [],
      reply: null,
    });
    const submitRevision = session.submitRevision;
    session = updateTaskDetailPart(session, 'commentText', 'B');
    session = updateTaskDetailPart(session, 'commentText', 'A');
    session = completeTaskDetailSubmit(session, submitRevision);
    expect(session.commentText).toBe('A');
    expect(session.partRevisions.commentText).toBe(3);
  });

  it('clears only submitted parts with per-part revisions and isolates overlapping saves', () => {
    let session = beginTaskDetailSubmit(
      {
        commentText: 'stale comment',
        commentChips: ['stale chip'],
        pendingAttachments: [],
        reply: { taskId: 'X', author: 'lead', text: 'stale reply' },
        subjectDraft: 'draft subject',
        descriptionDraft: 'draft description',
        editingSubject: true,
        editingDescription: true,
        editRevision: 0,
        partRevisions: {
          commentText: 1,
          commentChips: 1,
          pendingAttachments: 0,
          reply: 1,
          subject: 1,
          description: 1,
        },
        submitRevision: 0,
        submittedPartRevisions: null,
        saveRevisionByPart: { subject: 0, description: 0 },
        savedPartRevisionByPart: { subject: null, description: null },
        inlineEditOwnerSurfaceId: null,
        ownerSurfaceId: null,
        ownerRevision: 0,
      },
      {
        commentText: 'stale comment',
        commentChips: ['stale chip'],
        pendingAttachments: [],
        reply: { taskId: 'X', author: 'lead', text: 'stale reply' },
      }
    );
    const submitRevision = session.submitRevision;
    session = updateTaskDetailPart(session, 'commentText', 'new comment');
    session = completeTaskDetailSubmit(session, submitRevision);

    expect(session.commentText).toBe('new comment');
    expect(session.commentChips).toEqual([]);
    expect(session.reply).toBeNull();
    expect(session.partRevisions).toMatchObject({
      commentText: 2,
      commentChips: 2,
      reply: 2,
      subject: 1,
      description: 1,
    });

    const duplicate = completeTaskDetailSubmit(session, submitRevision);
    expect(duplicate).toBe(session);

    session = beginTaskDetailSave(session, ['subject']);
    const subjectSave: TaskDetailSaveRevision = { subject: session.saveRevisionByPart.subject };
    session = beginTaskDetailSave(session, ['description']);
    const descriptionSave: TaskDetailSaveRevision = {
      description: session.saveRevisionByPart.description,
    };
    session = updateTaskDetailPart(session, 'description', 'newer description');
    session = completeTaskDetailSave(session, subjectSave);
    expect(session.editingSubject).toBe(false);
    expect(session.editingDescription).toBe(true);
    session = completeTaskDetailSave(session, descriptionSave);
    expect(session.editingDescription).toBe(true);
    expect(session.partRevisions.description).toBe(2);
    expect(session.partRevisions.subject).toBe(1);
  });
});
