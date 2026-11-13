#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertStaticLinuxNodeExec, captureLinuxNodeExecArtifact, LINUX_NODE_EXEC_SOURCE_SHA256,
} from '../../src/main/utils/linuxNodeExecArtifact.ts';

const repository = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = (path) => {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error('Linux process launcher build input is not an original file');
  return { dev: stat.dev, ino: stat.ino, sha256: hash(readFileSync(path)) };
};
const unchanged = (path, captured) => {
  const current = original(path);
  if (current.dev !== captured.dev || current.ino !== captured.ino || current.sha256 !== captured.sha256)
    throw new Error('Linux process launcher build input changed');
};

/** Build actor only. Main never invokes a compiler or repairs a selected artifact. */
export function stageLinuxNodeExec({
  platform = process.platform, architecture = process.arch,
  outputDirectory = join(repository, 'resources/process-launch/linux-x64'),
} = {}) {
  if (platform !== 'linux') return undefined;
  if (platform !== process.platform || architecture !== 'x64' || process.arch !== 'x64')
    throw new Error('Linux process launcher requires its original Linux x64 build tuple');
  const source = realpathSync(join(repository, 'tools/linux-node-exec/close-fds-exec.c'));
  const sourcePin = original(source);
  if (sourcePin.sha256 !== LINUX_NODE_EXEC_SOURCE_SHA256)
    throw new Error('Linux process launcher source does not match the reviewed pin');
  if (existsSync(outputDirectory)) {
    // Reuse only a complete, source-associated artifact. Never overwrite a live selection.
    return captureLinuxNodeExecArtifact(outputDirectory);
  }
  const compiler = realpathSync('/usr/bin/cc'), compilerPin = original(compiler);
  const parent = dirname(outputDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  if (realpathSync(parent) !== parent || lstatSync(parent).isSymbolicLink())
    throw new Error('Linux process launcher output must use its original directory');
  const work = join(parent, '.node-exec-build-' + randomUUID());
  mkdirSync(work, { mode: 0o700 });
  try {
    const binary = join(work, 'node-exec');
    execFileSync(compiler, [
      '-static', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=3',
      '-fstack-protector-strong', '-Wl,-z,noexecstack', '-Wl,--build-id=none',
      source, '-o', binary,
    ], { timeout: 60_000, maxBuffer: 1024 * 1024, stdio: 'pipe' });
    unchanged(source, sourcePin); unchanged(compiler, compilerPin);
    const bytes = readFileSync(binary);
    assertStaticLinuxNodeExec(bytes);
    chmodSync(binary, 0o755);
    writeFileSync(join(work, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, platform: 'linux', architecture: 'x64', file: 'node-exec', static: true,
      sourceSha256: sourcePin.sha256, binarySha256: hash(bytes), compilerSha256: compilerPin.sha256,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    chmodSync(work, 0o755);
    captureLinuxNodeExecArtifact(work);
    // A concurrent build may win. It is accepted only through the same strict selector.
    try { renameSync(work, outputDirectory); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
    return captureLinuxNodeExecArtifact(outputDirectory);
  } finally {
    // This exact private generation was created by this invocation and is never a runtime owner.
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  stageLinuxNodeExec();
