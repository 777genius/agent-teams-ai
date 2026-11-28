import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateTeamCommand } from '../dist/team/validateTeamCommand.js';
import { TeamOwnerError } from '../dist/team/contracts.js';

import type { TeamCommand } from '../dist/team/contracts.js';

test('reject NUL text before persisting any original Host command intent', () => {
  const invalid: TeamCommand[] = [
    { commandId: 'TEST-create', operation: 'task.create',
      payload: { subject: 'safe', description: 'invalid\u0000description' } },
    { commandId: 'TEST-update', operation: 'task.update',
      payload: { taskId: 'TEST-task', description: 'invalid\u0000edit' } },
    { commandId: 'TEST-comment', operation: 'task.comment',
      payload: { taskId: 'TEST-task', text: 'invalid\u0000comment' } },
    { commandId: 'TEST-message', operation: 'message.send',
      payload: { to: 'alice', text: 'invalid\u0000message' } },
  ];
  for (const command of invalid) {
    assert.throws(() => validateTeamCommand(command),
      (error) => error instanceof TeamOwnerError && error.code === 'invalid');
  }
  assert.doesNotThrow(() => validateTeamCommand({
    commandId: 'TEST-valid', operation: 'task.create',
    payload: { subject: 'Valid Unicode', description: '漢字\nmultiline' },
  }));
});
