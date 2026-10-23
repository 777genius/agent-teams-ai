import { describe, expect, it } from 'vitest';

import {
  realTaskPrompt,
  verificationInstruction,
} from '../../scripts/e2e/opencode-native-real-task-prompts';

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

describe('native verification command contract', () => {
  const command = '"C:\\testnode.exe" "C:\\TEST-x\\alice-verify.cjs"';
  const instruction = verificationInstruction(command);

  it('supplies the literal command and forbids substitution or a self-printed marker', () => {
    expect(instruction).toContain(command);
    expect(instruction).toContain('Do not substitute a relative path');
    expect(instruction).toContain('print its marker yourself');
    expect(instruction).toContain('never counts as the marker');
  });

  it('defines the step as done only when the identical command exits zero with its own marker', () => {
    expect(instruction).toContain('that exact command exits zero');
    expect(instruction).toContain('its own output prints the marker line');
  });

  it('demands fixing only your own file and re-running the identical command', () => {
    expect(instruction).toContain('fix only your file');
    expect(instruction).toContain('execute this identical command again');
    expect(instruction).toContain('never alter, wrap, cd around or re-spell the command');
  });

  it('overrides the generic fix-its-arguments advice for this supplied command', () => {
    expect(instruction).toContain('Its arguments are already correct');
    const prompt = realTaskPrompt({
      base: 'BASE_INSTRUCTIONS',
      teamName: 'TEST-TEAM',
      owner: 'alice',
      commentToken: 'TASK_COMMENT:11111111-2222-3333-4444-555555555555',
      work: [verificationInstruction(command)],
    });
    expect(prompt.indexOf('execute this identical command again')).toBeLessThan(
      prompt.indexOf('Completion protocol')
    );
    expect(prompt.indexOf('Completion protocol')).toBeGreaterThan(-1);
  });
});
