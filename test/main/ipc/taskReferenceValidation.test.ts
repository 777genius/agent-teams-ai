import { describe, expect, it } from 'vitest';

import { validateTaskRefs } from '../../../src/main/ipc/teams/taskReferenceValidation';

const taskRef = { taskId: 'task-1', displayId: 'abcd1234', teamName: 'test-team' };

describe('structured task reference IPC validation', () => {
  it.each([{ value: undefined }, { value: [] }])(
    'preserves omitted or empty references ($value)',
    ({ value }) => {
      expect(validateTaskRefs(value)).toEqual({ valid: true, value });
    }
  );

  it('trims reference fields while preserving order and duplicates without mutating input', () => {
    const first = Object.freeze({
      taskId: ' task-1 ',
      displayId: ' abcd1234 ',
      teamName: ' test-team ',
      extra: 'ignored',
    });
    const second = Object.freeze({ ...taskRef, taskId: 'task-2', displayId: 'efgh5678' });
    const value = Object.freeze([first, second, first]);

    expect(validateTaskRefs(value)).toEqual({
      valid: true,
      value: [taskRef, second, taskRef],
    });
    expect(first.taskId).toBe(' task-1 ');
  });

  it.each([
    ['null instead of an array', null, 'taskRefs must be an array'],
    ['an object instead of an array', taskRef, 'taskRefs must be an array'],
    ['a null entry', [null], 'taskRefs entries must be objects'],
    ['a string entry', ['task-1'], 'taskRefs entries must be objects'],
    [
      'a missing task ID',
      [{ displayId: taskRef.displayId, teamName: taskRef.teamName }],
      'Each taskRef must include taskId, displayId, and teamName',
    ],
    [
      'a blank display ID',
      [{ ...taskRef, displayId: ' ' }],
      'Each taskRef must include taskId, displayId, and teamName',
    ],
    [
      'a non-string team name',
      [{ ...taskRef, teamName: 1 }],
      'Each taskRef must include taskId, displayId, and teamName',
    ],
    [
      'task path traversal',
      [{ ...taskRef, taskId: '../escape' }],
      'taskId contains invalid characters',
    ],
    [
      'an overlong task ID',
      [{ ...taskRef, taskId: 'a'.repeat(65) }],
      'taskId exceeds max length (64)',
    ],
    [
      'a Windows-reserved task ID',
      [{ ...taskRef, taskId: 'CON' }],
      'taskId is reserved on Windows',
    ],
    [
      'team path traversal',
      [{ ...taskRef, teamName: '../escape' }],
      'teamName contains invalid characters',
    ],
    [
      'a noncanonical team name',
      [{ ...taskRef, teamName: 'Mixed-Team' }],
      'teamName contains invalid characters',
    ],
    [
      'an overlong team name',
      [{ ...taskRef, teamName: 'a'.repeat(129) }],
      'teamName exceeds max length (128)',
    ],
    [
      'a Windows-reserved team name',
      [{ ...taskRef, teamName: 'con' }],
      'teamName is reserved on Windows',
    ],
  ])('rejects %s', (_description, value, error) => {
    expect(validateTaskRefs(value)).toEqual({ valid: false, error });
  });

  it('rejects the whole request when a later reference is malformed', () => {
    expect(validateTaskRefs([taskRef, { ...taskRef, teamName: '../escape' }])).toEqual({
      valid: false,
      error: 'teamName contains invalid characters',
    });
  });
});
