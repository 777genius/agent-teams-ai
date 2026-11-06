import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildReviewChunks } from '@agent-teams/task-change-ledger/review-text';
import { prepareDesktopBackendFixture, fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopReviewSeed } from './desktop-review-fixture.ts';
import { prepareDesktopProofMode } from './desktop-proof-mode.ts';

test('review UI seed uses one actual Task, explicit captured review profiles and two dirty filesystem hunks without agents', async (t) => {
  const repo = resolve(import.meta.dirname, '../..');
  const fixture = await prepareDesktopBackendFixture(repo, {
    seedUiTask: true,
    reviewUi: true,
    pnpmEntry: '/opt/homebrew/Cellar/node@24/24.18.0/lib/node_modules/corepack/dist/pnpm.js',
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.ok(fixture.uiSeed);
  const seed = await readDesktopReviewSeed(fixture.root, fixture.uiSeed.taskId);
  assert.equal(buildReviewChunks(seed.before, seed.after).length, 2);
  assert.ok(seed.before.startsWith('// TEST pre-existing dirty content\n'));
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.after);
  assert.equal(await fileDigest(join(fixture.root, 'workspace/.git/index')), seed.gitIndexSha256);
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8'));
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8'));
  assert.equal(profile.reviewTransport, 'review-v1');
  assert.equal(descriptor.owners[0].profile.reviewTransport, 'review-v1');
  assert.equal(profile.teams[0].savedSettings.cwd, join(fixture.root, 'workspace'));
  assert.equal(profile.teams[0].members[0].role, 'lead');
  assert.equal(profile.runtime, undefined);
  assert.equal(profile.management, undefined);
  const task = JSON.parse(
    await readFile(
      join(fixture.root, 'hoststore/tasks/test-desktop-backend', seed.taskId + '.json'),
      'utf8'
    )
  );
  assert.equal(task.subject, fixture.uiSeed.subject);
  const event = JSON.parse(
    await readFile(
      join(
        fixture.root,
        'hoststore/teams/test-desktop-backend/.host-evidence/.board-task-changes/events',
        seed.taskId + '.jsonl'
      ),
      'utf8'
    )
  );
  assert.equal(event.taskId, task.id);
  assert.equal(event.taskRef, task.id);
  assert.equal(event.workspaceRoot, join(fixture.root, 'workspace'));
  assert.equal(event.filePath, seed.filePath);
  await assert.rejects(readDesktopReviewSeed(fixture.root, 'TEST-wrong-task'));
});

test('both explicit review proof modes never allocate a model or native runtime', async () => {
  for (const mode of ['review-ui', 'review-readback-ui']) {
    const result = await prepareDesktopProofMode(mode, () => {
      throw new Error('No native fixture lookup');
    });
    assert.equal(result.reviewUiMode, true);
    assert.equal(result.reviewReadbackMode, mode === 'review-readback-ui');
    assert.equal(result.uiMode, true);
    assert.equal(result.model, undefined);
    assert.equal(result.nativeStopMode, false);
    assert.equal(result.launchDialogMode, false);
  }
});
