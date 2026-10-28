import { expect, it } from 'vitest';

import { projectTaskPersistenceDifference } from '../../scripts/e2e/opencode-diagnostics/task-persistence';

it('reports changed persistence fields without exposing task data or arbitrary keys', () => {
  const before = { owner: 'alice', status: 'in_progress', comments: [], updatedAt: 'before', SECRET_KEY: 'before' };
  const after = { ...before, comments: [{ text: 'SECRET_BODY' }], updatedAt: 'after', SECRET_KEY: 'after' };
  const result = projectTaskPersistenceDifference(before, after);
  expect(result).toEqual({ changedFields: ['updatedAt', 'comments'], otherChangedFieldCount: 1,
    commentCountBefore: 0, commentCountAfter: 1 });
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(projectTaskPersistenceDifference(after, structuredClone(after)).changedFields).toEqual([]);
});
