import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { assertRootCurrent, descriptorMountId, procFdPath } from './anchors';
import { sha256 } from './contracts';

import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { RootAnchor } from './anchors';
import type { FilePin } from './contracts';

const identity = (s: BigIntStats): string => [s.dev, s.ino, s.mode, s.nlink,
  s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs].join(':');

/** Direct children only; O_NONBLOCK also bounds malicious FIFO substitution. */
export async function openOwnerWalDiskFile(root: RootAnchor, selection: FilePin): Promise<{
  read: (maximum: number) => Promise<Buffer>;
  current: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const pin = Object.freeze({ ...selection });
  if (!/^(?:owner-wal-images\.reservation|stage-[1-9]\d*\.(?:stage|binding|previous|next))$/u.test(pin.relativePath) ||
    pin.root !== root.name || pin.mode !== 0o400 || pin.nlink !== 1 ||
    !Number.isSafeInteger(pin.size) || pin.size < 0 || pin.size > 32 * 1024 * 1024 ||
    !/^[0-9a-f]{64}$/u.test(pin.sha256))
    throw new Error('p3c_owner_wal_disk_file-pin');
  const acquire = (): Promise<FileHandle> => open(`${procFdPath(root.handle)}/${pin.relativePath}`,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  await assertRootCurrent(root);
  const file = await acquire();
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) ||
      String(before.dev) !== root.identity.device || String(before.dev) !== pin.device ||
      String(before.ino) !== pin.inode || String(before.size) !== String(pin.size) ||
      Number(before.mode & 0o7777n) !== pin.mode || await descriptorMountId(file) !== root.pin.mountId)
      throw new Error('p3c_owner_wal_disk_file-pin');
    const current = async (): Promise<void> => {
      await assertRootCurrent(root);
      const linked = await acquire();
      try {
        if (identity(await linked.stat({ bigint: true })) !== identity(before) ||
          identity(await file.stat({ bigint: true })) !== identity(before) ||
          await descriptorMountId(linked) !== root.pin.mountId)
          throw new Error('p3c_owner_wal_disk_file-changed');
      } finally { await linked.close(); }
    };
    return {
      current,
      close: () => file.close(),
      read: async maximum => {
        if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 32 * 1024 * 1024 ||
          pin.size > maximum)
          throw new Error('p3c_owner_wal_disk_file-size');
        await current();
        const bytes = Buffer.alloc(pin.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error('p3c_owner_wal_disk_short-read');
          offset += bytesRead;
        }
        await current();
        if (sha256(bytes) !== pin.sha256) throw new Error('p3c_owner_wal_disk_file-digest');
        return bytes;
      },
    };
  } catch (error) { await file.close(); throw error; }
}
