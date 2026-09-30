import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { captureSourceManifest } from './source-evidence.mjs';

const exec = promisify(execFile);

test('source manifest changes when an untracked executed file changes', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'core-live-source-test-'));
  try {
    await exec('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'tracked.mjs'), 'export const value = 1;\n');
    await exec('git', ['add', 'tracked.mjs'], { cwd: repo });
    await writeFile(join(repo, 'driver.mjs'), 'export const untracked = 1;\n');
    const before = await captureSourceManifest(repo);
    assert.equal(before.fileCount, 2);
    assert.deepEqual(before.files.map(file => file.path), ['driver.mjs', 'tracked.mjs']);
    await writeFile(join(repo, 'driver.mjs'), 'export const untracked = 2;\n');
    const after = await captureSourceManifest(repo);
    assert.notEqual(after.sha256, before.sha256);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
