import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface DesktopReviewSeed {
  schemaVersion: 1;
  taskId: string;
  memberName: 'alice';
  filePath: string;
  before: string;
  after: string;
  mixed: string;
  gitIndexSha256: string;
}
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

/** Deliberate synthetic ledger; this never claims native tool attribution or M13 qualification. */
export async function prepareDesktopReviewLedger(root: string, taskId: string): Promise<void> {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  assert.match(taskId, /^[A-Za-z0-9_-]+$/);
  const workspace = join(root, 'workspace');
  const filePath = join(workspace, 'value.ts');
  const clean = 'const first = 1;\n' + 'const middle = true;\n'.repeat(12) + 'const last = 1;\n';
  await writeFile(filePath, clean, { mode: 0o600, flag: 'wx' });
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: workspace,
      env: {
        HOME: join(root, 'home'),
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      encoding: 'utf8',
    });
  git(['init', '-b', 'TEST-review-fixture']);
  git(['add', 'value.ts']);
  const before = '// TEST pre-existing dirty content\n' + clean;
  const after = before.replace('first = 1', 'first = 2').replace('last = 1', 'last = 2');
  await writeFile(filePath, after, { mode: 0o600 });
  await writeFile(join(workspace, 'pre-existing-untracked.txt'), 'TEST unrelated dirty file\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const ledger = join(
    root,
    'hoststore/teams/test-desktop-backend/.host-evidence/.board-task-changes'
  );
  await mkdir(join(ledger, 'events'), { recursive: true, mode: 0o700 });
  await mkdir(join(ledger, 'blobs'), { mode: 0o700 });
  const blob = async (name: string, content: string) => {
    await writeFile(join(ledger, 'blobs', name), content, { mode: 0o600, flag: 'wx' });
    return { sha256: sha256(content), sizeBytes: Buffer.byteLength(content), blobRef: name };
  };
  await writeFile(
    join(ledger, 'events', taskId + '.jsonl'),
    JSON.stringify({
      schemaVersion: 1,
      eventId: 'TEST-review-ui-event',
      taskId,
      taskRef: taskId,
      taskRefKind: 'canonical',
      phase: 'work',
      executionSeq: 1,
      sessionId: 'TEST-review-ui-fixture-session',
      agentId: 'alice-id',
      memberName: 'alice',
      toolUseId: 'TEST-review-ui-fixture-tool',
      source: 'file_edit',
      operation: 'modify',
      confidence: 'exact',
      workspaceRoot: workspace,
      filePath,
      relativePath: 'value.ts',
      timestamp: '2026-10-23T00:00:00.000Z',
      toolStatus: 'succeeded',
      before: await blob('TEST-review-before.txt', before),
      after: await blob('TEST-review-after.txt', after),
      linesAdded: 2,
      linesRemoved: 2,
    }) + '\n',
    { mode: 0o600, flag: 'wx' }
  );
  const seed: DesktopReviewSeed = {
    schemaVersion: 1,
    taskId,
    memberName: 'alice',
    filePath,
    before,
    after,
    mixed: before.replace('first = 1', 'first = 2'),
    gitIndexSha256: sha256(await readFile(join(workspace, '.git/index'))),
  };
  await writeFile(join(root, 'review-ui-seed.json'), JSON.stringify(seed, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(join(root, 'review-ui-initial-git-diff.txt'), git(['diff', '--', 'value.ts']), {
    mode: 0o600,
    flag: 'wx',
  });
}

export async function readDesktopReviewSeed(
  root: string,
  taskId: string
): Promise<DesktopReviewSeed> {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  const seed = JSON.parse(
    await readFile(join(root, 'review-ui-seed.json'), 'utf8')
  ) as DesktopReviewSeed;
  assert.equal(seed.schemaVersion, 1);
  assert.equal(seed.taskId, taskId);
  assert.equal(seed.memberName, 'alice');
  assert.equal(seed.filePath, join(root, 'workspace/value.ts'));
  assert.equal(
    seed.after,
    seed.before.replace('first = 1', 'first = 2').replace('last = 1', 'last = 2')
  );
  assert.equal(seed.mixed, seed.before.replace('first = 1', 'first = 2'));
  return seed;
}
