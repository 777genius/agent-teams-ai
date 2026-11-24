import { createTaskDraftStorage } from '@features/team-task-detail/renderer/adapters/taskDraftStorage';
import { describe, expect, it } from 'vitest';

import type { TaskDetailIdentity } from '@features/team-task-detail/contracts';
import type { InlineChip } from '@shared/types/inlineChip';

const identity: TaskDetailIdentity = { contextId: 'local', teamName: 'team-a', taskId: '1' };
const chip: InlineChip = {
  id: 'chip-1',
  filePath: '/TEST/project/file.ts',
  fileName: 'file.ts',
  fromLine: 2,
  toLine: 4,
  codeText: 'const value = 42;',
  language: 'typescript',
  displayPath: 'src/file.ts',
  isFolder: false,
};

function repository(initial: [string, string][] = []) {
  const values = new Map(initial);
  return {
    values,
    async saveDraft(key: string, value: string) {
      values.set(key, value);
    },
    async loadDraft(key: string) {
      return values.get(key) ?? null;
    },
    async deleteDraft(key: string) {
      values.delete(key);
    },
  };
}

describe('task draft persistence races', () => {
  it('persists the exact clarification cycle with a draft across restart and never binds legacy text', async () => {
    const repo = repository();
    const id = 'c94c9a38-d68a-4cc8-acf1-c8025311a342';
    const storage = createTaskDraftStorage(repo);
    await storage.save(identity, { text: 'Use PostgreSQL', answerClarificationRequestId: id });
    const restarted = createTaskDraftStorage(repo);
    expect(await restarted.hydrate(identity)).toMatchObject({
      text: 'Use PostgreSQL', answerClarificationRequestId: id,
    });

    await restarted.save(identity, { text: '', answerClarificationRequestId: undefined });
    expect((await restarted.hydrate(identity)).answerClarificationRequestId).toBeUndefined();

    await restarted.save(identity, { text: 'Old pre-feature comment' });
    expect((await restarted.hydrate(identity)).answerClarificationRequestId).toBeNull();
  });

  it('never restores text from one clarification with the ID of another after a failed write', async () => {
    const repo = repository();
    const cycleA = '8458fa4c-89f9-4ff3-954b-8fbdc372e95a';
    const cycleB = 'c0bdcb38-b42c-475d-916f-745da9f7ea8c';
    const first = createTaskDraftStorage(repo);
    await first.save(identity, { text: 'Answer to A', answerClarificationRequestId: cycleA });

    let rejectBundle = true;
    const interrupted = createTaskDraftStorage({
      ...repo,
      async saveDraft(key, value) {
        if (key.includes('task-comment-bundle') && rejectBundle) {
          rejectBundle = false;
          throw new Error('simulated draft save failure');
        }
        await repo.saveDraft(key, value);
      },
    });
    await expect(interrupted.save(identity, {
      text: 'Answer to B', answerClarificationRequestId: cycleB,
    })).rejects.toThrow('simulated draft save failure');
    expect(await createTaskDraftStorage(repo).hydrate(identity)).toMatchObject({
      text: 'Answer to A', answerClarificationRequestId: cycleA,
    });

    await interrupted.save(identity, { text: 'Answer to B', answerClarificationRequestId: cycleB });
    expect(await createTaskDraftStorage(repo).hydrate(identity)).toMatchObject({
      text: 'Answer to B', answerClarificationRequestId: cycleB,
    });
  });

  it('preserves text and rich chips from successive partial writes', async () => {
    const storage = createTaskDraftStorage(repository());
    await Promise.all([
      storage.save(identity, { text: 'unsent comment' }),
      storage.save(identity, { commentChips: [chip] }),
    ]);
    const restored = await storage.hydrate(identity);
    expect(restored.text).toBe('unsent comment');
    expect(restored.commentChips).toEqual([chip]);
  });

  it('hydrates legacy drafts only in local context and preserves an explicit new empty draft', async () => {
    const repo = repository([
      ['taskComment:team-a:1', 'legacy comment'],
      ['taskCommentChips:team-a:1', JSON.stringify([chip])],
    ]);
    const storage = createTaskDraftStorage(repo);
    const legacy = await storage.hydrate(identity);
    expect(legacy.text).toBe('legacy comment');
    expect(legacy.commentChips).toEqual([chip]);
    const foreign = await storage.hydrate({ ...identity, contextId: 'remote-test' });
    expect(foreign.text).toBeNull();
    expect(foreign.commentChips).toBeNull();

    await storage.save(identity, { text: '', commentChips: [] });
    const cleared = await storage.hydrate(identity);
    expect(cleared.text).toBe('');
    expect(cleared.commentChips).toEqual([]);
    expect(repo.values.get('taskComment:team-a:1')).toBe('legacy comment');
  });

  it('serializes clear after an in-flight save and prevents legacy resurrection', async () => {
    const repo = repository([['taskComment:team-a:1', 'older legacy comment']]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    const storage = createTaskDraftStorage({
      ...repo,
      async saveDraft(key, value) {
        if (first) {
          first = false;
          started();
          await gate;
        }
        await repo.saveDraft(key, value);
      },
    });
    const write = storage.save(identity, { text: 'in-flight draft', commentChips: [chip] });
    await saving;
    const clear = storage.clear(identity);
    release();
    await Promise.all([write, clear]);
    const restored = await storage.hydrate(identity);
    expect(restored.text === null || restored.text === '').toBe(true);
    expect(restored.commentChips === null || restored.commentChips.length === 0).toBe(true);
    expect(repo.values.has('taskComment:team-a:1')).toBe(false);
  });
});
