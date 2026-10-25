import assert from 'node:assert/strict';

// Real-task prompt contract for the native packaged E2E. The gates check exact
// tool arguments, a byte-exact comment token and call ordering mechanically, so
// the prompt must present them as a copyable contract instead of prose.
export type RealTaskPromptInput = {
  base: string;
  teamName: string;
  owner: string;
  commentToken: string;
  work: string[];
};

export function realTaskPrompt(input: RealTaskPromptInput): string {
  const { base, teamName, owner, commentToken, work } = input;
  const addComment = JSON.stringify({
    tool: 'task_add_comment',
    teamName,
    taskId: "<this task's id>",
    from: owner,
    text: commentToken,
  });
  const complete = JSON.stringify({
    tool: 'task_complete',
    teamName,
    taskId: "<this task's id>",
    actor: owner,
  });
  return [
    base,
    'Task work — do every step in order and nothing else:',
    ...work.map((line, index) => `${index + 1}. ${line}`),
    'Completion protocol — every step is machine-checked:',
    '1. If any tool call returns an error, fix its arguments and call it again before continuing. Never finish after a failed call.',
    `2. Call task_add_comment with exactly these arguments (replace <this task's id> with this task's real id): ${addComment}. The text value must be exactly ${commentToken}, copied byte-for-byte on one line, without quotes, backticks, punctuation or extra words. A comment with any other text fails the task.`,
    `3. Only after task_add_comment returns success, call task_complete with exactly these arguments (replace <this task's id> with this task's real id): ${complete}.`,
    '4. task_complete must be your very last action. Never call task_complete before every task-work step has succeeded and the exact comment has been saved. Your final two actions must be task_add_comment then task_complete; stopping without both calls fails the task.',
  ].join('\n');
}

// The supplied verifier command is the evidence contract: only its own zero-exit
// run counts as proof. The generic completion protocol tells the model to
// "fix its arguments" after an error, which invites re-spelling this literal
// command instead of repairing the model's own file, so this instruction
// resolves that conflict explicitly.
export function verificationInstruction(command: string): string {
  return [
    `Execute this supplied literal absolute Node command verbatim in your native shell: ${command}.`,
    'Do not substitute a relative path, recreate or copy the verifier, or print its marker yourself. Let the unchanged verifier produce its own output.',
    'Never create or edit *-result.txt yourself; the unchanged verifier alone writes it.',
    'This step is done only when that exact command exits zero and its own output prints the marker line.',
    'If it exits non-zero because a file you wrote is wrong, fix only your file and execute this identical command again until it exits zero. Its arguments are already correct: never alter, wrap, cd around or re-spell the command.',
    'Anything you print yourself never counts as the marker.',
  ].join(' ');
}

/** A bare drive-qualified executable works in PowerShell, cmd and Git Bash.
 * Quoting the executable without PowerShell's & operator turns it into a string.
 * Both paths are bare literals: cmd /c does not understand libuv quote escaping.
 * TEST staging must fail closed instead of guessing when a path needs escaping.
 */
export function windowsVerificationCommand(executable: string, program: string): string {
  const slash = (value: string) => value.replace(/\\/g, '/');
  const node = slash(executable);
  const verifier = slash(program);
  assert(/^[A-Za-z]:\/[A-Za-z0-9_./-]+\/node\.exe$/i.test(node),
    'Cross-shell TEST Node path must be absolute and contain only literal characters');
  assert(/^[A-Za-z]:\/[A-Za-z0-9_./-]+\.cjs$/i.test(verifier),
    'Cross-shell TEST verifier path must be absolute and contain only literal characters');
  assert(![node, verifier].some(value => value.split('/').some(part => part === '.' || part === '..')),
    'Canonical TEST command paths required');
  return `${node} ${verifier}`;
}
