import { describe, it, expect } from 'vitest';
import { registerAllTools } from '../../src/tools/index.js';
import { createMockRunner, createMockServer } from './test-helpers.js';

describe('registerAllTools', () => {
  it('registers exactly 13 tools', () => {
    const runner = createMockRunner({ stdout: '', stderr: '', exitCode: 0 });
    const { server, tools } = createMockServer();
    registerAllTools(server, runner);
    expect(tools.size).toBe(13);
  });

  it('registers all expected tool names', () => {
    const runner = createMockRunner({ stdout: '', stderr: '', exitCode: 0 });
    const { server, tools } = createMockServer();
    registerAllTools(server, runner);

    const expected = [
      'task_create', 'task_set_status', 'task_set_owner',
      'task_get', 'task_list', 'task_comment', 'task_link',
      'task_briefing', 'task_attach', 'kanban_move',
      'kanban_reviewers', 'review_action', 'message_send',
    ];
    for (const name of expected) {
      expect(tools.has(name), `missing tool: ${name}`).toBe(true);
    }
  });
});
