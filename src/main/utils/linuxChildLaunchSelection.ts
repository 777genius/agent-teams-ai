import { createHash } from 'node:crypto';
import {
  type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync,
  readSync, realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { getSystemErrorName } from 'node:util';

const MANIFEST_ENV = 'AGENT_TEAMS_LINUX_CHILD_EXEC_MANIFEST';
const HASH_ENV = 'AGENT_TEAMS_LINUX_CHILD_EXEC_SHA256';
const hashPattern = /^[a-f0-9]{64}$/;
type Reference = Readonly<{ path: string; sha256: string }>;
type FileIdentity = Readonly<{
  dev: bigint; ino: bigint; size: bigint; mode: bigint; uid: bigint;
  mtimeNs: bigint; ctimeNs: bigint;
}>;
type Selection = Readonly<{
  reference: Reference; binary: string; binarySha256: string;
  manifestIdentity: FileIdentity; binaryIdentity: FileIdentity; directoryIdentity: FileIdentity;
}>;
export type LinuxChildFailureStage = 'selection' | 'options' | 'setup' | 'close-range' | 'exec' | 'status' | 'deadline';

/** An allocated helper refusal is never a Node "no child allocated" event. */
class LinuxChildLaunchFailure extends Error {
  readonly allocated: boolean;
  readonly stage: LinuxChildFailureStage;
  readonly code: string;
  readonly errno?: number;
  readonly processOutcomeUnknown: boolean;
  constructor(stage: LinuxChildFailureStage, allocated: boolean, errno?: number) {
    super('Selected Linux child launch refused at ' + stage);
    this.name = 'LinuxChildLaunchFailure';
    this.stage = stage;
    this.allocated = allocated;
    this.processOutcomeUnknown = allocated && stage !== 'exec';
    this.code = stage === 'exec' && errno !== undefined
      ? getSystemErrorName(-errno) : 'ERR_LINUX_CHILD_LAUNCH_' + stage.toUpperCase().replace('-', '_');
    if (errno !== undefined) this.errno = -errno;
  }
}
export function linuxChildLaunchFailure(
  stage: LinuxChildFailureStage, allocated = false, errno?: number
): Error & { code: string; allocated: boolean; processOutcomeUnknown: boolean } {
  return new LinuxChildLaunchFailure(stage, allocated, errno);
}
const originalAllocationFailures = new WeakSet<Error>();
export function retainLinuxChildAllocationFailure(error: Error): void {
  originalAllocationFailures.add(error);
}
export function isLinuxChildLaunchFailure(error: unknown): boolean {
  return error instanceof LinuxChildLaunchFailure || error instanceof Error && originalAllocationFailures.has(error);
}

function reference(env: Readonly<Record<string, string | undefined>>): Reference | null {
  const path = env[MANIFEST_ENV], sha256 = env[HASH_ENV];
  if (path === undefined && sha256 === undefined) return null;
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 8192 || path.includes('\0') ||
      typeof sha256 !== 'string' || !hashPattern.test(sha256))
    throw linuxChildLaunchFailure('selection');
  return Object.freeze({ path, sha256 });
}
// Read once at module load. A selected but not initialized Main cannot launch a probe.
const startup = Object.freeze({
  [MANIFEST_ENV]: process.env[MANIFEST_ENV], [HASH_ENV]: process.env[HASH_ENV],
  AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: process.env.AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH,
  AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: process.env.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256,
});
let original: Reference | null | undefined;
let originalDescriptor: Reference | null | undefined;
let selected: Selection | null | undefined;
let initializationFailure: Error | undefined;

function identity(info: BigIntStats): FileIdentity {
  return Object.freeze({ dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
    uid: info.uid, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs });
}
function same(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}
function privateDirectory(path: string): FileIdentity {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path ||
      info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o700n)
    throw linuxChildLaunchFailure('selection');
  return identity(info);
}
function checkedFile(path: string, expected: string, maximum: number, executable: boolean) {
  if (realpathSync(path) !== path) throw linuxChildLaunchFailure('selection');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) ||
        (before.mode & 0o077n) !== 0n || (before.mode & 0o400n) === 0n ||
        (executable ? (before.mode & 0o100n) === 0n : (before.mode & 0o111n) !== 0n) ||
        before.size < 1n || before.size > BigInt(maximum))
      throw linuxChildLaunchFailure('selection');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(descriptor, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (length !== Number(before.size) || !same(identity(before), identity(after)) ||
        !same(identity(after), identity(named)) || realpathSync(path) !== path)
      throw linuxChildLaunchFailure('selection');
    const content = bytes.subarray(0, length);
    if (createHash('sha256').update(content).digest('hex') !== expected)
      throw linuxChildLaunchFailure('selection');
    return { content, identity: identity(after) };
  } finally { closeSync(descriptor); }
}
function staticElf(bytes: Buffer): void {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 ||
      bytes[5] !== 1 || bytes[6] !== 1 || bytes.readUInt16LE(16) !== 2 ||
      bytes.readUInt16LE(18) !== 62 || bytes.readUInt16LE(52) !== 64 ||
      bytes.readUInt16LE(54) !== 56)
    throw linuxChildLaunchFailure('selection');
  const offset = Number(bytes.readBigUInt64LE(32)), count = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || offset < 64 || count < 1 || count > 128 ||
      offset + count * 56 > bytes.length) throw linuxChildLaunchFailure('selection');
  let load = false;
  for (let index = 0; index < count; index++) {
    const header = offset + index * 56, type = bytes.readUInt32LE(header);
    if (type === 3) throw linuxChildLaunchFailure('selection'); // PT_INTERP
    if (type === 1) load = true;
    if (type !== 2) continue;
    const start = Number(bytes.readBigUInt64LE(header + 8)), size = Number(bytes.readBigUInt64LE(header + 32));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 ||
        size < 16 || size % 16 !== 0 || start + size > bytes.length)
      throw linuxChildLaunchFailure('selection');
    let terminated = false;
    for (let entry = start; entry < start + size; entry += 16) {
      const tag = bytes.readBigInt64LE(entry);
      if (tag === 1n) throw linuxChildLaunchFailure('selection'); // DT_NEEDED
      if (tag === 0n) { terminated = true; break; }
    }
    if (!terminated) throw linuxChildLaunchFailure('selection');
  }
  if (!load) throw linuxChildLaunchFailure('selection');
}
function inspect(pin: Reference): Selection {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw linuxChildLaunchFailure('selection');
  const directory = dirname(pin.path), directoryIdentity = privateDirectory(directory);
  const manifest = checkedFile(pin.path, pin.sha256, 16 * 1024, false);
  const value: unknown = JSON.parse(manifest.content.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw linuxChildLaunchFailure('selection');
  const row = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'platform', 'architecture', 'protocol', 'kernelCapability', 'binary',
    'binarySha256', 'sourceSha256', 'compilerSha256', 'inspectorSha256', 'buildKernelRelease', 'linkInputs'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) ||
      row.schemaVersion !== 1 || row.platform !== 'linux' || row.architecture !== 'x64' ||
      row.protocol !== 'linux-child-exec-v1' || row.kernelCapability !== 'close-range-v1' ||
      row.binary !== 'linux-child-exec' || typeof row.buildKernelRelease !== 'string' ||
      row.buildKernelRelease.length < 1 || row.buildKernelRelease.length > 256 ||
      ['binarySha256', 'sourceSha256', 'compilerSha256', 'inspectorSha256'].some(
        key => typeof row[key] !== 'string' || !hashPattern.test(row[key])) ||
      !Array.isArray(row.linkInputs) || row.linkInputs.length < 1 || row.linkInputs.length > 64)
    throw linuxChildLaunchFailure('selection');
  const names = new Set<string>();
  for (const input of row.linkInputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 2 || typeof input.file !== 'string' || !isAbsolute(input.file) ||
        input.file.length > 8192 || input.file.includes('\0') || names.has(input.file) ||
        typeof input.sha256 !== 'string' || !hashPattern.test(input.sha256))
      throw linuxChildLaunchFailure('selection');
    names.add(input.file);
  }
  const binary = join(directory, 'linux-child-exec'), binarySha256 = row.binarySha256 as string;
  const checked = checkedFile(binary, binarySha256, 8 * 1024 * 1024, true);
  staticElf(checked.content);
  if (!same(directoryIdentity, privateDirectory(directory))) throw linuxChildLaunchFailure('selection');
  return Object.freeze({ reference: pin, binary, binarySha256, directoryIdentity,
    manifestIdentity: manifest.identity, binaryIdentity: checked.identity });
}

function descriptorReference(env: Readonly<Record<string, string | undefined>>): Reference | null {
  return reference({ [MANIFEST_ENV]: env.AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH,
    [HASH_ENV]: env.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 });
}

/** Called only by the original Main backend composition, before its first probe. */
export function initializeLinuxChildLaunch(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (initializationFailure) throw initializationFailure;
  try {
    const pin = reference(env), requested = reference(startup);
    const descriptor = pin ? descriptorReference(env) : null;
    if (JSON.stringify(pin) !== JSON.stringify(requested) ||
        pin && JSON.stringify(descriptor) !== JSON.stringify(descriptorReference(startup)))
      throw linuxChildLaunchFailure('selection');
    if (selected !== undefined) {
      if (JSON.stringify(pin) !== JSON.stringify(original) ||
          JSON.stringify(descriptor) !== JSON.stringify(originalDescriptor)) throw linuxChildLaunchFailure('selection');
      return;
    }
    original = pin;
    originalDescriptor = descriptor;
    selected = pin ? inspect(pin) : null;
  } catch (error) {
    initializationFailure = isLinuxChildLaunchFailure(error) && error instanceof Error
      ? error : linuxChildLaunchFailure('selection');
    throw initializationFailure;
  }
}

/** Each original allocation checks the retained files; it never recaptures a replacement. */
export function selectedLinuxChildExecutable(): string | null {
  if (initializationFailure) throw initializationFailure;
  if (selected === undefined) {
    if (reference(startup)) throw linuxChildLaunchFailure('selection');
    return null;
  }
  if (selected === null) return null;
  try {
    const current = inspect(selected.reference);
    if (!same(selected.manifestIdentity, current.manifestIdentity) ||
        !same(selected.binaryIdentity, current.binaryIdentity) ||
        !same(selected.directoryIdentity, current.directoryIdentity))
      throw linuxChildLaunchFailure('selection');
    return selected.binary;
  } catch (error) {
    throw isLinuxChildLaunchFailure(error) ? error : linuxChildLaunchFailure('selection');
  }
}

/** The TEST staging caller can verify its pin without installing a Main selection. */
export function verifyLinuxChildExecInput(pin: Readonly<{ manifestPath: string; manifestSha256: string }>) {
  const captured = reference({ [MANIFEST_ENV]: pin.manifestPath, [HASH_ENV]: pin.manifestSha256 });
  if (!captured) throw linuxChildLaunchFailure('selection');
  const checked = inspect(captured);
  return Object.freeze({ manifestPath: checked.reference.path, manifestSha256: checked.reference.sha256,
    binarySha256: checked.binarySha256 });
}

/** Only a validated original exec frame justifies the intended target projection. */
export function withLinuxChildExecTarget(error: Error, command: string, args: readonly string[]): Error {
  if (error instanceof LinuxChildLaunchFailure && error.stage === 'exec')
    Object.assign(error, { path: command, spawnargs: Object.freeze([...args]), syscall: 'execvp ' + command });
  return error;
}
