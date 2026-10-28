import fs from 'node:fs';

function malformed(): never {
  throw new Error('Malformed runtime ZIP archive');
}
function unsafe(name: string): never {
  throw new Error(`Unsupported runtime archive entry: ${name}`);
}
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) malformed();
  return Number(value);
}
function assertName(name: string): void {
  const normalized = name.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes(':') ||
    [...normalized].some((character) => character.charCodeAt(0) < 32)
  )
    unsafe(name);
  for (const part of normalized.split('/')) {
    if (
      part === '..' ||
      (part !== '.' && /[. ]$/u.test(part)) ||
      /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part)
    )
      unsafe(name);
  }
}
function extras(buffer: Buffer): Map<number, Buffer> {
  const result = new Map<number, Buffer>();
  for (let cursor = 0; cursor < buffer.length; ) {
    if (cursor + 4 > buffer.length) malformed();
    const id = buffer.readUInt16LE(cursor),
      size = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > buffer.length || result.has(id)) malformed();
    // Accept only ZIP64 sizes, NTFS/extended timestamps and Unix uid/gid.
    // Other fields (including local 'xl') can override paths or entry types.
    if (![0x0001, 0x000a, 0x5455, 0x7875].includes(id)) unsafe('unsupported ZIP extra metadata');
    // This allowlist is the current Compress-Archive/Info-ZIP runtime producer
    // contract. Unknown extra fields fail closed until explicitly qualified.
    result.set(id, buffer.subarray(cursor, cursor + size));
    cursor += size;
  }
  return result;
}
export interface ValidatedRuntimeZipEntry {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
  readonly directory: boolean;
}

type Entry = {
  offset: number;
  compressed: number;
  uncompressed: number;
  crc: number;
  flags: number;
  method: number;
  name: Buffer;
  directory: boolean;
};

// Inspect all local records before the native extractor can follow a link or
// write a hostile path. ZIP64 counts are required by the published runtime ZIPs.
export function assertSafeRuntimeZip(archivePath: string): readonly ValidatedRuntimeZipEntry[] {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const read = (offset: number, size: number): Buffer => {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(size) ||
        offset < 0 ||
        size < 0 ||
        offset + size > fileSize
      )
        malformed();
      const bytes = Buffer.alloc(size);
      let done = 0;
      while (done < size) {
        const count = fs.readSync(fd, bytes, done, size - done, offset + done);
        if (!count) malformed();
        done += count;
      }
      return bytes;
    };
    if (fileSize < 22) malformed();
    // Runtime producers emit no comments. A terminal, comment-free EOCD
    // prevents native readers selecting another EOCD hidden in a comment.
    const endOffset = fileSize - 22,
      tail = read(endOffset, 22),
      end = 0;
    if (tail.readUInt32LE(0) !== 0x06054b50 || tail.readUInt16LE(20) !== 0) malformed();
    if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) malformed();
    let count = tail.readUInt16LE(end + 10),
      centralSize = tail.readUInt32LE(end + 12),
      centralOffset = tail.readUInt32LE(end + 16),
      footerOffset = endOffset;
    if (tail.readUInt16LE(end + 8) !== count) malformed();
    const saturated =
      count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
    const hasLocator = endOffset >= 20 && read(endOffset - 20, 4).readUInt32LE(0) === 0x07064b50;
    if (saturated && !hasLocator) malformed();
    // Native libarchive follows a locator even when classic fields fit.
    if (hasLocator) {
      const locator = read(endOffset - 20, 20);
      if (
        locator.readUInt32LE(0) !== 0x07064b50 ||
        locator.readUInt32LE(4) !== 0 ||
        locator.readUInt32LE(16) !== 1
      )
        malformed();
      footerOffset = safeNumber(locator.readBigUInt64LE(8));
      const zip64 = read(footerOffset, 56),
        recordSize = safeNumber(zip64.readBigUInt64LE(4));
      if (
        zip64.readUInt32LE(0) !== 0x06064b50 ||
        recordSize < 44 ||
        recordSize > 16_372 ||
        footerOffset + recordSize + 12 !== endOffset - 20 ||
        zip64.readUInt32LE(16) !== 0 ||
        zip64.readUInt32LE(20) !== 0 ||
        zip64.readBigUInt64LE(24) !== zip64.readBigUInt64LE(32)
      )
        malformed();
      const largeCount = safeNumber(zip64.readBigUInt64LE(32)),
        largeSize = safeNumber(zip64.readBigUInt64LE(40)),
        largeOffset = safeNumber(zip64.readBigUInt64LE(48));
      if (
        (count !== 0xffff && count !== largeCount) ||
        (centralSize !== 0xffffffff && centralSize !== largeSize) ||
        (centralOffset !== 0xffffffff && centralOffset !== largeOffset)
      )
        malformed();
      count = largeCount;
      centralSize = largeSize;
      centralOffset = largeOffset;
    }
    if (centralOffset + centralSize !== footerOffset || count > centralSize / 46) malformed();
    const central = read(centralOffset, centralSize),
      entries: Entry[] = [];
    const paths = new Map<string, boolean>();
    let cursor = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) malformed();
      const nameSize = central.readUInt16LE(cursor + 28),
        extraSize = central.readUInt16LE(cursor + 30),
        commentSize = central.readUInt16LE(cursor + 32);
      const next = cursor + 46 + nameSize + extraSize + commentSize;
      if (commentSize !== 0 || next > central.length || central.readUInt16LE(cursor + 34) !== 0)
        malformed();
      const name = central.subarray(cursor + 46, cursor + 46 + nameSize),
        text = name.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(name)) unsafe('malformed UTF-8 ZIP filename');
      assertName(text);
      const attributes = central.readUInt32LE(cursor + 38),
        type = (attributes >>> 16) & 0xf000;
      if ((type !== 0 && type !== 0x8000 && type !== 0x4000) || (attributes & 0x400) !== 0)
        unsafe(text);
      const key = text
        .replaceAll('\\', '/')
        .split('/')
        .filter((part) => part && part !== '.')
        .join('/')
        .toLowerCase();
      if (!key || paths.has(key)) unsafe(`duplicate ZIP path: ${text}`);
      paths.set(key, type === 0x4000 || (attributes & 0x10) !== 0 || text.endsWith('/'));
      const extra = extras(
        central.subarray(cursor + 46 + nameSize, cursor + 46 + nameSize + extraSize)
      );
      let compressed = central.readUInt32LE(cursor + 20),
        uncompressed = central.readUInt32LE(cursor + 24),
        offset = central.readUInt32LE(cursor + 42),
        extraCursor = 0;
      const large = (): number => {
        const zip64 = extra.get(1);
        if (!zip64 || extraCursor + 8 > zip64.length) malformed();
        const value = safeNumber(zip64.readBigUInt64LE(extraCursor));
        extraCursor += 8;
        return value;
      };
      if (uncompressed === 0xffffffff) uncompressed = large();
      if (compressed === 0xffffffff) compressed = large();
      if (offset === 0xffffffff) offset = large();
      const flags = central.readUInt16LE(cursor + 8);
      if ((flags & ~(0x0800 | 0x0008 | 0x0006)) !== 0) unsafe('unsupported ZIP entry flags');
      const method = central.readUInt16LE(cursor + 10);
      if ((method !== 0 && method !== 8) || (method === 0 && (flags & 8) !== 0))
        unsafe('unsupported ZIP compression method or stored descriptor');
      entries.push({
        offset,
        compressed,
        uncompressed,
        crc: central.readUInt32LE(cursor + 16),
        flags,
        method,
        name,
        directory: paths.get(key) === true,
      });
      cursor = next;
    }
    if (cursor !== central.length) malformed();
    for (const key of paths.keys()) {
      const parts = key.split('/');
      for (let index = 1; index < parts.length; index++) {
        if (paths.get(parts.slice(0, index).join('/')) === false)
          unsafe(`ZIP file used as parent: ${key}`);
      }
    }
    const centralEntries = [...entries];
    entries.sort((left, right) => left.offset - right.offset);
    let localEnd = 0;
    for (const entry of entries) {
      if (entry.offset !== localEnd) malformed();
      const local = read(entry.offset, 30);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) !== entry.flags ||
        local.readUInt16LE(8) !== entry.method
      )
        malformed();
      const nameSize = local.readUInt16LE(26),
        extraSize = local.readUInt16LE(28),
        body = read(entry.offset + 30, nameSize + extraSize);
      if (!body.subarray(0, nameSize).equals(entry.name))
        unsafe('ZIP local/central filename mismatch');
      const extra = extras(body.subarray(nameSize));
      localEnd = entry.offset + 30 + body.length + entry.compressed;
      if (localEnd > centralOffset) malformed();
      if ((entry.flags & 8) !== 0) {
        const localCrc = local.readUInt32LE(14),
          localCompressed = local.readUInt32LE(18),
          localUncompressed = local.readUInt32LE(22);
        if (
          (localCrc !== 0 && localCrc !== entry.crc) ||
          (localCompressed !== 0 &&
            localCompressed !== 0xffffffff &&
            localCompressed !== entry.compressed) ||
          (localUncompressed !== 0 &&
            localUncompressed !== 0xffffffff &&
            localUncompressed !== entry.uncompressed)
        )
          malformed();
        let largeCursor = 0;
        const descriptorSize = (expected: number): void => {
          const large = extra.get(1);
          if (!large || largeCursor + 8 > large.length) malformed();
          const value = safeNumber(large.readBigUInt64LE(largeCursor));
          largeCursor += 8;
          if (value !== 0 && value !== expected) malformed();
        };
        if (localUncompressed === 0xffffffff) descriptorSize(entry.uncompressed);
        if (localCompressed === 0xffffffff) descriptorSize(entry.compressed);
        const signature = read(localEnd, 4).readUInt32LE(0) === 0x08074b50;
        const zip64 =
          local.readUInt32LE(18) === 0xffffffff || local.readUInt32LE(22) === 0xffffffff;
        const descriptor = read(localEnd + (signature ? 4 : 0), zip64 ? 20 : 12);
        if (
          descriptor.readUInt32LE(0) !== entry.crc ||
          (zip64 ? safeNumber(descriptor.readBigUInt64LE(4)) : descriptor.readUInt32LE(4)) !==
            entry.compressed ||
          (zip64 ? safeNumber(descriptor.readBigUInt64LE(12)) : descriptor.readUInt32LE(8)) !==
            entry.uncompressed
        )
          malformed();
        localEnd += descriptor.length + (signature ? 4 : 0);
      } else {
        let compressed = local.readUInt32LE(18),
          uncompressed = local.readUInt32LE(22),
          largeCursor = 0;
        const large = (): number => {
          const zip64 = extra.get(1);
          if (!zip64 || largeCursor + 8 > zip64.length) malformed();
          const value = safeNumber(zip64.readBigUInt64LE(largeCursor));
          largeCursor += 8;
          return value;
        };
        if (uncompressed === 0xffffffff) uncompressed = large();
        if (compressed === 0xffffffff) compressed = large();
        if (
          local.readUInt32LE(14) !== entry.crc ||
          compressed !== entry.compressed ||
          uncompressed !== entry.uncompressed
        )
          malformed();
      }
    }
    if (localEnd !== centralOffset) malformed();
    return centralEntries.map((entry) =>
      Object.freeze({
        name: entry.name.toString('utf8'),
        size: entry.uncompressed,
        compressedSize: entry.compressed,
        crc32: entry.crc,
        directory: entry.directory,
      })
    );
  } finally {
    fs.closeSync(fd);
  }
}
