import { describe, expect, it } from 'vitest';

import { realTaskPrompt } from '../../scripts/e2e/opencode-native-real-task-prompts';

describe('native real-task prompt contract', () => {
  const commentToken = 'TASK_COMMENT:11111111-2222-3333-4444-555555555555';
  const prompt = realTaskPrompt({
    base: 'BASE_INSTRUCTIONS',
    teamName: 'TEST-TEAM',
    owner: 'bob',
    commentToken,
    work: ['WORK_STEP_ONE', 'WORK_STEP_TWO'],
  });

  it('spells exact copyable arguments for the durable comment call', () => {
    const match = prompt.match(/\{"tool":"task_add_comment"[^{}]*\}/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![0])).toEqual({
      tool: 'task_add_comment',
      teamName: 'TEST-TEAM',
      taskId: "<this task's id>",
      from: 'bob',
      text: commentToken,
    });
  });

  it('spells exact copyable arguments for task_complete', () => {
    const match = prompt.match(/\{"tool":"task_complete"[^{}]*\}/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![0])).toEqual({
      tool: 'task_complete',
      teamName: 'TEST-TEAM',
      taskId: "<this task's id>",
      actor: 'bob',
    });
  });

  it('demands the comment token byte-for-byte and rejects other text', () => {
    expect(prompt).toContain('byte-for-byte');
    expect(prompt).toContain(commentToken);
  });

  it('forbids task_complete before the work and the exact comment', () => {
    expect(prompt).toContain('Never call task_complete before');
  });

  it('requires retrying failed tool calls before finishing', () => {
    expect(prompt).toContain('fix its arguments and call it again');
  });

  it('puts task work before the completion protocol', () => {
    expect(prompt.indexOf('WORK_STEP_ONE')).toBeLessThan(prompt.indexOf('Completion protocol'));
    expect(prompt.indexOf('WORK_STEP_TWO')).toBeLessThan(prompt.indexOf('Completion protocol'));
    expect(prompt.indexOf('Completion protocol')).toBeGreaterThan(-1);
  });
});
