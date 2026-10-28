import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { captureDesktopOwnerRoutingProduct } from './desktop-owner-routing-ui-smoke.ts';

import type { TestContext } from 'node:test';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-owner-product-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'hoststore');
  const destination = join(root, 'snapshot');
  const owner = join(source, 'teams/test-team/.host-owner');
  await mkdir(join(owner, 'commands'), { recursive: true });
  await writeFile(join(owner, 'state.json'), '{"ready":true}');
  await writeFile(join(owner, 'commands/original.json'), '{"commandId":"TEST-original"}');
  return { source, destination, owner };
}

async function removeAfterEnumeration<T>(source: string, path: string, run: () => Promise<T>) {
  const original = fs.promises.readdir;
  let removed = false;
  const mocked = test.mock.method(
    fs.promises,
    'readdir',
    async (directory: string, options: { recursive?: boolean; withFileTypes: true }) => {
      const entries = await original(directory, options);
      const observedParent = options.recursive ? source : dirname(path);
      if (directory === observedParent && !removed) {
        removed = true;
        await rm(path, { recursive: true });
      }
      return entries;
    }
  );
  syncBuiltinESMExports();
  try {
    const result = await run();
    assert.equal(removed, true, 'original namespace changed after physical enumeration');
    return result;
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
}

test('owner product census prunes exact transient authority sidecars before descent', async (t) => {
  const f = await fixture(t);
  const token = '10000000-0000-4000-8000-000000000001';
  for (const name of ['authority.lock', 'authority.lock.candidate-123-' + token])
    await writeFile(join(f.owner, name), '123\n1\n' + token + '\n');
  const malformed = 'authority.lock.candidate-123-' + 'f'.repeat(36);
  await writeFile(join(f.owner, malformed), 'ordinary malformed lookalike retained');
  const gate = join(f.owner, 'authority.lock-transition-v2');
  for (const path of [gate, gate + '.candidate-123-' + token]) {
    await mkdir(path);
    await writeFile(
      join(path, 'owner-123-' + token),
      'file-lock-transition-v2\n123\n' + token + '\n'
    );
  }
  await writeFile(join(f.source, 'authority.lock'), 'ordinary product with same basename');
  const files = await removeAfterEnumeration(f.source, gate, () =>
    captureDesktopOwnerRoutingProduct(f.source, f.destination)
  );
  assert.deepEqual(files.map((file) => file.path).sort(), [
    'authority.lock',
    'teams/test-team/.host-owner/' + malformed,
    'teams/test-team/.host-owner/commands/original.json',
    'teams/test-team/.host-owner/state.json',
  ]);
  for (const file of files)
    assert.deepEqual(
      await readFile(join(f.destination, file.path)),
      await readFile(join(f.source, file.path))
    );
});

test('owner product census still refuses a missing ordinary product after enumeration', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    removeAfterEnumeration(f.source, join(f.owner, 'state.json'), () =>
      captureDesktopOwnerRoutingProduct(f.source, f.destination)
    ),
    { code: 'ENOENT' }
  );
});

for (const kind of ['file', 'directory', 'symlink'] as const)
  test(`owner product census rejects wrong-type ${kind} authority sidecars`, async (t) => {
    const f = await fixture(t);
    if (kind === 'file')
      await writeFile(join(f.owner, 'authority.lock-transition-v2'), 'not a gate');
    if (kind === 'directory') await mkdir(join(f.owner, 'authority.lock'));
    if (kind === 'symlink')
      await symlink(join(f.owner, 'state.json'), join(f.owner, 'authority.lock'));
    await assert.rejects(captureDesktopOwnerRoutingProduct(f.source, f.destination));
  });
