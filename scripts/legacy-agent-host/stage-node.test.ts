import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zipFixture } from '../lib/runtime-zip.test-fixture.mts';
import { extractNodeArchiveMember } from './stage-node.ts';

test('Node staging extracts only the selected member from a real local archive without a PATH ZIP fallback', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST Node archive [x] 'тест'-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const windows = process.platform === 'win32';
  const directory = join(root, windows ? 'drive-colon' : 'TEST:colon');
  const prefix = windows ? 'node-vTEST-win-x64' : 'node-vTEST-unix';
  const member = `${prefix}/${windows ? 'node.exe' : 'bin/node'}`;
  const selected = 'TEST selected binary bytes; never executed';
  const archiveName = windows ? 'node.zip' : 'node.tar.gz';
  const archive = join(directory, archiveName), destination = join(root, 'selected');
  await mkdir(directory); await mkdir(destination);
  if (windows) {
    await writeFile(archive, zipFixture([
      { name: member, data: selected, deflate: true },
      { name: `${prefix}/unselected.txt`, data: 'TEST unselected bytes' },
    ]));
  } else {
    const payload = join(root, 'payload');
    await mkdir(join(payload, prefix, 'bin'), { recursive: true });
    await writeFile(join(payload, member), selected);
    await writeFile(join(payload, prefix, 'unselected.txt'), 'TEST unselected bytes');
    execFileSync('tar', ['-czf', archiveName, '-C', payload, prefix], {
      cwd: directory, timeout: 5000, stdio: 'pipe',
    });
  }
  const extract = (target: string, chosen: string) => {
    if (!windows) return extractNodeArchiveMember(archive, target, chosen);
    // Use the real inbox ZIP reader while no archive tool is available on PATH.
    // The controlled archive is extraction evidence, never a native Node proof.
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { extractNodeArchiveMember } from ${JSON.stringify(new URL('./stage-node.ts', import.meta.url).href)}; extractNodeArchiveMember(...process.argv.slice(1));`,
      archive, target, chosen,
    ], { env: { ...process.env, PATH: join(root, 'TEST-no-path-tools') }, timeout: 5000, stdio: 'pipe' });
  };
  extract(destination, member);
  assert.equal(await readFile(join(destination, member), 'utf8'), selected);
  await assert.rejects(readFile(join(destination, prefix, 'unselected.txt')), { code: 'ENOENT' });
  const refused = join(root, 'missing-member');
  await mkdir(refused);
  assert.throws(() => extract(refused, `${prefix}/missing`));
  assert.deepEqual(await readdir(refused), [], 'a missing member cannot fall back to extracting the tree');
});
