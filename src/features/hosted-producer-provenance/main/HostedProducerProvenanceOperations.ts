import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fdatasyncSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from 'node:fs';

const DECIMAL = /^(?:0|[1-9]\d*)$/u;

export interface HostedProducerDerivedIdentity {
  readonly pid: number;
  readonly startTicks: string;
  readonly exeDevice: string;
  readonly exeInode: string;
  readonly exeSha256: string;
  readonly moduleDevice: string;
  readonly moduleInode: string;
  readonly moduleSha256: string;
}

interface DescriptorIdentity {
  readonly device: string;
  readonly inode: string;
  readonly regularFile: boolean;
  readonly append: boolean;
  readonly writeOnly: boolean;
  readonly mode: number;
  readonly nlink: string;
  readonly size: string;
}

export interface HostedProducerProvenanceOperations {
  readonly deriveIdentity: (modulePath: string) => HostedProducerDerivedIdentity;
  readonly descriptorIdentity: (fd: number) => DescriptorIdentity;
  readonly randomNonce: () => string;
  readonly write: (fd: number, bytes: Uint8Array, offset: number) => number;
  readonly sync: (fd: number) => void;
  readonly close: (fd: number) => void;
}

function hashOpenFile(path: string): {
  readonly device: string;
  readonly inode: string;
  readonly sha256: string;
} {
  const fd = openSync(path, 'r');
  try {
    const identity = fstatSync(fd, { bigint: true });
    if (!identity.isFile()) throw new TypeError('producer-provenance-identity-not-file');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return Object.freeze({
      device: identity.dev.toString(),
      inode: identity.ino.toString(),
      sha256: digest.digest('hex'),
    });
  } finally {
    closeSync(fd);
  }
}

function processStartTicks(): string {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const commandEnd = stat.lastIndexOf(') ');
  if (commandEnd < 0) throw new TypeError('producer-provenance-process-stat');
  const fieldsAfterCommand = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTicks = fieldsAfterCommand[19];
  if (startTicks === undefined || !DECIMAL.test(startTicks)) {
    throw new TypeError('producer-provenance-process-stat');
  }
  return startTicks;
}

export function defaultHostedProducerProvenanceOperations(): HostedProducerProvenanceOperations {
  return Object.freeze({
    deriveIdentity(modulePath: string): HostedProducerDerivedIdentity {
      const executable = hashOpenFile('/proc/self/exe');
      const module = hashOpenFile(modulePath);
      return Object.freeze({
        pid: process.pid,
        startTicks: processStartTicks(),
        exeDevice: executable.device,
        exeInode: executable.inode,
        exeSha256: executable.sha256,
        moduleDevice: module.device,
        moduleInode: module.inode,
        moduleSha256: module.sha256,
      });
    },
    descriptorIdentity(fd: number): DescriptorIdentity {
      const identity = fstatSync(fd, { bigint: true });
      if (process.platform !== 'linux') {
        throw new TypeError('producer-provenance-descriptor-flags-unavailable');
      }
      const flagsSource = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
      const flagsMatch = /^flags:\s+([0-7]+)$/mu.exec(flagsSource);
      if (flagsMatch === null) throw new TypeError('producer-provenance-descriptor-flags');
      const flags = Number.parseInt(flagsMatch[1]!, 8);
      return Object.freeze({
        device: identity.dev.toString(),
        inode: identity.ino.toString(),
        regularFile: identity.isFile(),
        append: (flags & constants.O_APPEND) !== 0,
        writeOnly: (flags & 3) === constants.O_WRONLY,
        mode: Number(identity.mode & 0o777n),
        nlink: identity.nlink.toString(),
        size: identity.size.toString(),
      });
    },
    randomNonce: () => randomBytes(32).toString('hex'),
    write: (fd: number, bytes: Uint8Array, offset: number) =>
      writeSync(fd, bytes, offset, bytes.byteLength - offset, null),
    sync: fdatasyncSync,
    close: closeSync,
  });
}
