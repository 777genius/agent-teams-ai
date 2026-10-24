import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// A consumer's argv must not activate an imported CLI or write release inputs.
void test('prepared-stage import has no CLI parsing, transport or filesystem effects', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'TEST-prepared-stage-import-'));
  try {
    const moduleUrl = new URL('./prepared-stage-download.mts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `process.argv[2]='--write-catalog'; process.argv[3]=${JSON.stringify(directory)};
         const module=await import(${JSON.stringify(moduleUrl)});
         if(typeof module.downloadPreparedStageArtifact!=='function')process.exit(2);`,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, GITHUB_ACTIONS: 'false' },
      }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '');
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
