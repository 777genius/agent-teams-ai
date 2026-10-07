import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ARM211_FILES,
  assertFixturePath,
  assertPreservedFiles,
  assertRepairManifest,
  copyOriginalArmFile,
} from './windows-arm-prior-fixture.mts';

// These exercise actual TEST filesystem/PE boundaries, not a native installer or decoder mock.
const bytes = (data: Buffer) => ({
  size: data.length,
  sha256: createHash('sha256').update(data).digest('hex'),
  sha512: createHash('sha512').update(data).digest('base64'),
});
void test('archive boundary rejects changed entry set, foreign names, links and case collisions', () => {
  const valid = [
    ...ARM211_FILES.map((name) => ({ name, method: 'ARM64 LZMA2', link: false })),
    ...Array.from({ length: 1007 }, (_, index) => ({
      name: `resources/data-${index}`,
      method: 'LZMA2',
      link: false,
    })),
  ];
  assertRepairManifest(valid);
  for (const changed of [
    { name: '../outside.exe' },
    { name: 'C:/outside.exe' },
    { name: 'other.exe' },
    { link: true },
    { method: 'LZMA2' },
    { name: ARM211_FILES[1].toUpperCase() },
  ]) {
    const invalid = structuredClone(valid);
    assert(invalid[0]);
    Object.assign(invalid[0], changed);
    assert.throws(() => assertRepairManifest(invalid));
  }
});
void test('copy proves original bytes/ARM PE and never overwrites, even a destination created after validation', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-arm211-files-')));
  const from = path.join(root, 'source.exe'),
    to = path.join(root, 'installed.exe');
  const data = Buffer.alloc(96);
  data.write('MZ');
  data.writeUInt32LE(80, 60);
  data.write('PE\0\0', 80);
  data.writeUInt16LE(0xaa64, 84);
  const guard = (file: string, exists = true) => assertFixturePath(root, file, exists);
  try {
    await writeFile(from, data);
    const expected = bytes(data);
    await assert.rejects(
      copyOriginalArmFile(from, to, { ...expected, sha256: '0'.repeat(64) }, guard)
    );
    const x86 = Buffer.from(data);
    x86.writeUInt16LE(0x14c, 84);
    await writeFile(from, x86);
    await assert.rejects(copyOriginalArmFile(from, to, bytes(x86), guard));
    await writeFile(from, data);
    const result = await copyOriginalArmFile(from, to, expected, guard);
    assert.deepEqual(result.installed, expected);
    assert.deepEqual(await readFile(to), data);
    await assert.rejects(copyOriginalArmFile(from, to, expected, guard));
    await rm(to);
    await assert.rejects(
      copyOriginalArmFile(from, to, expected, async (file, exists = true) => {
        await guard(file, exists);
        if (file === to && !exists) await writeFile(to, 'race-winner');
      }),
      { code: 'EEXIST' }
    );
    assert.equal(await readFile(to, 'utf8'), 'race-winner');
    await rm(to);
    await symlink(from, to);
    await assert.rejects(guard(to));
    await assert.rejects(guard(path.join(root, '..', 'outside.exe'), false));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test('preserved original ASAR/update configuration reject changed bytes', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-arm211-preserved-'))),
    install = path.join(root, 'install');
  await mkdir(path.join(install, 'resources'), { recursive: true });
  try {
    for (const name of ['resources/app.asar', 'resources/app-update.yml']) {
      const file = path.join(install, name),
        original = Buffer.from(`original ${name}`);
      await writeFile(file, original);
      const preserved = { [name]: bytes(original) },
        guard = (candidate: string, exists = true) => assertFixturePath(root, candidate, exists);
      await assertPreservedFiles(root, install, preserved, guard);
      await writeFile(file, 'changed');
      await assert.rejects(assertPreservedFiles(root, install, preserved, guard));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
