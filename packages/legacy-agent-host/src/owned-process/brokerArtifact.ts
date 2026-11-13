import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { VERSION } from './codec.js';

function boundedFile(path: string, limit: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new Error('Broker admission file exceeds limit');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) {
        throw new Error('Broker admission file changed');
      }
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length))
      throw new Error('Broker admission file changed');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
/** Bounded staged-artifact verification; not a guarantee against a malicious filesystem/OS race. */
export function verifyStagedBroker(path: string, arch: string): void {
  if (basename(path) !== 'owned-process-broker.exe' || (arch !== 'x64' && arch !== 'arm64')) {
    throw new Error('Unsupported staged broker');
  }
  const manifest: unknown = JSON.parse(
    boundedFile(join(dirname(path), 'manifest.json'), 4096).toString('utf8')
  );
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('Invalid broker manifest');
  const m = manifest as Record<string, unknown>;
  if (
    Object.keys(m).sort().join(',') !== 'arch,file,platform,protocol,schema,sha256' ||
    m.schema !== 1 ||
    m.protocol !== VERSION ||
    m.platform !== 'win32' ||
    m.arch !== arch ||
    m.file !== basename(path) ||
    typeof m.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(m.sha256)
  )
    throw new Error('Invalid broker manifest');
  const bytes = boundedFile(path, 16 * 1024 * 1024);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ')
    throw new Error('Invalid broker PE');
  const offset = bytes.readUInt32LE(60);
  if (
    offset > bytes.length - 24 ||
    bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(offset + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64) ||
    createHash('sha256').update(bytes).digest('hex') !== m.sha256
  )
    throw new Error('Broker architecture or digest mismatch');
}
