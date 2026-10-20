import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

interface FileIdentity {
  path: string;
  sha256: string;
}

function assertContained(root: string, file: string) {
  const relative = path.relative(root, file);
  assert(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    'Package addition escaped its source root'
  );
}

async function regularFileIdentity(root: string, relative: string): Promise<FileIdentity> {
  const file = path.join(root, relative);
  assert((await lstat(file)).isFile(), 'Package addition must be a regular file');
  const resolved = await realpath(file);
  assertContained(await realpath(root), resolved);
  return {
    path: resolved,
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  };
}

/** Reject every bundled-only file except the exact production-built Windows wrapper. */
export async function qualifyPackagedRuntimeAdditions(
  original: ReadonlyMap<string, string>,
  bundled: ReadonlyMap<string, string>,
  repoRoot: string,
  runtimeRoot: string,
  targetPlatform: NodeJS.Platform
) {
  const { OPENCODE_CONSOLE_WRAPPER_PATH } = (
    createRequire(import.meta.url)('../../electron-builder/afterPack.cjs') as {
      _internal: { OPENCODE_CONSOLE_WRAPPER_PATH: string };
    }
  )._internal;
  const wrapper = path.posix.relative('resources/runtime', OPENCODE_CONSOLE_WRAPPER_PATH);
  assert(wrapper && !wrapper.startsWith('../') && !path.posix.isAbsolute(wrapper));
  const additions: { file: string; staged: FileIdentity; bundled: FileIdentity }[] = [];
  for (const [file, digest] of bundled) {
    // Archive-owned paths have already passed the original strict digest comparison.
    if (original.has(file)) continue;
    assert(
      targetPlatform === 'win32' && file === wrapper,
      `Unexpected file in packaged runtime: ${file}`
    );
    const stagedRoot = await realpath(path.join(repoRoot, 'resources/runtime'));
    assertContained(await realpath(repoRoot), stagedRoot);
    const staged = await regularFileIdentity(stagedRoot, file);
    const physical = await regularFileIdentity(runtimeRoot, file);
    assert.equal(physical.sha256, digest, 'Package addition changed after inventory');
    assert.equal(
      physical.sha256,
      staged.sha256,
      `Packaged addition differs from production-staged file: ${file}`
    );
    additions.push({ file, staged, bundled: physical });
  }
  return additions;
}
