import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();

  const norm = (p: string): string => p.replace(/\\/g, '/');

  const readFile = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });

  const atomicWrite = vi.fn(async (filePath: string, data: string) => {
    files.set(norm(filePath), data);
  });

  return { files, readFile, atomicWrite, norm };
});

vi.mock('fs', () => ({
  promises: {
    readFile: hoisted.readFile,
    mkdir: vi.fn(async () => undefined),
    access: vi.fn(async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
  },
  constants: { F_OK: 0 },
}));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTasksBasePath: () => '/mock/tasks',
}));

vi.mock('../../../../src/main/services/team/atomicWrite', () => ({
  atomicWriteAsync: hoisted.atomicWrite,
}));

import { TeamTaskWriter } from '../../../../src/main/services/team/TeamTaskWriter';

function setTask(teamName: string, id: string, data: Record<string, unknown>): void {
  const taskPath = `/mock/tasks/${teamName}/${id}.json`;
  hoisted.files.set(
    taskPath,
    JSON.stringify({ id, status: 'pending', blocks: [], blockedBy: [], ...data })
  );
}

function getTask(teamName: string, id: string): Record<string, unknown> {
  const taskPath = `/mock/tasks/${teamName}/${id}.json`;
  const raw = hoisted.files.get(taskPath);
  if (!raw) throw new Error(`Task ${id} not found in mock files`);
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('TeamTaskWriter — addRelationship', () => {
  const writer = new TeamTaskWriter();
  const team = 'test-team';

  beforeEach(() => {
    hoisted.files.clear();
    hoisted.readFile.mockClear();
    hoisted.atomicWrite.mockClear();
  });

  describe('blockedBy', () => {
    it('adds blockedBy to task and blocks to target', async () => {
      setTask(team, '1', { subject: 'Setup' });
      setTask(team, '2', { subject: 'Build' });

      await writer.addRelationship(team, '2', '1', 'blockedBy');

      const task2 = getTask(team, '2');
      const task1 = getTask(team, '1');
      expect(task2.blockedBy).toEqual(['1']);
      expect(task1.blocks).toEqual(['2']);
    });

    it('is idempotent — does not duplicate entries', async () => {
      setTask(team, '1', { subject: 'Setup' });
      setTask(team, '2', { subject: 'Build', blockedBy: ['1'] });
      setTask(team, '1', { subject: 'Setup', blocks: ['2'] });

      await writer.addRelationship(team, '2', '1', 'blockedBy');

      const task2 = getTask(team, '2');
      const task1 = getTask(team, '1');
      expect(task2.blockedBy).toEqual(['1']);
      expect(task1.blocks).toEqual(['2']);
    });
  });

  describe('blocks', () => {
    it('delegates to reverse blockedBy', async () => {
      setTask(team, '1', { subject: 'Setup' });
      setTask(team, '2', { subject: 'Build' });

      await writer.addRelationship(team, '1', '2', 'blocks');

      const task1 = getTask(team, '1');
      const task2 = getTask(team, '2');
      expect(task1.blocks).toEqual(['2']);
      expect(task2.blockedBy).toEqual(['1']);
    });
  });

  describe('related', () => {
    it('adds bidirectional related links', async () => {
      setTask(team, '3', { subject: 'Frontend' });
      setTask(team, '4', { subject: 'Backend' });

      await writer.addRelationship(team, '3', '4', 'related');

      const task3 = getTask(team, '3');
      const task4 = getTask(team, '4');
      expect(task3.related).toEqual(['4']);
      expect(task4.related).toEqual(['3']);
    });
  });

  describe('validation', () => {
    it('rejects self-reference', async () => {
      setTask(team, '1', { subject: 'Task' });

      await expect(writer.addRelationship(team, '1', '1', 'blockedBy')).rejects.toThrow(
        'Cannot link a task to itself'
      );
    });

    it('rejects non-existent task', async () => {
      setTask(team, '1', { subject: 'Task' });

      await expect(writer.addRelationship(team, '1', '999', 'blockedBy')).rejects.toThrow(
        'Task not found: 999'
      );
    });

    it('rejects non-existent source task', async () => {
      setTask(team, '1', { subject: 'Task' });

      await expect(writer.addRelationship(team, '999', '1', 'blockedBy')).rejects.toThrow(
        'Task not found: 999'
      );
    });

    it('rejects self-reference via blocks type (delegation preserves check)', async () => {
      setTask(team, '1', { subject: 'Task' });

      await expect(writer.addRelationship(team, '1', '1', 'blocks')).rejects.toThrow(
        'Cannot link a task to itself'
      );
    });

    it('rejects self-reference via related type', async () => {
      setTask(team, '1', { subject: 'Task' });

      await expect(writer.addRelationship(team, '1', '1', 'related')).rejects.toThrow(
        'Cannot link a task to itself'
      );
    });
  });

  describe('circular dependency detection', () => {
    it('detects direct cycle: A blocked-by B, then B blocked-by A', async () => {
      setTask(team, '1', { subject: 'A', blockedBy: ['2'] });
      setTask(team, '2', { subject: 'B', blocks: ['1'] });

      await expect(writer.addRelationship(team, '2', '1', 'blockedBy')).rejects.toThrow(
        'Circular dependency'
      );
    });

    it('allows redundant blockedBy (A→B→C, then C blocked-by A is redundant, not circular)', async () => {
      // #3 already depends on #1 transitively (3→2→1)
      // Adding direct #3 blockedBy #1 is redundant but NOT a cycle
      setTask(team, '1', { subject: 'A' });
      setTask(team, '2', { subject: 'B', blockedBy: ['1'] });
      setTask(team, '3', { subject: 'C', blockedBy: ['2'] });

      // Should succeed — no cycle
      await writer.addRelationship(team, '3', '1', 'blockedBy');
      const task3 = getTask(team, '3');
      expect(task3.blockedBy).toContain('1');
    });

    it('detects transitive cycle when closing the loop', async () => {
      // Chain: #3 blockedBy #2, #2 blockedBy #1
      // Trying: #1 blockedBy #3 — would create cycle 1→3→2→1
      setTask(team, '1', { subject: 'A' });
      setTask(team, '2', { subject: 'B', blockedBy: ['1'] });
      setTask(team, '3', { subject: 'C', blockedBy: ['2'] });

      await expect(writer.addRelationship(team, '1', '3', 'blockedBy')).rejects.toThrow(
        'Circular dependency'
      );
    });
  });
});

describe('TeamTaskWriter — removeRelationship', () => {
  const writer = new TeamTaskWriter();
  const team = 'test-team';

  beforeEach(() => {
    hoisted.files.clear();
    hoisted.readFile.mockClear();
    hoisted.atomicWrite.mockClear();
  });

  describe('blockedBy', () => {
    it('removes blockedBy from task and blocks from target', async () => {
      setTask(team, '1', { subject: 'Setup', blocks: ['2'] });
      setTask(team, '2', { subject: 'Build', blockedBy: ['1'] });

      await writer.removeRelationship(team, '2', '1', 'blockedBy');

      const task2 = getTask(team, '2');
      const task1 = getTask(team, '1');
      expect(task2.blockedBy).toEqual([]);
      expect(task1.blocks).toEqual([]);
    });

    it('handles missing target gracefully', async () => {
      setTask(team, '2', { subject: 'Build', blockedBy: ['1'] });

      await writer.removeRelationship(team, '2', '1', 'blockedBy');

      const task2 = getTask(team, '2');
      expect(task2.blockedBy).toEqual([]);
    });
  });

  describe('blocks', () => {
    it('delegates to reverse blockedBy removal', async () => {
      setTask(team, '1', { subject: 'Setup', blocks: ['2'] });
      setTask(team, '2', { subject: 'Build', blockedBy: ['1'] });

      await writer.removeRelationship(team, '1', '2', 'blocks');

      const task1 = getTask(team, '1');
      const task2 = getTask(team, '2');
      expect(task1.blocks).toEqual([]);
      expect(task2.blockedBy).toEqual([]);
    });
  });

  describe('related', () => {
    it('removes bidirectional related links', async () => {
      setTask(team, '3', { subject: 'Frontend', related: ['4'] });
      setTask(team, '4', { subject: 'Backend', related: ['3'] });

      await writer.removeRelationship(team, '3', '4', 'related');

      const task3 = getTask(team, '3');
      const task4 = getTask(team, '4');
      expect(task3.related).toEqual([]);
      expect(task4.related).toEqual([]);
    });

    it('handles missing target gracefully', async () => {
      setTask(team, '3', { subject: 'Frontend', related: ['4'] });

      await writer.removeRelationship(team, '3', '4', 'related');

      const task3 = getTask(team, '3');
      expect(task3.related).toEqual([]);
    });
  });

  describe('validation', () => {
    it('rejects non-existent source task', async () => {
      await expect(writer.removeRelationship(team, '999', '1', 'blockedBy')).rejects.toThrow(
        'Task not found: 999'
      );
    });

    it('is a no-op when removing a relationship that does not exist', async () => {
      setTask(team, '1', { subject: 'A', blocks: ['3'] });
      setTask(team, '2', { subject: 'B' });

      // Task 1 has no blockedBy referencing task 2 — should not throw
      await writer.removeRelationship(team, '1', '2', 'blockedBy');

      const task1 = getTask(team, '1');
      expect(task1.blockedBy).toEqual([]);
      expect(task1.blocks).toEqual(['3']); // other relationships preserved
    });
  });
});
