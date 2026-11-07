import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitDiffFallback } from '@agent-teams/task-change-ledger/review-git';

test('a missing or unqualified Git command causes no fallback execution', async () => {
  let requests = 0;
  const git = new GitDiffFallback(async () => {
    requests++;
    return null;
  });
  const cwd = process.cwd();
  assert.equal(await git.getFileAtCommit(cwd, 'TEST-file.txt', 'HEAD'), null);
  assert.equal(await git.findCommitNearTimestamp(cwd, 'TEST-file.txt', '2026-11-07'), null);
  assert.equal(await git.getGitDiff(cwd, 'TEST-file.txt', 'HEAD~1'), null);
  assert.deepEqual(await git.getFileLog(cwd, 'TEST-file.txt'), []);
  assert.equal(await git.isGitRepo(cwd), false);
  assert.equal(requests, 5);
});

test('an unavailable packaged Git command fails closed without invoking a system shim', async () => {
  const git = new GitDiffFallback(async () => {
    throw new Error('TEST bundled Git unavailable');
  });
  assert.equal(await git.getFileAtCommit(process.cwd(), 'TEST-file.txt', 'HEAD'), null);
  assert.equal(await git.isGitRepo(process.cwd()), false);
});
