import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import type { ActualOwnerExecutableEvidence, ActualOwnerSourceFileEvidence } from './preflight';

export interface ActualOwnerLaunchAnchor {
  readonly evidence: ActualOwnerExecutableEvidence;
  readonly handle: FileHandle;
  readonly path: string;
}

export interface ActualOwnerSourceAnchor {
  readonly evidence: ActualOwnerSourceFileEvidence;
  readonly handle: FileHandle;
  readonly path: string;
  readonly stagedEvidence: ActualOwnerSourceFileEvidence;
}

async function digest(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const stat = await handle.stat();
  const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, stat.size)));
  let offset = 0;
  while (offset < stat.size) {
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, stat.size - offset),
      offset
    );
    if (bytesRead === 0) throw new Error('hosted_actual_owner_anchor_short_read');
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

export async function stageActualOwnerExecutable(input: {
  readonly label: 'opencode' | 'product';
  readonly source: ActualOwnerExecutableEvidence;
  readonly stageRoot: string;
}): Promise<ActualOwnerLaunchAnchor> {
  const directory = join(input.stageRoot, 'descriptor-bound-executables');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const source = await open(
    input.source.executable,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  const targetPath = join(directory, `${input.label}-${input.source.sha256}`);
  const target = await open(
    targetPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o500
  );
  try {
    const sourceBefore = await source.stat({ bigint: true });
    if (
      sourceBefore.dev.toString() !== input.source.device ||
      sourceBefore.ino.toString() !== input.source.inode ||
      sourceBefore.size !== BigInt(input.source.size) ||
      Number(sourceBefore.mode & 0o777n) !== input.source.mode ||
      sourceBefore.nlink.toString() !== input.source.nlink ||
      sourceBefore.uid.toString() !== input.source.uid ||
      sourceBefore.gid.toString() !== input.source.gid ||
      sourceBefore.mtimeNs.toString() !== input.source.mtimeNs ||
      sourceBefore.ctimeNs.toString() !== input.source.ctimeNs ||
      (await digest(source)) !== input.source.sha256
    ) {
      throw new Error(`hosted_actual_owner_${input.label}_source_rotated_before_stage`);
    }
    const bytes = Buffer.alloc(input.source.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await source.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error('hosted_actual_owner_source_short_read');
      offset += result.bytesRead;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== input.source.sha256) {
      throw new Error(`hosted_actual_owner_${input.label}_source_changed_during_stage`);
    }
    await target.writeFile(bytes);
    await target.sync();
    await target.chmod(0o500);
    const stat = await target.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      Number(stat.mode & 0o777n) !== 0o500 ||
      stat.size !== BigInt(input.source.size) ||
      (await digest(target)) !== input.source.sha256 ||
      (await realpath(targetPath)) !== targetPath
    ) {
      throw new Error(`hosted_actual_owner_${input.label}_staged_copy_invalid`);
    }
    return Object.freeze({
      evidence: Object.freeze({
        ctimeNs: stat.ctimeNs.toString(),
        device: stat.dev.toString(),
        executable: targetPath,
        gid: stat.gid.toString(),
        inode: stat.ino.toString(),
        mode: 0o500,
        mtimeNs: stat.mtimeNs.toString(),
        nlink: stat.nlink.toString(),
        sha256: input.source.sha256,
        size: input.source.size,
        sourceCommit: input.source.sourceCommit,
        uid: stat.uid.toString(),
      }),
      handle: target,
      path: targetPath,
    });
  } catch (error) {
    await target.close();
    throw error;
  } finally {
    await source.close();
  }
}

export async function stageActualOwnerSourceFile(input: {
  readonly executable: boolean;
  readonly label: 'orchestrator-entry' | 'orchestrator-launcher' | 'product-contract';
  readonly source: ActualOwnerSourceFileEvidence;
  readonly stageRoot: string;
}): Promise<ActualOwnerSourceAnchor> {
  const directory = join(input.stageRoot, 'descriptor-bound-sources');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const source = await open(input.source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const targetPath = join(directory, `${input.label}-${input.source.sha256}`);
  const mode = input.executable ? 0o500 : 0o400;
  const target = await open(
    targetPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    mode
  );
  try {
    const stat = await source.stat({ bigint: true });
    if (
      stat.dev.toString() !== input.source.device ||
      stat.ino.toString() !== input.source.inode ||
      stat.nlink !== 1n ||
      stat.size !== BigInt(input.source.size) ||
      Number(stat.mode & 0o777n) !== input.source.mode ||
      (await digest(source)) !== input.source.sha256
    ) {
      throw new Error('hosted_actual_owner_source_anchor_rotated');
    }
    const bytes = Buffer.alloc(input.source.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await source.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('hosted_actual_owner_source_short_read');
      offset += bytesRead;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== input.source.sha256) {
      throw new Error('hosted_actual_owner_source_changed_during_stage');
    }
    await target.writeFile(bytes);
    await target.sync();
    await target.chmod(mode);
    const staged = await target.stat({ bigint: true });
    if (
      !staged.isFile() ||
      staged.nlink !== 1n ||
      Number(staged.mode & 0o777n) !== mode ||
      staged.size !== BigInt(input.source.size) ||
      (await digest(target)) !== input.source.sha256 ||
      (await realpath(targetPath)) !== targetPath
    ) {
      throw new Error('hosted_actual_owner_staged_source_invalid');
    }
    return Object.freeze({
      evidence: input.source,
      handle: target,
      path: targetPath,
      stagedEvidence: Object.freeze({
        ...input.source,
        device: staged.dev.toString(),
        inode: staged.ino.toString(),
        mode,
        path: targetPath,
      }),
    });
  } catch (error) {
    await target.close();
    throw error;
  } finally {
    await source.close();
  }
}

export async function assertActualOwnerAnchorPathIdentity(
  anchor: ActualOwnerLaunchAnchor | ActualOwnerSourceAnchor
): Promise<void> {
  const descriptor = await anchor.handle.stat({ bigint: true });
  const pathname = await open(anchor.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const linked = await pathname.stat({ bigint: true });
    const expected = 'stagedEvidence' in anchor ? anchor.stagedEvidence : anchor.evidence;
    if (
      descriptor.dev.toString() !== expected.device ||
      descriptor.ino.toString() !== expected.inode ||
      linked.dev !== descriptor.dev ||
      linked.ino !== descriptor.ino ||
      descriptor.nlink !== 1n ||
      Number(descriptor.mode & 0o777n) !== expected.mode ||
      (await digest(anchor.handle)) !== anchor.evidence.sha256 ||
      (await digest(pathname)) !== anchor.evidence.sha256 ||
      (await realpath(anchor.path)) !== anchor.path
    ) {
      throw new Error('hosted_actual_owner_staged_anchor_rotated');
    }
  } finally {
    await pathname.close();
  }
}

export async function sealActualOwnerStageDirectories(
  stageRoot: string
): Promise<readonly FileHandle[]> {
  const paths = [
    join(stageRoot, 'descriptor-bound-executables'),
    join(stageRoot, 'descriptor-bound-sources'),
  ];
  const handles: FileHandle[] = [];
  try {
    for (const path of paths) {
      await chmod(path, 0o500);
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
      );
      const stat = await handle.stat({ bigint: true });
      if (!stat.isDirectory() || (stat.mode & 0o777n) !== 0o500n || stat.nlink < 2n) {
        await handle.close();
        throw new Error('hosted_actual_owner_staged_directory_not_sealed');
      }
      handles.push(handle);
    }
    return Object.freeze(handles);
  } catch (error) {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    throw error;
  }
}
