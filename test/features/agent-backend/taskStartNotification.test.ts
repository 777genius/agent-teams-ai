// @vitest-environment node
import { createHash } from 'node:crypto';

import { protocols } from 'agent-teams-controller';
import { describe, expect, it } from 'vitest';

// Captured from the exact pre-edit Desktop helper bodies, before the portable extraction.
const frozenHashes = {
  user: 'a38d9e1087944a1f0da5c77bace8fbd55f96ce77b5b4d7d7022f376a11c2ab18',
  legacy: '8a98c5fe2dd9cb82c10cfd87148cc0f15995fd25fa7f19fb6fb7007c787c060f',
};

describe('portable task start notification', () => {
  it('preserves exact existing user and legacy content, sender, refs and whitespace handling', () => {
    const task = {
      id: 'TEST-task',
      subject: 'Task title',
      owner: 'alice',
      description: '  Details  ',
      prompt: '  Instructions  ',
      descriptionTaskRefs: [{ taskId: 'TEST-ref', displayId: '2', teamName: 'TEST-team' }],
    };
    for (const mode of ['user', 'legacy'] as const) {
      const message = protocols.buildTaskStartNotification('TEST-team', task, '#1', mode, 'lead');
      expect(createHash('sha256').update(JSON.stringify(message)).digest('hex')).toBe(
        frozenHashes[mode]
      );
    }
  });
});
