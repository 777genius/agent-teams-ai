import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { sha256 } from './canonical';

/** Selected public evidence only. Roots are independently provisioned in the
 * selected executable/module, never read from these artifacts or from FD5. */
export interface ReadonlyArtifactPin {
  readonly relativePath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly sha256: string;
}

function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`selected_readonly_artifact_${reason}`);
}

/** proc files report size zero; checking a completed read's length does not
 * bound allocation. Read at most maximum + 1 bytes from the retained proc file
 * and reject overflow before decoding or splitting mount records. */
function readProcMetadata(path: string, maximum: number, reason: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check(fstatSync(fd).isFile(), 'proc_file');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    check(length <= maximum, reason);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

function readonlyMount(fd: number): void {
  const info = readProcMetadata(`/proc/self/fdinfo/${fd}`, 8192, 'fdinfo_bound');
  const id = /^mnt_id:\s+([0-9]+)$/mu.exec(info)?.[1];
  check(id, 'mount_id');
  const mounts = readProcMetadata('/proc/self/mountinfo', 1024 * 1024, 'mountinfo_bound');
  const matches = mounts.split('\n').filter(line => line.startsWith(`${id} `));
  check(matches.length === 1, 'mount_identity');
  const fields = matches[0].split(' ');
  check(fields.length >= 10 && fields[5].split(',').includes('ro'), 'mount_writable');
}

/** Walk each component under a retained root with O_NOFOLLOW. No path supplied
 * by a document can switch roots, traverse a symlink, or resolve in /sandbox.
 * The caller owns the root descriptor throughout this synchronous operation. */
export function readReadonlyArtifact(rootFd: number, pin: ReadonlyArtifactPin, maximum: number): Buffer {
  const selected = { ...pin };
  check(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 32 * 1024 * 1024 &&
    Number.isSafeInteger(selected.size) && selected.size > 0 && selected.size <= maximum &&
    /^[0-9a-f]{64}$/u.test(selected.sha256) &&
    /^(?:0|[1-9][0-9]{0,19})$/u.test(selected.device) &&
    /^[1-9][0-9]{0,19}$/u.test(selected.inode), 'pin');
  check(typeof selected.relativePath === 'string' &&
    /^[\x21-\x7e]{1,512}$/u.test(selected.relativePath) && !selected.relativePath.includes('\\'), 'path');
  const parts = selected.relativePath.split('/');
  check(parts.every(part => part && part !== '.' && part !== '..'), 'path_segment');
  const root = fstatSync(rootFd, { bigint: true });
  check(root.isDirectory() && root.uid === 0n && !(root.mode & 0o022n), 'root');
  readonlyMount(rootFd);
  const owned: number[] = [];
  let parent = rootFd;
  try {
    for (let index = 0; index < parts.length; index++) {
      const last = index === parts.length - 1;
      const fd = openSync(`/proc/self/fd/${parent}/${parts[index]}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
        (last ? 0 : constants.O_DIRECTORY));
      owned.push(fd);
      const stat = fstatSync(fd, { bigint: true });
      check(stat.uid === 0n && !(stat.mode & 0o022n), 'ownership');
      readonlyMount(fd);
      if (!last) { check(stat.isDirectory(), 'directory'); parent = fd; continue; }
      check(stat.isFile() && stat.nlink === 1n && stat.size === BigInt(selected.size) &&
        String(stat.dev) === selected.device && String(stat.ino) === selected.inode, 'identity');
      const bytes = Buffer.alloc(selected.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        check(count > 0, 'truncated'); offset += count;
      }
      const after = fstatSync(fd, { bigint: true });
      check(after.dev === stat.dev && after.ino === stat.ino && after.size === stat.size &&
        after.mode === stat.mode && after.nlink === stat.nlink && after.uid === stat.uid &&
        after.gid === stat.gid && after.mtimeNs === stat.mtimeNs && after.ctimeNs === stat.ctimeNs &&
        sha256(bytes) === selected.sha256, 'changed');
      readonlyMount(fd);
      return bytes;
    }
    throw new Error('selected_readonly_artifact_empty');
  } finally {
    // Attempt all owned closes without ever closing the borrowed root.
    let failed: unknown;
    for (const fd of owned.reverse()) {
      try { closeSync(fd); } catch (error) { failed ??= error; }
    }
    if (failed) throw failed;
  }
}
