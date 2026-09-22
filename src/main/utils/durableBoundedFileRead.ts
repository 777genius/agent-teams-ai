import type * as fs from 'node:fs';

/** Read an opened receipt without unbounded allocation or an unbounded wait. */
export async function readBoundedFileHandleUtf8Async(
  handle: fs.promises.FileHandle,
  maximumBytes: number,
  maximumDurationMs = 250
): Promise<string> {
  const bytes = Buffer.allocUnsafe(maximumBytes + 1);
  const deadline = Date.now() + maximumDurationMs;
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Durable receipt read exceeded its time limit');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        handle.read(bytes, offset, bytes.length - offset, offset),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Durable receipt read exceeded its time limit')), remaining);
        }),
      ]);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (offset > maximumBytes) throw new Error('Durable receipt exceeds its byte limit');
  return bytes.subarray(0, offset).toString('utf8');
}
