import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { stageCandidateClosure } from './candidate-closure.ts';

async function fixture(t: import('node:test').TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-candidate-closure-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  async function pkg(
    path: string,
    name: string,
    dependencies: Record<string, string> = {},
    extra: Record<string, unknown> = {}
  ) {
    await mkdir(join(path, 'dist'), { recursive: true });
    await writeFile(
      join(path, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        type: 'module',
        main: 'dist/index.js',
        files: ['dist'],
        dependencies,
        ...extra,
      })
    );
    await writeFile(join(path, 'dist/index.js'), `export const value = ${JSON.stringify(name)};`);
  }
  const host = join(repo, 'packages/legacy-agent-host');
  return { root, repo, host, pkg, output: join(root, 'candidate') };
}
test('installed per-parent versions, cycles and optional omissions remain a relocatable runtime closure', async (t) => {
  const f = await fixture(t);
  await f.pkg(f.host, '@agent-teams/legacy-agent-host', { a: '1', b: '1' });
  const a = join(f.repo, 'node_modules/a'),
    b = join(f.repo, 'node_modules/b');
  await f.pkg(a, 'a', { b: '1', x: '2' }, { optionalDependencies: { absent: '1' } });
  await f.pkg(b, 'b', { a: '1', x: '1' });
  await f.pkg(join(a, 'node_modules/x'), 'x', {}, { version: '2.0.0' });
  await f.pkg(join(f.repo, 'node_modules/x'), 'x');
  await writeFile(
    join(a, 'dist/index.js'),
    "import { value } from 'x'; export const valueA = value;"
  );
  await writeFile(join(f.host, 'dist/index.js'), "export { valueA } from 'a';");
  const rows = await stageCandidateClosure(f.repo, f.output);
  assert.equal(rows.length, 5);
  const rowA = rows.find((row) => row.name === 'a')!,
    rowB = rows.find((row) => row.name === 'b')!;
  assert.deepEqual(rowA.missingOptional, ['absent']);
  assert.equal(rowA.dependencies.b, rowB.path.split('/')[1]);
  assert.equal(rowB.dependencies.a, rowA.path.split('/')[1]);
  assert.notEqual(rowA.dependencies.x, rowB.dependencies.x);
  // The importer and every dependency link live wholly in copied output; source becomes unavailable.
  await rm(f.repo, { recursive: true });
  assert.equal(
    (await import(pathToFileURL(join(f.output, rows[0]!.path, 'dist/index.js')).href)).valueA,
    'x'
  );
  assert.ok(rows.every((row) => row.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))));
});
test('required missing packages and sibling repository links fail closed', async (t) => {
  const f = await fixture(t);
  await f.pkg(f.host, '@agent-teams/legacy-agent-host', { missing: '1' });
  await assert.rejects(stageCandidateClosure(f.repo, f.output), /Missing installed dependency/);
  await rm(f.output, { recursive: true });
  const sibling = join(f.root, 'sibling');
  await f.pkg(sibling, 'missing');
  const link = join(f.repo, 'node_modules/missing');
  await mkdir(dirname(link), { recursive: true });
  await symlink(sibling, link, 'dir');
  await assert.rejects(
    stageCandidateClosure(f.repo, f.output),
    /escapes installed repository closure/
  );
  assert.equal(JSON.parse(await readFile(join(sibling, 'package.json'), 'utf8')).name, 'missing');
});
test('payload links cannot import configuration outside the selected package', async (t) => {
  const f = await fixture(t);
  await f.pkg(f.host, '@agent-teams/legacy-agent-host');
  const privateFixture = join(f.root, 'TEST-not-package-config');
  await writeFile(privateFixture, 'TEST-private-bytes');
  await symlink(privateFixture, join(f.host, 'dist/settings.json'));
  await assert.rejects(stageCandidateClosure(f.repo, f.output), /payload symlink/);
});
