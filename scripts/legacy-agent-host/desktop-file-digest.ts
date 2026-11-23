import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

const regularChunkSize = 512 * 1024;
const unknownChunkSize = 64 * 1024;

/** Keep Node 24 readFile's initial size and descriptor position without retaining all bytes. */
async function digestHandle(handle: FileHandle): Promise<string> {
  const stat = await handle.stat();
  const size = stat.isFile() ? stat.size : 0;
  if (size > 2 ** 31 - 1) {
    throw Object.assign(new RangeError(`File size (${size}) is greater than 2 GiB`), {
      code: 'ERR_FS_FILE_TOO_LARGE',
    });
  }
  const buffer = Buffer.allocUnsafeSlow(size ? Math.min(size, regularChunkSize) : unknownChunkSize);
  const hash = createHash('sha256');
  const chunked = size > regularChunkSize;
  let totalRead = 0;
  while (true) {
    const length = chunked ? Math.min(size - totalRead, regularChunkSize) : buffer.length;
    const { bytesRead } = await handle.read(buffer, 0, length, null);
    hash.update(buffer.subarray(0, bytesRead));
    totalRead += bytesRead;
    if (bytesRead === 0 || totalRead === size || (!chunked && size !== 0 && bytesRead !== buffer.length)) break;
  }
  return hash.digest('hex');
}

/** Match readFile's operation/close error ordering, including an existing aggregate. */
function aggregateCloseError(operationError: unknown, closeError: unknown): unknown {
  if (operationError && closeError && operationError !== closeError) {
    const outer = operationError as { errors?: unknown[]; message?: string; code?: unknown };
    if (Array.isArray(outer.errors)) {
      outer.errors.push(closeError);
      return operationError;
    }
    return Object.assign(new AggregateError([operationError, closeError], outer.message), {
      code: outer.code,
    });
  }
  return closeError || operationError;
}

/** Every call opens and hashes the current file; no content or readiness cache. */
export async function fileDigest(path: string): Promise<string> {
  const handle = await open(path, 'r');
  return digestHandle(handle).then(
    (result) => handle.close().then(() => result),
    (operationError: unknown) => handle.close().then(
      () => Promise.reject(operationError),
      (closeError: unknown) => Promise.reject(aggregateCloseError(operationError, closeError))
    )
  );
}
