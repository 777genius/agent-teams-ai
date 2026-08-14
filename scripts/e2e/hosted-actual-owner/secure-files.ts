import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, rename, type FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

type Identity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  gid: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function identity(stat: Stats | import('node:fs').BigIntStats): Identity {
  const value = stat as import('node:fs').BigIntStats;
  return Object.freeze({
    dev: BigInt(value.dev),
    ino: BigInt(value.ino),
    mode: BigInt(value.mode),
    nlink: BigInt(value.nlink),
    uid: BigInt(value.uid),
    gid: BigInt(value.gid),
    size: BigInt(value.size),
    mtimeNs: value.mtimeNs ?? BigInt(Math.trunc(Number(value.mtimeMs) * 1_000_000)),
    ctimeNs: value.ctimeNs ?? BigInt(Math.trunc(Number(value.ctimeMs) * 1_000_000)),
  });
}

function same(left: Identity, right: Identity): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof Identity] === right[key as keyof Identity]
  );
}

async function anchoredParent(path: string): Promise<
  Readonly<{
    handle: FileHandle;
    identity: Identity;
    anchoredPath: string;
  }>
> {
  if (resolve(path) !== path || (await realpath(dirname(path))) !== dirname(path)) {
    throw new Error('hosted_actual_owner_parent_not_canonical');
  }
  const handle = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const descriptor = await handle.stat({ bigint: true });
    const linked = await lstat(dirname(path), { bigint: true });
    if (
      !descriptor.isDirectory() ||
      descriptor.dev !== linked.dev ||
      descriptor.ino !== linked.ino ||
      (descriptor.mode & 0o022n) !== 0n ||
      descriptor.uid !== BigInt(process.getuid?.() ?? -1)
    ) {
      throw new Error('hosted_actual_owner_parent_identity_invalid');
    }
    return Object.freeze({
      handle,
      identity: identity(descriptor),
      anchoredPath: `/proc/self/fd/${handle.fd}/${basename(path)}`,
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertParentCurrent(path: string, expected: Identity): Promise<void> {
  const current = identity(await lstat(dirname(path), { bigint: true }));
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mode !== expected.mode ||
    current.nlink !== expected.nlink ||
    current.uid !== expected.uid ||
    current.gid !== expected.gid
  ) {
    throw new Error('hosted_actual_owner_parent_identity_drift');
  }
}

export async function readAnchoredPrivateFile(
  path: string,
  input: { readonly minimumBytes: number; readonly maximumBytes: number }
): Promise<Buffer> {
  const parent = await anchoredParent(path);
  try {
    const handle = await open(
      parent.anchoredPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      const beforeStat = await handle.stat({ bigint: true });
      const before = identity(beforeStat);
      if (
        !beforeStat.isFile() ||
        beforeStat.nlink !== 1n ||
        Number(beforeStat.mode & 0o077n) !== 0 ||
        beforeStat.size < BigInt(input.minimumBytes) ||
        beforeStat.size > BigInt(input.maximumBytes) ||
        beforeStat.size > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new Error('hosted_actual_owner_capture_invalid');
      }
      const contents = Buffer.alloc(Number(beforeStat.size));
      let offset = 0;
      while (offset < contents.length) {
        const result = await handle.read(contents, offset, contents.length - offset, offset);
        if (result.bytesRead === 0)
          throw new Error('hosted_actual_owner_capture_changed_during_read');
        offset += result.bytesRead;
      }
      if (!same(before, identity(await handle.stat({ bigint: true })))) {
        throw new Error('hosted_actual_owner_capture_changed_during_read');
      }
      await assertParentCurrent(path, parent.identity);
      return contents;
    } finally {
      await handle.close();
    }
  } finally {
    await parent.handle.close();
  }
}

export async function atomicAnchoredPrivateFile(path: string, bytes: Buffer): Promise<void> {
  const parent = await anchoredParent(path);
  const temporaryName = `.actual-owner-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  const temporary = `/proc/self/fd/${parent.handle.fd}/${temporaryName}`;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || Number(stat.mode & 0o777n) !== 0o600) {
        throw new Error('hosted_actual_owner_evidence_temporary_invalid');
      }
    } finally {
      await handle.close();
    }
    await assertParentCurrent(path, parent.identity);
    await rename(temporary, parent.anchoredPath);
    await parent.handle.sync();
    await assertParentCurrent(path, parent.identity);
    const published = await open(
      parent.anchoredPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      const stat = await published.stat({ bigint: true });
      const content = Buffer.alloc(bytes.length);
      let offset = 0;
      while (offset < content.length) {
        const result = await published.read(content, offset, content.length - offset, offset);
        if (result.bytesRead === 0)
          throw new Error('hosted_actual_owner_evidence_publish_short_read');
        offset += result.bytesRead;
      }
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        Number(stat.mode & 0o777n) !== 0o600 ||
        !content.equals(bytes)
      ) {
        throw new Error('hosted_actual_owner_evidence_publish_invalid');
      }
    } finally {
      await published.close();
    }
  } finally {
    await parent.handle.close();
  }
}

export async function withAnchoredOutputPath<T>(
  path: string,
  operation: (anchoredPath: string) => Promise<T>
): Promise<T> {
  const parent = await anchoredParent(path);
  try {
    const result = await operation(parent.anchoredPath);
    await assertParentCurrent(path, parent.identity);
    return result;
  } finally {
    await parent.handle.close();
  }
}

export async function chmodAnchoredPrivateFile(path: string): Promise<void> {
  const parent = await anchoredParent(path);
  try {
    const handle = await open(parent.anchoredPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) {
        throw new Error('hosted_actual_owner_anchored_output_invalid');
      }
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertParentCurrent(path, parent.identity);
  } finally {
    await parent.handle.close();
  }
}
