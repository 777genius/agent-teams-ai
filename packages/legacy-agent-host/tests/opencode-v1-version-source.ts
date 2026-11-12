/** Exact-source build boundary for the disposable V1 compatibility matrix. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { fileHash, treeHash } from './fixtures/native-host.ts';

export interface NativeV1HostBuild {
  hostSourceDigest: string;
  hostDistDigest: string;
  providerDigest: string;
}

// Include the harness, transitive local package, compiler inputs and vendored
// provider archives. Unrelated working-tree files cannot affect this build.
const inputs = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'packages/legacy-agent-host/src', 'packages/legacy-agent-host/tests',
  'packages/legacy-agent-host/package.json', 'packages/legacy-agent-host/tsconfig.json',
  'packages/legacy-agent-host/tsconfig.test.json', 'packages/task-change-ledger/src',
  'packages/task-change-ledger/package.json', 'packages/task-change-ledger/tsconfig.json',
  'vendor/provider-migration',
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

export async function measureNativeV1Host(repo: string): Promise<NativeV1HostBuild> {
  const pkg = join(repo, 'packages/legacy-agent-host');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  const reference: unknown = manifest.dependencies['@agent-teams/provider-implementations'];
  assert.ok(typeof reference === 'string' && reference.startsWith('file:../../vendor/provider-migration/'));
  return {
    hostSourceDigest: await treeHash(join(pkg, 'src'), '.ts'),
    hostDistDigest: await treeHash(join(pkg, 'dist'), '.js'),
    providerDigest: await fileHash(resolve(pkg, reference.slice(5))),
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
