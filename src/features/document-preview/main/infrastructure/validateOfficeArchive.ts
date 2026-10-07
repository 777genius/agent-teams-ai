import { createInflateRaw } from 'node:zlib';

const MAX_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

/** Check metadata AND actual inflated output without retaining decompressed files.
 * ZIP64, multi-volume and encrypted ZIP containers deliberately use external fallback.
 */
export async function validateOfficeArchive(buffer: Buffer): Promise<void> {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (
      buffer.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('Invalid Office ZIP directory');
  const entries = buffer.readUInt16LE(end + 10);
  const directoryBytes = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (
    buffer.readUInt16LE(end + 4) ||
    buffer.readUInt16LE(end + 6) ||
    buffer.readUInt16LE(end + 8) !== entries ||
    entries === 0 ||
    entries > MAX_ENTRIES ||
    directoryBytes === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directoryBytes !== end
  )
    throw new Error('Unsupported Office ZIP directory');
  const records: { start: number; compressed: number; size: number; method: number }[] = [];
  let cursor = directoryOffset;
  let declaredTotal = 0;
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('Invalid Office ZIP entry');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const commentBytes = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    declaredTotal += size;
    if (
      flags & 0x41 ||
      (method !== 0 && method !== 8) ||
      compressed === 0xffffffff ||
      size > MAX_ENTRY_BYTES ||
      declaredTotal > MAX_TOTAL_BYTES ||
      local === 0xffffffff ||
      buffer.readUInt16LE(cursor + 34) ||
      next > end ||
      local + 30 > directoryOffset ||
      buffer.readUInt32LE(local) !== 0x04034b50
    )
      throw new Error('Unsafe or oversized Office ZIP entry');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (
      start + compressed > directoryOffset ||
      buffer.readUInt16LE(local + 8) !== method ||
      buffer.readUInt16LE(local + 6) & 0x41
    )
      throw new Error('Invalid Office ZIP data');
    // Reject ZIP64 extra records even when the 32-bit fields happen to fit.
    for (let extra = cursor + 46 + nameBytes; extra < cursor + 46 + nameBytes + extraBytes; ) {
      if (extra + 4 > next || buffer.readUInt16LE(extra) === 1)
        throw new Error('Unsupported Office ZIP64');
      extra += 4 + buffer.readUInt16LE(extra + 2);
      if (extra > cursor + 46 + nameBytes + extraBytes)
        throw new Error('Invalid Office ZIP extra data');
    }
    records.push({ start, compressed, size, method });
    cursor = next;
  }
  if (cursor !== end) throw new Error('Invalid Office ZIP directory length');
  let actualTotal = 0;
  for (const record of records) {
    if (record.method === 0) {
      if (record.size !== record.compressed) throw new Error('Invalid stored Office ZIP size');
      actualTotal += record.size;
      continue;
    }
    const inflate = createInflateRaw({ chunkSize: 64 * 1024 });
    inflate.end(buffer.subarray(record.start, record.start + record.compressed));
    let actual = 0;
    try {
      for await (const chunk of inflate) {
        actual += (chunk as Buffer).length;
        actualTotal += (chunk as Buffer).length;
        if (actual > MAX_ENTRY_BYTES || actualTotal > MAX_TOTAL_BYTES || actual > record.size) {
          throw new Error('Office ZIP decompression exceeds preview limits');
        }
      }
      if (actual !== record.size) throw new Error('Invalid inflated Office ZIP size');
    } finally {
      inflate.destroy();
    }
  }
}
