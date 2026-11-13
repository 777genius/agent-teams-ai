import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { BigIntStats } from 'node:fs';

// This association is updated only with the reviewed native source and its qualification.
export const LINUX_NODE_EXEC_SOURCE_SHA256 = '4a6e27406a7c1125cadcef66fc54cf10160b82d920a9b7d516f01ca467426dd3';
const FILE_NAME = 'node-exec';
const MANIFEST_NAME = 'manifest.json';
const DIGEST = /^[a-f0-9]{64}$/;
type Identity = Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>;

export interface LinuxNodeExecArtifact {
  readonly directory: string;
  readonly path: string;
  readonly manifestSha256: string;
  readonly binarySha256: string;
  readonly directoryIdentity: Readonly<Identity>;
  readonly manifestIdentity: Readonly<Identity>;
  readonly binaryIdentity: Readonly<Identity>;
}

const invalid = (): Error => new Error('Linux Node process launcher is unavailable or changed');
const identity = (stat: BigIntStats): Readonly<Identity> => Object.freeze({
  dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
});
const same = (left: Readonly<Identity>, right: Readonly<Identity>): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

function readOriginalFile(path: string, maximum: number, executable = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximum) ||
        (before.mode & 0o022n) !== 0n || (executable && (before.mode & 0o111n) === 0n))
      throw invalid();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (length !== Number(before.size) || !same(before, after) || !same(before, named) ||
        named.isSymbolicLink() || realpathSync(path) !== path)
      throw invalid();
    const content = bytes.subarray(0, length);
    return { bytes: content, sha256: createHash('sha256').update(content).digest('hex'),
      identity: identity(before) };
  } finally {
    closeSync(fd);
  }
}

/** Reject a dynamic loader dependency: this small Linux stage must not raise the app's libc floor. */
export function assertStaticLinuxNodeExec(bytes: Buffer): void {
  if (bytes.length < 64 || bytes.subarray(0, 7).toString('hex') !== '7f454c46020101' ||
      bytes.readUInt16LE(18) !== 62 || ![2, 3].includes(bytes.readUInt16LE(16)))
    throw invalid();
  const offset = bytes.readBigUInt64LE(32), entrySize = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56);
  if (offset > BigInt(bytes.length) || entrySize < 56 || !count || count > 128 ||
      offset + BigInt(entrySize * count) > BigInt(bytes.length))
    throw invalid();
  for (let index = 0; index < count; index++) {
    const type = bytes.readUInt32LE(Number(offset) + index * entrySize);
    // The qualified static executable has neither PT_INTERP nor PT_DYNAMIC.
    if (type === 3 || type === 2) throw invalid();
  }
}

/** Trusted app resource directory only. No renderer/tool argument selects this artifact. */
export function captureLinuxNodeExecArtifact(directory: string): LinuxNodeExecArtifact {
  if (process.platform !== 'linux' || process.arch !== 'x64' ||
      !isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory)
    throw invalid();
  const before = lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o022n) !== 0n ||
      readdirSync(directory).sort().join(',') !== 'manifest.json,node-exec')
    throw invalid();
  const manifest = readOriginalFile(join(directory, MANIFEST_NAME), 16 * 1024);
  const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes));
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw invalid();
  const row = record as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !==
      'architecture,binarySha256,compilerSha256,file,platform,schemaVersion,sourceSha256,static' ||
      row.schemaVersion !== 1 || row.platform !== 'linux' || row.architecture !== 'x64' ||
      row.file !== FILE_NAME || row.static !== true ||
      row.sourceSha256 !== LINUX_NODE_EXEC_SOURCE_SHA256 ||
      typeof row.binarySha256 !== 'string' || !DIGEST.test(row.binarySha256) ||
      typeof row.compilerSha256 !== 'string' || !DIGEST.test(row.compilerSha256))
    throw invalid();
  const path = join(directory, FILE_NAME), binary = readOriginalFile(path, 4 * 1024 * 1024, true);
  if (binary.sha256 !== row.binarySha256) throw invalid();
  assertStaticLinuxNodeExec(binary.bytes);
  accessSync(path, constants.X_OK);
  const after = lstatSync(directory, { bigint: true });
  if (!same(before, after)) throw invalid();
  return Object.freeze({
    directory, path, manifestSha256: manifest.sha256, binarySha256: binary.sha256,
    directoryIdentity: identity(before), manifestIdentity: manifest.identity, binaryIdentity: binary.identity,
  });
}

/** Recheck the captured artifact without adopting a replacement directory or image. */
export function validateLinuxNodeExecArtifact(selected: LinuxNodeExecArtifact): void {
  const current = captureLinuxNodeExecArtifact(selected.directory);
  if (current.path !== selected.path || current.manifestSha256 !== selected.manifestSha256 ||
      current.binarySha256 !== selected.binarySha256 ||
      !same(current.directoryIdentity, selected.directoryIdentity) ||
      !same(current.manifestIdentity, selected.manifestIdentity) ||
      !same(current.binaryIdentity, selected.binaryIdentity))
    throw invalid();
}
