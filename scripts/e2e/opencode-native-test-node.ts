import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { BigIntStats } from 'node:fs';

const MAX_NODE_BYTES = 256 * 1024 * 1024;
const sameFile = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino;
const sameArtifact = (left: BigIntStats, right: BigIntStats) =>
  sameFile(left, right) &&
  left.birthtimeNs === right.birthtimeNs &&
  left.isFile() &&
  right.isFile() &&
  left.size === right.size &&
  left.nlink === right.nlink &&
  left.mode === right.mode &&
  left.mtimeNs === right.mtimeNs;
const sameSnapshot = (left: BigIntStats, right: BigIntStats) =>
  sameArtifact(left, right) && left.ctimeNs === right.ctimeNs;

async function canonical(file: string): Promise<BigIntStats> {
  assert(
    path.isAbsolute(file) && path.normalize(file) === file,
    'TEST Node absolute canonical path required'
  );
  const stat = await lstat(file, { bigint: true });
  assert(!stat.isSymbolicLink() && (await realpath(file)) === file, 'TEST Node path alias refused');
  return stat;
}
async function readStable(file: string, retainBytes = false) {
  const before = await canonical(file);
  assert(
    before.isFile() &&
      before.nlink === 1n &&
      before.ino > 0n &&
      before.size > 0n &&
      before.size <= BigInt(MAX_NODE_BYTES),
    'TEST Node bounded single-link regular file required'
  );
  const handle = await open(file, 'r');
  try {
    assert(
      sameSnapshot(before, await handle.stat({ bigint: true })),
      'TEST Node source identity changed'
    );
    const byteCount = Number(before.size);
    const bytes = Buffer.allocUnsafe(retainBytes ? byteCount : Math.min(64 * 1024, byteCount));
    const digest = createHash('sha256');
    let offset = 0;
    while (offset < byteCount) {
      const bufferOffset = retainBytes ? offset : 0;
      const read = await handle.read(
        bytes,
        bufferOffset,
        Math.min(64 * 1024, byteCount - offset),
        offset
      );
      assert(read.bytesRead > 0, 'TEST Node short read');
      digest.update(bytes.subarray(bufferOffset, bufferOffset + read.bytesRead));
      offset += read.bytesRead;
    }
    assert(
      sameSnapshot(before, await handle.stat({ bigint: true })) &&
        sameSnapshot(before, await canonical(file)),
      'TEST Node changed while reading'
    );
    return { bytes, byteCount, stat: before, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** Copy a caller-selected TEST dependency. Never executes the copied file or repairs failed custody. */
export async function stageNativeTestNode(sourcePath: string, projectPath: string) {
  assert(
    path.basename(sourcePath) === 'node.exe' &&
      sourcePath.split(path.sep).some((part) => /^TEST-[^/\\]+$/.test(part)),
    'TEST-scoped node.exe source required'
  );
  const project = await canonical(projectPath);
  assert(
    project.isDirectory() && /^TEST-[^/\\]+$/.test(path.basename(projectPath)),
    'TEST project directory required'
  );
  const relativeSource = path.relative(projectPath, sourcePath);
  assert(
    path.isAbsolute(relativeSource) ||
      relativeSource === '..' ||
      relativeSource.startsWith(`..${path.sep}`),
    'TEST Node original source must remain outside the project'
  );
  const source = await readStable(sourcePath, true);
  const sourceStat = source.stat,
    sourceHash = source.sha256,
    byteCount = source.byteCount;
  const directory = path.join(projectPath, 'TEST-node-runtime');
  // Both creations are exclusive. On any later failure the staged bytes remain for inspection.
  await mkdir(directory, { mode: 0o700 });
  const directoryStat = await canonical(directory);
  assert(directoryStat.isDirectory(), 'TEST Node staging directory required');
  const executable = path.join(directory, 'node.exe');
  const output = await open(executable, 'wx', 0o700);
  try {
    await output.writeFile(source.bytes);
    await output.sync();
  } finally {
    await output.close();
  }
  const copied = await readStable(executable);
  assert(
    !sameFile(sourceStat, copied.stat) &&
      copied.sha256 === sourceHash &&
      copied.byteCount === byteCount,
    'TEST Node copy mismatch'
  );
  const verify = async () => {
    assert(
      sameFile(project, await canonical(projectPath)) &&
        sameFile(directoryStat, await canonical(directory)),
      'TEST Node staging directory changed'
    );
    const original = await readStable(sourcePath);
    assert(
      sameSnapshot(sourceStat, original.stat) && original.sha256 === sourceHash,
      'TEST Node source changed'
    );
    const current = await readStable(executable);
    assert(
      !sameFile(original.stat, current.stat) &&
        // Native cohort grants/retirement legitimately update this project's
        // inherited DACL. Only lifetime ctime may differ; mode remains pinned.
        // readStable still requires ctime/mode stability throughout each read.
        sameArtifact(copied.stat, current.stat) &&
        current.sha256 === sourceHash &&
        current.byteCount === byteCount,
      'TEST Node staged copy changed'
    );
  };
  await verify();
  return { executable, sha256: sourceHash, bytes: byteCount, verify };
}
