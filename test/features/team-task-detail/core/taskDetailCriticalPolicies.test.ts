import { describe, expect, it, vi } from 'vitest';

import {
  applyTaskDetailCompact,
  beginTaskDetailSave,
  beginTaskDetailSubmit,
  commitTaskDetailFull,
  completeTaskDetailSave,
  completeTaskDetailSubmit,
  createTaskDetailReadAuthority,
  createTaskDetailReadEntry,
  type TaskDetailReadToken,
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

const fullTask = (taskId: string, suffix: string): TeamTaskWithKanban =>
  ({
    id: taskId,
    subject: `subject-${suffix}`,
    description: `description-${suffix}`,
    prompt: `prompt-${suffix}`,
    status: 'in_progress',
    comments: [{ id: 'comment-1', text: `comment-${suffix}` }],
    kanbanColumn: 'approved',
    reviewer: `reviewer-${suffix}`,
    changePresence: 'has_changes',
  }) as unknown as TeamTaskWithKanban;

describe('task detail critical read policies', () => {
  it('joins only the same origin scope and shares exact physical provenance', async () => {
    const authority = createTaskDetailReadAuthority();
    const first = deferred<string>();
    const second = deferred<string>();
    const read = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
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
    expect(successorA.token.sourceEpoch).toBe(2);
    expect(successorA.token.serial).toBeGreaterThan(first.token.serial);

    xFirst.resolve('X-stale');
    expect(await first.result).toMatchObject({ value: 'X-stale' });
    expect(readX).toHaveBeenCalledTimes(2);
    xSuccessor.resolve('X-current');
    y.resolve('Y-current');
    expect(await successorA.result).toMatchObject({ token: successorA.token, value: 'X-current' });
    expect(await successorB.result).toMatchObject({ token: successorB.token, value: 'X-current' });
    expect(await yHandle.result).toMatchObject({ token: yHandle.token, value: 'Y-current' });
  });

  it('does not let a late compact S0 overwrite a newer full S1 or remove full tails', () => {
    const identity = { contextId: 'local', teamName: 'shared-team', taskId: 'X' };
    const scope = { ...identity, contextEpoch: 1, teamStateEpoch: 1 };
    const fullToken: TaskDetailReadToken = {
      resource: 'full',
      key: 'full:["local","shared-team","X"]',
      sourceEpoch: 1,
      serial: 20,
      scope,
    };
    const compactToken: TaskDetailReadToken = {
      ...fullToken,
      resource: 'snapshot',
      key: 'snapshot:["local","shared-team"]',
      serial: 10,
    };
    let entry = createTaskDetailReadEntry(identity);
    entry = commitTaskDetailFull(entry, fullToken, fullTask('X', 'S1'));
    const fullBeforeCompact = entry.full;

    const lateCompact = applyTaskDetailCompact(
      entry,
      {
        ...fullTask('X', 'S0'),
        kanbanColumn: 'review',
        reviewer: 'reviewer-S0',
        changePresence: 'no_changes',
      },
      compactToken
    );

    expect(lateCompact).toBe(entry);
    expect(lateCompact.full).toBe(fullBeforeCompact);
    expect(lateCompact.full).toMatchObject({
      description: 'description-S1',
      prompt: 'prompt-S1',
      kanbanColumn: 'approved',
      reviewer: 'reviewer-S1',
      changePresence: 'has_changes',
    });
    expect(applyTaskDetailCompact(entry, undefined, compactToken)).toBe(entry);
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
