import { gunzipSync, inflateRawSync } from 'node:zlib';

export type HostedOpenCodeArchiveKind = 'tar.gz' | 'zip';

function assertSafeEntry(name: string, type: 'file' | 'link' | 'other'): void {
  const normalized = name.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (normalized.endsWith('/')) parts.pop();
  if (
    !name ||
    name.includes('\\') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    parts.some((part) => part === '..' || part === '') ||
    type === 'link'
  ) {
    throw new Error('hosted_opencode_archive_unsafe_entry');
  }
}

function zipCentralEntries(archive: Buffer): Map<string, 'file' | 'link' | 'other'> {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = archive.lastIndexOf(endSignature);
  if (endOffset < 0 || endOffset + 22 > archive.length)
    throw new Error('hosted_opencode_archive_invalid');
  const count = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  const entries = new Map<string, 'file' | 'link' | 'other'>();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('hosted_opencode_archive_invalid');
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.length) throw new Error('hosted_opencode_archive_invalid');
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    const unixFileType = (externalAttributes >>> 16) & 0xf000;
    const type = unixFileType === 0xa000 ? 'link' : name.endsWith('/') ? 'other' : 'file';
    assertSafeEntry(name, type);
    if (entries.has(name)) throw new Error('hosted_opencode_archive_invalid');
    entries.set(name, type);
    offset = end;
  }
  return entries;
}

function tarString(buffer: Buffer, start: number, length: number): string {
  const zero = buffer.indexOf(0, start);
  return buffer
    .toString('utf8', start, zero >= start && zero < start + length ? zero : start + length)
    .trim();
}

function extractTarGz(archive: Buffer, binaryName: string, maxBinaryBytes: number): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: maxBinaryBytes + 16 * 1024 * 1024 });
  let found: Buffer | null = null;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = tarString(tar, offset, 100);
    if (!name) break;
    const prefix = tarString(tar, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const typeFlag = tarString(tar, offset + 156, 1);
    const type =
      typeFlag === '1' || typeFlag === '2'
        ? 'link'
        : typeFlag === '' || typeFlag === '0'
          ? 'file'
          : 'other';
    assertSafeEntry(fullName, type);
    const size = Number.parseInt(tarString(tar, offset + 124, 12) || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('hosted_opencode_archive_invalid');
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error('hosted_opencode_archive_invalid');
    if (type === 'file' && fullName.split('/').at(-1) === binaryName) {
      if (found || size < 1 || size > maxBinaryBytes)
        throw new Error('hosted_opencode_archive_binary_invalid');
      found = Buffer.from(tar.subarray(start, end));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!found) throw new Error('hosted_opencode_archive_binary_missing');
  return found;
}

function extractZip(archive: Buffer, binaryName: string, maxBinaryBytes: number): Buffer {
  const centralEntries = zipCentralEntries(archive);
  let found: Buffer | null = null;
  for (let offset = 0; offset + 30 <= archive.length; ) {
    if (archive.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    if ((flags & 0x08) !== 0 || (method !== 0 && method !== 8))
      throw new Error('hosted_opencode_archive_invalid');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) throw new Error('hosted_opencode_archive_invalid');
    const name = archive.toString('utf8', nameStart, nameStart + nameLength);
    const type = centralEntries.get(name);
    if (!type) throw new Error('hosted_opencode_archive_invalid');
    assertSafeEntry(name, type);
    if (type === 'file' && name.split('/').at(-1) === binaryName) {
      if (found || uncompressedSize < 1 || uncompressedSize > maxBinaryBytes)
        throw new Error('hosted_opencode_archive_binary_invalid');
      const compressed = archive.subarray(dataStart, dataEnd);
      found =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: maxBinaryBytes });
      if (found.length !== uncompressedSize) throw new Error('hosted_opencode_archive_invalid');
    }
    offset = dataEnd;
  }
  if (!found) throw new Error('hosted_opencode_archive_binary_missing');
  return found;
}

export function extractHostedOpenCodeBinary(
  archive: Buffer,
  archiveKind: HostedOpenCodeArchiveKind,
  binaryName: string,
  maxBinaryBytes = 350 * 1024 * 1024
): Buffer {
  return archiveKind === 'tar.gz'
    ? extractTarGz(archive, binaryName, maxBinaryBytes)
    : extractZip(archive, binaryName, maxBinaryBytes);
}
