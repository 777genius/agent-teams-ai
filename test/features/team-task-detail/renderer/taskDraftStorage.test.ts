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
