import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { TeamOwnerError } from '../../team/contracts.js';
import { GroupChatError } from '../../group-chats/model.js';
const LIMIT = 10 * 1024 * 1024;
/** Exact bounded bytes, read only inside the existing Team authority fence. */
export function readGroupFile(file: string): unknown {
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > LIMIT)
      throw new TeamOwnerError('hold');
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new TeamOwnerError('hold');
    const bytes = Buffer.alloc(LIMIT + 1);
    let size = 0,
      count: number;
    while (
      size < bytes.length &&
      (count = readSync(fd, bytes, size, bytes.length - size, size)) > 0
    )
      size += count;
    const after = fstatSync(fd),
      pathAfter = lstatSync(file);
    if (
      size > LIMIT ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    )
      throw new TeamOwnerError('hold');
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size))
    ) as unknown;
  } catch (error) {
    if (fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new GroupChatError('storage-unavailable', 'Group storage is unreadable or changed');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function writeGroupFile(
  file: string,
  value: unknown,
  publish: (file: string, value: unknown) => void
): void {
  if (Buffer.byteLength(JSON.stringify(value)) > LIMIT)
    throw new GroupChatError('storage-unavailable', 'Group storage size limit reached');
  publish(file, value);
}
