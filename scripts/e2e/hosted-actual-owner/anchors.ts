import { constants } from 'node:fs';
import { open, readFile, realpath, type FileHandle } from 'node:fs/promises';

import { type FilePin, type RootName, type RootPin, safeRelativePath } from './contracts';

interface StableIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly nlink: string;
  readonly uid: string;
  readonly gid: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface RootAnchor {
  readonly name: RootName;
  readonly pin: RootPin;
  readonly handle: FileHandle;
  readonly identity: StableIdentity;
}

export interface FileAnchor {
  readonly pin: FilePin;
  readonly root: RootAnchor;
  readonly handle: FileHandle;
  readonly identity: StableIdentity;
}

function fdPath(handle: FileHandle, child?: string): string {
  return `/proc/self/fd/${handle.fd}${child ? `/${child}` : ''}`;
}

function identity(stat: import('node:fs').BigIntStats): StableIdentity {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: Number(stat.mode & 0o777n),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameIdentity(left: StableIdentity, right: StableIdentity): boolean {
  return (Object.keys(left) as Array<keyof StableIdentity>).every(
    (key) => left[key] === right[key]
  );
}

function sameRootIdentity(left: StableIdentity, right: StableIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

export async function descriptorMountId(handle: FileHandle): Promise<string> {
  const source = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  const matches = [...source.matchAll(/^mnt_id:\s+(\d+)$/gmu)];
  if (matches.length !== 1) throw new Error('p3c_anchor_mount_identity_missing');
  return matches[0][1];
}

function assertOwnedPrivateDirectory(stat: import('node:fs').BigIntStats): void {
  const expectedUid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.nlink < 2n ||
    Number(stat.mode & 0o777n) !== 0o700 ||
    expectedUid === undefined ||
    stat.uid !== BigInt(expectedUid)
  )
    throw new Error('p3c_anchor_private_directory');
}

export async function openRootAnchor(name: RootName, pin: RootPin): Promise<RootAnchor> {
  if ((await realpath(pin.path)) !== pin.path) throw new Error('p3c_anchor_root_not_canonical');
  const handle = await open(
    pin.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const before = await handle.stat({ bigint: true });
    assertOwnedPrivateDirectory(before);
    const observed = identity(before);
    if (
      observed.device !== pin.device ||
      observed.inode !== pin.inode ||
      observed.mode !== pin.mode ||
      (await descriptorMountId(handle)) !== pin.mountId
    )
      throw new Error('p3c_anchor_root_pin');
    const after = identity(await handle.stat({ bigint: true }));
    if (!sameIdentity(observed, after)) throw new Error('p3c_anchor_root_rotated');
    const anchor = Object.freeze({ name, pin, handle, identity: observed });
    await assertRootCurrent(anchor);
    return anchor;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function assertRootCurrent(root: RootAnchor): Promise<void> {
  const before = identity(await root.handle.stat({ bigint: true }));
  if (!sameRootIdentity(before, root.identity))
    throw new Error('p3c_anchor_root_no_longer_current');
  const pathname = await open(
    root.pin.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const linked = identity(await pathname.stat({ bigint: true }));
    const after = identity(await root.handle.stat({ bigint: true }));
    if (
      !sameRootIdentity(after, root.identity) ||
      !sameRootIdentity(linked, root.identity) ||
      (await realpath(root.pin.path)) !== root.pin.path ||
      (await descriptorMountId(root.handle)) !== root.pin.mountId ||
      (await descriptorMountId(pathname)) !== root.pin.mountId
    )
      throw new Error('p3c_anchor_root_no_longer_current');
  } finally {
    await pathname.close();
  }
}

async function openDirectorySegment(
  parent: FileHandle,
  segment: string,
  root: RootAnchor
): Promise<FileHandle> {
  const handle = await open(
    fdPath(parent, segment),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const stat = await handle.stat({ bigint: true });
    assertOwnedPrivateDirectory(stat);
    if (
      String(stat.dev) !== root.identity.device ||
      (await descriptorMountId(handle)) !== root.pin.mountId
    )
      throw new Error('p3c_anchor_cross_device_directory');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function openFileAnchor(root: RootAnchor, pin: FilePin): Promise<FileAnchor> {
  if (pin.root !== root.name) throw new Error('p3c_anchor_wrong_root');
  await assertRootCurrent(root);
  const path = safeRelativePath(pin.relativePath);
  const segments = path.split('/');
  const intermediates: FileHandle[] = [];
  let parent = root.handle;
  try {
    for (const segment of segments.slice(0, -1)) {
      const child = await openDirectorySegment(parent, segment, root);
      intermediates.push(child);
      parent = child;
    }
    const handle = await open(
      fdPath(parent, segments.at(-1)),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const before = await handle.stat({ bigint: true });
      const observed = identity(before);
      const expectedUid = process.getuid?.();
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        expectedUid === undefined ||
        before.uid !== BigInt(expectedUid) ||
        observed.device !== pin.device ||
        observed.device !== root.identity.device ||
        observed.inode !== pin.inode ||
        observed.size !== String(pin.size) ||
        observed.mode !== pin.mode ||
        observed.nlink !== '1' ||
        (await descriptorMountId(handle)) !== root.pin.mountId
      )
        throw new Error('p3c_anchor_file_pin');
      const after = identity(await handle.stat({ bigint: true }));
      if (!sameIdentity(observed, after)) throw new Error('p3c_anchor_file_rotated');
      return Object.freeze({ pin, root, handle, identity: observed });
    } catch (error) {
      await handle.close();
      throw error;
    }
  } finally {
    await Promise.allSettled(intermediates.map((handle) => handle.close()));
  }
}

export async function assertFileCurrent(file: FileAnchor): Promise<void> {
  await assertRootCurrent(file.root);
  const descriptor = identity(await file.handle.stat({ bigint: true }));
  if (!sameIdentity(descriptor, file.identity))
    throw new Error('p3c_anchor_file_no_longer_current');
  const pathname = await openFileAnchor(file.root, file.pin);
  try {
    if (!sameIdentity(pathname.identity, file.identity))
      throw new Error('p3c_anchor_file_path_replaced');
  } finally {
    await pathname.handle.close();
  }
}

export async function closeAnchors(anchors: readonly (RootAnchor | FileAnchor)[]): Promise<void> {
  await Promise.allSettled(anchors.map((anchor) => anchor.handle.close()));
}

export function procFdPath(handle: FileHandle): string {
  return fdPath(handle);
}
