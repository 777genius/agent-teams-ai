import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  realTaskPrompt,
  verificationInstruction,
  windowsVerificationCommand,
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
    expect(prompt).toContain('final two actions must be task_add_comment then task_complete');
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
    expect(instruction).toContain('Never create or edit *-result.txt yourself');
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

describe('cross-shell Windows verifier invocation', () => {
  it.skipIf(process.platform !== 'win32')('executes the unchanged verifier in PowerShell and cmd', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'TEST-command-'));
    try {
      const verifier = path.join(directory, 'verify.cjs');
      writeFileSync(verifier, "console.log('VERIFIER_EXECUTED')");
      const command = windowsVerificationCommand(process.execPath, verifier);
      const system = process.env.SystemRoot ?? 'C:\\Windows';
      for (const [shell, args] of [
        [path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]],
        [path.join(system, 'System32/cmd.exe'), ['/d', '/s', '/c', command]],
      ] as const) {
        expect(execFileSync(shell, [...args], { encoding: 'utf8', timeout: 20_000 }).trim())
          .toBe('VERIFIER_EXECUTED');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not quote the executable as a PowerShell string expression', () => {
    expect(windowsVerificationCommand('D:\\a\\_temp\\TEST-node\\node.exe',
      'D:\\a\\_temp\\TEST-project\\alice-verify.cjs')).toBe(
      'D:/a/_temp/TEST-node/node.exe "D:/a/_temp/TEST-project/alice-verify.cjs"'
    );
  });

  it('keeps a verifier argument with spaces quoted and accepts canonical slash input', () => {
    expect(windowsVerificationCommand('C:/TEST-node/node.exe',
      'C:/TEST-project with space/alice-verify.cjs')).toBe(
      'C:/TEST-node/node.exe "C:/TEST-project with space/alice-verify.cjs"'
    );
  });

  it.each(['C:/TEST node/node.exe', 'node.exe', 'C:/TEST-$x/node.exe',
    'C:/TEST;echo/node.exe', 'C:/TEST/../node.exe', 'C:/TEST/node.exe\n'])( 'refuses a nonliteral executable path: %s', executable => {
    expect(() => windowsVerificationCommand(executable, 'C:/TEST/alice-verify.cjs')).toThrow();
  });

  it.each(['C:/TEST/$x.cjs', 'C:/TEST/$(echo).cjs', 'C:/TEST/a".cjs',
    'C:/TEST/%PATH%.cjs', 'C:/TEST/../alice.cjs', './alice.cjs'])( 'refuses shell interpolation or a nonabsolute verifier: %s', program => {
    expect(() => windowsVerificationCommand('C:/TEST/node.exe', program)).toThrow();
  });
});
