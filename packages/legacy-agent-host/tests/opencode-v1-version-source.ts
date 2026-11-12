/** Exact-source build boundary for disposable native Host qualification. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { fileHash, treeHash } from './fixtures/native-host.ts';

export interface NativeV1HostBuild {
  hostSourceDigest: string;
  hostDistDigest: string;
  providerDigest: string;
}

// Include the harness, transitive local package, compiler inputs and vendored
// provider archives. Unrelated working-tree files cannot affect this build.
const inputs = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'runtime.lock.json',
  'legacy-host.lock.json',
  'packages/legacy-agent-host/src',
  'packages/legacy-agent-host/tests',
  'packages/legacy-agent-host/native',
  'packages/legacy-agent-host/scripts',
  'packages/legacy-agent-host/package.json',
  'packages/legacy-agent-host/tsconfig.json',
  'packages/legacy-agent-host/tsconfig.test.json',
  'packages/task-change-ledger/src',
  'packages/task-change-ledger/package.json',
  'packages/task-change-ledger/tsconfig.json',
  'vendor/provider-migration',
  'scripts/legacy-agent-host',
  'scripts/stage-runtime.mjs',
  'scripts/electron-builder/afterPack.cjs',
  'scripts/lib/opencode-v2-base-inventory.mts',
  'scripts/lib/runtime-archive-checksum.mjs',
  'scripts/lib/runtime-payload-cache.mjs',
  'scripts/lib/github-release-download-error.mjs',
  'src/features/opencode-runtime-installer/core/domain/v2Delivery.ts',
  'src/features/opencode-runtime-installer/main/infrastructure/v2SupportArchive.ts',
  'src/features/opencode-runtime-installer/main/infrastructure/runtimeZip.ts',
];

export function assertNativeV1Source(repo: string, sourceHead: string): void {
  assert.match(sourceHead, /^[a-f0-9]{40}$/);
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(git(['rev-parse', 'HEAD']), sourceHead, 'native source must match the requested HEAD');
  assert.equal(git(['diff', '--name-only', 'HEAD', '--', ...inputs]), '',
    'native source, harness and dependency inputs must be clean at the requested HEAD');
  assert.equal(git(['ls-files', '--others', '--exclude-standard', '--', ...inputs]), '',
    'untracked native source or harness inputs cannot qualify the requested HEAD');
}

async function installedDependency(parent: string, name: string): Promise<string> {
  for (const search of createRequire(join(parent, 'package.json')).resolve.paths(name) ?? []) {
    try { return await realpath(join(search, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error(`Missing installed native provider dependency: ${name}`);
}

/** Same finite archive census as packaged staging; ignored installed bytes are not source evidence. */
async function verifyInstalledArchive(archive: string, installed: string, name: string): Promise<void> {
  // GNU tar treats a drive colon in -f as a remote host. Keep the same selected
  // archive, using its local basename with both GNU and BSD tar.
  const archiveName = basename(archive), archiveDirectory = dirname(archive);
  assert.ok(archiveName && !archiveName.startsWith('-') && !archiveName.includes(':'));
  const tar = (args: string[]) => execFileSync('tar', args, {
    cwd: archiveDirectory,
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split(/\r?\n/);
  const members = tar(['-tf', archiveName]);
  assert.ok(members.length > 0 && members.length <= 4096);
  assert.equal(new Set(members).size, members.length);
  assert.ok(members.every(member => member.startsWith('package/') &&
    !/[\\:\0]/.test(member) && member.slice(8).split('/').every((part, index, parts) =>
      (part.length > 0 || index === parts.length - 1) && part !== '.' && part !== '..')));
  // Reject links before extraction so a selected archive cannot redirect writes.
  const modes = tar(['-tvf', archiveName]);
  assert.equal(modes.length, members.length);
  assert.ok(modes.every(line => line.startsWith('-') || line.startsWith('d')));
  const expected = members.filter(member => !member.endsWith('/')).map(member => member.slice(8)).sort();
  assert.ok(expected.includes('package.json'));
  const directories = new Set(members.filter(member => member.endsWith('/')).map(member => member.slice(8, -1)));
  for (const file of expected) {
    const parts = file.split('/');
    for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join('/'));
  }
  const actual: string[] = [];
  async function census(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (prefix === '' && entry.name === 'node_modules') continue;
      const path = join(directory, entry.name), name = prefix + entry.name;
      const info = await lstat(path);
      assert.equal(info.isSymbolicLink(), false, 'installed provider payload cannot redirect resolution');
      if (info.isDirectory()) {
        assert.ok(directories.has(name), 'installed provider directory census must match its selected archive');
        await census(path, name + '/');
      }
      else { assert.ok(info.isFile()); actual.push(name); }
    }
  }
  await census(installed);
  assert.deepEqual(actual.sort(), expected, 'installed provider file census must match its selected archive');
  const unpacked = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-provider-census-')));
  try {
    execFileSync('tar', ['-xf', archiveName, '-C', unpacked], {
      cwd: archiveDirectory, timeout: 30_000, stdio: 'pipe',
    });
    for (const member of expected) assert.deepEqual(
      await readFile(join(installed, member)), await readFile(join(unpacked, 'package', member)),
      'installed provider bytes must match their selected immutable archive');
    assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).name, name);
  } finally { await rm(unpacked, { recursive: true, force: true }); }
}

export async function measureNativeV1Host(repo: string): Promise<NativeV1HostBuild> {
  const pkg = join(repo, 'packages/legacy-agent-host');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  let providerDigest = '';
  const roots = new Map<string, string>();
  for (const name of ['@agent-teams/provider-implementations', '@agent-teams/provider-session-contracts']) {
    const reference: unknown = manifest.dependencies[name];
    assert.ok(typeof reference === 'string' && reference.startsWith('file:../../vendor/provider-migration/') && reference.endsWith('.tgz'));
    const archive = await realpath(resolve(pkg, reference.slice(5)));
    const installed = await installedDependency(pkg, name);
    const local = relative(await realpath(repo), installed);
    assert.ok(local !== '' && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`));
    roots.set(name, installed);
    await verifyInstalledArchive(archive, installed, name);
    if (name === '@agent-teams/provider-implementations') providerDigest = await fileHash(archive);
    else {
      const resolved = await installedDependency(roots.get('@agent-teams/provider-implementations')!, name);
      if (resolved !== installed) {
        const local = relative(await realpath(repo), resolved);
        assert.ok(local !== '' && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`));
        await verifyInstalledArchive(archive, resolved, name);
      }
    }
  }
  return {
    hostSourceDigest: await treeHash(join(pkg, 'src'), '.ts'),
    hostDistDigest: await treeHash(join(pkg, 'dist'), '.js'),
    providerDigest,
  };
}

export async function buildNativeV1Host(repo: string, sourceHead: string): Promise<NativeV1HostBuild> {
  assertNativeV1Source(repo, sourceHead);
  // Removing both output directories prevents stale emitted modules from a
  // previous source revision surviving a successful incremental compile.
  for (const name of ['task-change-ledger', 'legacy-agent-host']) {
    const pkg = join(repo, 'packages', name);
    await rm(join(pkg, 'dist'), { recursive: true, force: true });
    execFileSync(process.execPath, [join(pkg, 'node_modules/@typescript/native/bin/tsc'), '-p', 'tsconfig.json'], {
      cwd: pkg, timeout: 60_000, stdio: 'inherit',
    });
  }
  assertNativeV1Source(repo, sourceHead);
  return measureNativeV1Host(repo);
}

export async function assertNativeV1Build(repo: string, sourceHead: string, expected: NativeV1HostBuild): Promise<void> {
  assertNativeV1Source(repo, sourceHead);
  for (const digest of Object.values(expected)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await measureNativeV1Host(repo), expected,
    'native execution must retain the source and freshly built Host measured by its runner');
}
