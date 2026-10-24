import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface NativeReviewSeed {
  schemaVersion: 1;
  filePath: string;
  index: string;
  before: string;
  intermediate: string;
  after: string;
  mixed: string;
  gitIndexSha256: string;
  /** Optional so retained historical two-Edit fixtures remain readable. */
  partialCoverage?: { failedPath: string; failedBefore: string; failedAfter: string;
    backgroundPath: string; backgroundBefore: string; backgroundAfter: string;
    hookSidePath: string; hookBefore: string; hookAfter: string; writePath: string; hookLog: string };
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Index-only dirty TEST setup. No Tasks, events, native inputs or ledger rows are fabricated. */
export async function prepareNativeReviewWorkspace(root: string): Promise<void> {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  const workspace = join(root, 'workspace'),
    filePath = join(workspace, 'native-review.ts');
  const index = 'const first = 1;\n' + 'const middle = true;\n'.repeat(12) + 'const last = 1;\n';
  await writeFile(filePath, index, { mode: 0o600, flag: 'wx' });
  const env = {
    HOME: join(root, 'home'),
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  execFileSync('/usr/bin/git', ['-c', 'init.templateDir=', 'init', '-q', workspace], { env });
  execFileSync('/usr/bin/git', ['-C', workspace, 'add', '--', 'native-review.ts'], { env });
  const before = '// TEST pre-existing dirty content\n' + index;
  const intermediate = before.replace('const first = 1;', 'const first = 2;');
  const after = intermediate.replace('const last = 1;', 'const last = 2;');
  await writeFile(filePath, before, { mode: 0o600 });
  await writeFile(join(workspace, 'pre-existing-untracked.txt'), 'TEST unrelated dirty file\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const partialCoverage = {
    failedPath: join(workspace, 'native-review-failed.txt'), failedBefore: 'FAILED_BEFORE\n', failedAfter: 'FAILED_BEFORE\nFAILED\n',
    backgroundPath: join(workspace, 'native-review-background.txt'), backgroundBefore: 'BACKGROUND_BEFORE\n', backgroundAfter: 'BACKGROUND_BEFORE\nBACKGROUND\n',
    hookSidePath: join(workspace, 'native-review-hook-side.txt'), hookBefore: 'HOOK_BEFORE\n', hookAfter: 'HOOK_BEFORE\nHOOK_LATE\n',
    writePath: join(workspace, 'native-review-write.txt'), hookLog: join(root, 'native-review-post-hook.ndjson'),
  };
  for (const [path, content] of [[partialCoverage.failedPath, partialCoverage.failedBefore],
    [partialCoverage.backgroundPath, partialCoverage.backgroundBefore], [partialCoverage.hookSidePath, partialCoverage.hookBefore]] as const)
    await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  const hookPath = join(root, 'native-review-post-hook.ts');
  // Exact checked-in TEST source; pinned Node24 strips types at execution.
  await writeFile(hookPath, await readFile(join(import.meta.dirname, 'desktop-native-review-post-hook.ts')),
    { mode: 0o600, flag: 'wx' });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await mkdir(join(workspace, '.claude'));
  await writeFile(join(workspace, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{
    type: 'command', command: [process.execPath, hookPath, root].map(quote).join(' '), timeout: 10,
  }] }] } }), { mode: 0o600, flag: 'wx' });
  const seed: NativeReviewSeed = {
    schemaVersion: 1,
    partialCoverage,
    filePath,
    index,
    before,
    intermediate,
    after,
    mixed: intermediate,
    gitIndexSha256: digest(await readFile(join(workspace, '.git/index'))),
  };
  await writeFile(join(root, 'native-review-ui-seed.json'), JSON.stringify(seed, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
}
export async function readNativeReviewSeed(root: string): Promise<NativeReviewSeed> {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  const seed = JSON.parse(
    await readFile(join(root, 'native-review-ui-seed.json'), 'utf8')
  ) as NativeReviewSeed;
  assert.equal(seed.schemaVersion, 1);
  assert.equal(seed.filePath, join(root, 'workspace/native-review.ts'));
  assert.equal(seed.before, '// TEST pre-existing dirty content\n' + seed.index);
  assert.equal(seed.intermediate, seed.before.replace('const first = 1;', 'const first = 2;'));
  assert.equal(seed.after, seed.intermediate.replace('const last = 1;', 'const last = 2;'));
  assert.equal(seed.mixed, seed.intermediate);
  if (seed.partialCoverage) {
    for (const [key, name] of [['failedPath', 'native-review-failed.txt'], ['backgroundPath', 'native-review-background.txt'],
      ['hookSidePath', 'native-review-hook-side.txt'], ['writePath', 'native-review-write.txt']] as const)
      assert.equal(seed.partialCoverage[key], join(root, 'workspace', name));
    assert.equal(seed.partialCoverage.hookLog, join(root, 'native-review-post-hook.ndjson'));
    assert.equal(seed.partialCoverage.failedBefore, 'FAILED_BEFORE\n');
    assert.equal(seed.partialCoverage.failedAfter, 'FAILED_BEFORE\nFAILED\n');
    assert.equal(seed.partialCoverage.backgroundBefore, 'BACKGROUND_BEFORE\n');
    assert.equal(seed.partialCoverage.backgroundAfter, 'BACKGROUND_BEFORE\nBACKGROUND\n');
    assert.equal(seed.partialCoverage.hookBefore, 'HOOK_BEFORE\n');
    assert.equal(seed.partialCoverage.hookAfter, 'HOOK_BEFORE\nHOOK_LATE\n');
  }
  return seed;
}
