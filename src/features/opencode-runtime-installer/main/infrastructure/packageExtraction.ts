import { gunzipSync } from 'zlib';

const MAX_BINARY_BYTES = 350 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

function tarString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  return buffer
    .toString('utf8', start, end >= start && end < start + length ? end : start + length)
    .trim();
}

/** Read only allowlisted files; inspect the entire archive before accepting any bytes. */
export function extractOpenCodePackage(
  tarball: Buffer,
  executableName: string,
  identity?: { packageName: string; version: string }
): { binary: Buffer; packageJson?: Buffer } {
  const tar = gunzipSync(tarball, { maxOutputLength: MAX_BINARY_BYTES + 1024 * 1024 });
  const target = `package/bin/${executableName}`;
  let binary: Buffer | undefined;
  let packageJson: Buffer | undefined;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = tarString(tar, offset, 100);
    if (!name) break;
    const prefix = tarString(tar, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (
      !fullName ||
      fullName.startsWith('/') ||
      fullName.startsWith('\\') ||
      fullName.includes('..') ||
      fullName.includes('\\') ||
      /^[a-z]:/i.test(fullName)
    )
      throw new Error(`Unsafe OpenCode package tar entry: ${fullName}`);
    const sizeText = tarString(tar, offset + 124, 12);
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid OpenCode package tar entry size');
    const size = Number.parseInt(sizeText, 8);
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end > tar.length)
      throw new Error('OpenCode package tar entry exceeds archive bounds');
    const type = tarString(tar, offset + 156, 1);
    if (!['', '0', '5'].includes(type))
      throw new Error('OpenCode package contains a non-regular entry');
    if (type !== '5' && fullName === target) {
      if (binary || size <= 0 || size > MAX_BINARY_BYTES)
        throw new Error('OpenCode binary size or duplicate entry is invalid');
      binary = tar.subarray(start, end);
    }
    if (type !== '5' && fullName === 'package/package.json') {
      if (packageJson || size <= 0 || size > MAX_METADATA_BYTES)
        throw new Error('OpenCode package metadata size or duplicate entry is invalid');
      packageJson = tar.subarray(start, end);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!binary) throw new Error(`OpenCode package did not contain ${target}`);
  if (identity) {
    const magic = binary.subarray(0, 4).toString('hex');
    const native =
      process.platform === 'linux'
        ? magic === '7f454c46'
        : process.platform === 'win32'
          ? magic.startsWith('4d5a')
          : ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(
              magic
            );
    if (!native) throw new Error('OpenCode V2 package did not contain a native executable');
    const metadata: unknown = packageJson ? JSON.parse(packageJson.toString('utf8')) : null;
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      (metadata as { name?: unknown }).name !== identity.packageName ||
      (metadata as { version?: unknown }).version !== identity.version
    )
      throw new Error('OpenCode native package metadata identity mismatch');
  }
  return { binary, ...(identity ? { packageJson } : {}) };
}
