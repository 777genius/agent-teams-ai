// @vitest-environment node
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { readKanbanState, writeKanbanState } = require(
  '../../../agent-teams-controller/src/internal/kanbanStore.js'
) as {
  readKanbanState(
    paths: { kanbanPath: string },
    name: string,
    options?: { strict?: boolean }
  ): { tasks: Record<string, unknown>; columnOrder?: Record<string, string[]> };
  writeKanbanState(
    paths: { kanbanPath: string }, name: string, value: unknown
  ): void;
};

it('retains safety validation on a valid persisted board beyond the old 512 KiB ceiling', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-kanban-safety-large-')));
  try {
    const paths = { kanbanPath: join(root, 'kanban-state.json') };
    const ids = Array.from({ length: 6000 }, (_, i) => 'TEST-task-' + i);
    const state = {
      teamName: 'test-team',
      reviewers: ['alice'],
      tasks: Object.fromEntries(ids.map((id) => [id, {
        column: 'approved',
        movedAt: '2026-01-01T00:00:00.000Z',
        errorDescription: 'retained-' + 'x'.repeat(48),
      }])),
      columnOrder: { approved: ids },
    };
    writeKanbanState(paths, 'test-team', state);
    expect(statSync(paths.kanbanPath).size).toBeGreaterThan(512 * 1024);
    const strict = readKanbanState(paths, 'test-team', { strict: true });
    expect(Object.keys(strict.tasks)).toHaveLength(6000);
    expect(strict.columnOrder?.approved).toEqual(ids);
    expect(strict).toEqual(readKanbanState(paths, 'test-team'));
    const corrupted = JSON.parse(readFileSync(paths.kanbanPath, 'utf8'));
    corrupted.tasks[ids[0]!].column = 'foreign';
    writeFileSync(paths.kanbanPath, JSON.stringify(corrupted));
    expect(() => readKanbanState(paths, 'test-team', { strict: true })).toThrow(
      'Kanban safety state is corrupt'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
