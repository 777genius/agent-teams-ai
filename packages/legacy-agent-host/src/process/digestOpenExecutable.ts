import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';

/** Node 24 readFileSync(fd) byte range, without retaining the whole executable image.
 * The caller owns the descriptor and every before/after file and native custody check. */
export function digestOpenExecutable(file: number): string {
  const hash = createHash('sha256');
  let info: ReturnType<typeof fstatSync>;
  try { info = fstatSync(file); } catch {
    // Node's failed internal fstat leaves a borrowed descriptor open, then rejects here.
    throw new TypeError("Cannot read properties of undefined (reading '1')");
  }
  const size = info.isFile() ? Number(info.size) : 0;
  if (size > 2 ** 31 - 1) throw Object.assign(
    new RangeError(`File size (${size}) is greater than 2 GiB`), { code: 'ERR_FS_FILE_TOO_LARGE' });
  const buffer = Buffer.allocUnsafe(size === 0 ? 8192 : Math.min(size, 512 * 1024));
  let offset = 0;
  do {
    const count = readSync(file, buffer, 0,
      size === 0 ? buffer.length : Math.min(buffer.length, size - offset), null);
    if (!count) break;
    hash.update(buffer.subarray(0, count));
    offset += count;
  } while (size === 0 || offset < size);
  // Match the final unknown-size readFileSync concat bound without allocating the image.
  if (size === 0 && offset > bufferConstants.MAX_LENGTH) Buffer.concat([Buffer.alloc(0)], offset);
  return hash.digest('hex');
}
