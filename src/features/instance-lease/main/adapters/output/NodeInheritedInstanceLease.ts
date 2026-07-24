import {
  type BigIntStats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';

import {
  INSTANCE_LEASE_CONTROL_FD,
  INSTANCE_LEASE_EVIDENCE_MAX_BYTES,
  INSTANCE_LEASE_FD,
  INSTANCE_LEASE_PROTOCOL_VERSION,
  type InstanceLeaseLauncherEvidence,
  type VerifiedInstanceLeaseHandle,
} from '../../../contracts';

import type { StdioOptions } from 'node:child_process';

const EVIDENCE_KEYS = [
  'protocolVersion',
  'launcherPid',
  'controllerPid',
  'device',
  'inode',
  'mode',
  'uid',
  'nlink',
] as const;
const DECIMAL_KERNEL_ID = /^(?:0|[1-9][0-9]*)$/;

export type NodeInheritedInstanceLeaseErrorCode =
  | 'child_stdio_invalid'
  | 'closed'
  | 'control_fd_invalid'
  | 'evidence_invalid'
  | 'evidence_mismatch'
  | 'launcher_disconnected'
  | 'lease_fd_invalid'
  | 'platform_unsupported';

export class NodeInheritedInstanceLeaseError extends Error {
  constructor(readonly code: NodeInheritedInstanceLeaseErrorCode) {
    super(`node-inherited-instance-lease:${code}`);
    this.name = 'NodeInheritedInstanceLeaseError';
  }
}

function isPlainExactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === 'string' && expectedKeys.includes(key))
  );
}

function isSafePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalKernelId(value: unknown, allowZero: boolean): value is string {
  return typeof value === 'string' && DECIMAL_KERNEL_ID.test(value) && (allowZero || value !== '0');
}

function readLauncherEvidence(controlFd: number): InstanceLeaseLauncherEvidence {
  const bytes: number[] = [];
  const byte = Buffer.allocUnsafe(1);
  while (bytes.length < INSTANCE_LEASE_EVIDENCE_MAX_BYTES) {
    let count: number;
    try {
      count = readSync(controlFd, byte, 0, 1, null);
    } catch {
      throw new NodeInheritedInstanceLeaseError('evidence_invalid');
    }
    if (count !== 1) {
      throw new NodeInheritedInstanceLeaseError('evidence_invalid');
    }
    if (byte[0] === 0x0a) {
      break;
    }
    if (byte[0] < 0x20 || byte[0] > 0x7e) {
      throw new NodeInheritedInstanceLeaseError('evidence_invalid');
    }
    bytes.push(byte[0]);
  }
  if (bytes.length === 0 || bytes.length >= INSTANCE_LEASE_EVIDENCE_MAX_BYTES) {
    throw new NodeInheritedInstanceLeaseError('evidence_invalid');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('ascii')) as unknown;
  } catch {
    throw new NodeInheritedInstanceLeaseError('evidence_invalid');
  }
  if (!isPlainExactRecord(parsed, EVIDENCE_KEYS)) {
    throw new NodeInheritedInstanceLeaseError('evidence_invalid');
  }

  const protocolVersion = parsed.protocolVersion;
  const launcherPid = parsed.launcherPid;
  const controllerPid = parsed.controllerPid;
  const device = parsed.device;
  const inode = parsed.inode;
  const mode = parsed.mode;
  const uid = parsed.uid;
  const nlink = parsed.nlink;
  if (
    protocolVersion !== INSTANCE_LEASE_PROTOCOL_VERSION ||
    !isSafePid(launcherPid) ||
    !isSafePid(controllerPid) ||
    !isCanonicalKernelId(device, true) ||
    !isCanonicalKernelId(inode, false) ||
    !isSafeNonNegativeInteger(mode) ||
    !isSafeNonNegativeInteger(uid) ||
    !isSafeNonNegativeInteger(nlink)
  ) {
    throw new NodeInheritedInstanceLeaseError('evidence_invalid');
  }

  return Object.freeze({
    protocolVersion,
    launcherPid,
    controllerPid,
    anchor: Object.freeze({ device, inode, mode, uid, linkCount: nlink }),
  });
}

function statDescriptor(fd: number, code: NodeInheritedInstanceLeaseErrorCode): BigIntStats {
  try {
    return fstatSync(fd, { bigint: true });
  } catch {
    throw new NodeInheritedInstanceLeaseError(code);
  }
}

function validateControlDescriptor(controlFd: number): void {
  const stat = statDescriptor(controlFd, 'control_fd_invalid');
  if ((stat.mode & BigInt(fsConstants.S_IFMT)) !== BigInt(fsConstants.S_IFIFO)) {
    throw new NodeInheritedInstanceLeaseError('control_fd_invalid');
  }
}

function validateLeaseDescriptor(leaseFd: number, evidence: InstanceLeaseLauncherEvidence): void {
  const stat = statDescriptor(leaseFd, 'lease_fd_invalid');
  const mode = Number(stat.mode);
  if (
    (stat.mode & BigInt(fsConstants.S_IFMT)) !== BigInt(fsConstants.S_IFREG) ||
    stat.uid !== 0n ||
    (stat.mode & 0o22n) !== 0n ||
    stat.nlink !== 1n ||
    stat.dev.toString() !== evidence.anchor.device ||
    stat.ino.toString() !== evidence.anchor.inode ||
    mode !== evidence.anchor.mode ||
    Number(stat.uid) !== evidence.anchor.uid ||
    Number(stat.nlink) !== evidence.anchor.linkCount
  ) {
    throw new NodeInheritedInstanceLeaseError('evidence_mismatch');
  }
}

function assertLauncherConnected(controlFd: number): void {
  const byte = Buffer.allocUnsafe(1);
  try {
    const count = readSync(controlFd, byte, 0, 1, null);
    if (count === 0) {
      throw new NodeInheritedInstanceLeaseError('launcher_disconnected');
    }
    throw new NodeInheritedInstanceLeaseError('control_fd_invalid');
  } catch (error) {
    if (error instanceof NodeInheritedInstanceLeaseError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') {
      throw new NodeInheritedInstanceLeaseError('control_fd_invalid');
    }
  }
}

class NodeInheritedInstanceLeaseHandle implements VerifiedInstanceLeaseHandle {
  private closed = false;

  constructor(
    private readonly leaseFd: number,
    private readonly controlFd: number,
    readonly evidence: InstanceLeaseLauncherEvidence
  ) {}

  assertValid(): void {
    if (this.closed) {
      throw new NodeInheritedInstanceLeaseError('closed');
    }
    validateControlDescriptor(this.controlFd);
    validateLeaseDescriptor(this.leaseFd, this.evidence);
    assertLauncherConnected(this.controlFd);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      closeSync(this.controlFd);
    } finally {
      closeSync(this.leaseFd);
    }
  }
}

/**
 * Expands a Node stdio policy so the two inherited protocol descriptors are
 * overwritten in every descendant. Numeric attempts to remap either secret
 * descriptor to another child slot are rejected rather than silently copied.
 */
export interface NodeInstanceLeaseChildStdioPolicy {
  readonly stdio: StdioOptions;
  close(): void;
}

export function createInstanceLeaseChildStdioPolicy(
  stdio: StdioOptions = 'pipe'
): NodeInstanceLeaseChildStdioPolicy {
  if (process.platform !== 'linux') {
    throw new NodeInheritedInstanceLeaseError('platform_unsupported');
  }
  let guarded: Exclude<StdioOptions, string>;
  if (Array.isArray(stdio)) {
    guarded = [...stdio];
  } else if (stdio === 'inherit') {
    guarded = [0, 1, 2];
  } else {
    guarded = [stdio, stdio, stdio];
  }
  const referencesProtocolFd = (entry: (typeof guarded)[number]): boolean => {
    if (entry === INSTANCE_LEASE_FD || entry === INSTANCE_LEASE_CONTROL_FD) {
      return true;
    }
    if (typeof entry !== 'object' || entry === null || !('fd' in entry)) {
      return false;
    }
    const fd = (entry as { fd?: unknown }).fd;
    return fd === INSTANCE_LEASE_FD || fd === INSTANCE_LEASE_CONTROL_FD;
  };
  if (
    guarded.some(referencesProtocolFd) ||
    guarded[INSTANCE_LEASE_FD] != null ||
    guarded[INSTANCE_LEASE_CONTROL_FD] != null
  ) {
    throw new NodeInheritedInstanceLeaseError('child_stdio_invalid');
  }
  // Node's `ignore` policy for extra descriptor slots may leave an already-open
  // inherited descriptor untouched. Explicitly dup /dev/null over both child
  // slots, then let the caller close this parent-only source after spawn.
  const nullFd = openSync('/dev/null', fsConstants.O_RDWR);
  guarded[INSTANCE_LEASE_FD] = nullFd;
  guarded[INSTANCE_LEASE_CONTROL_FD] = nullFd;
  Object.freeze(guarded);
  let closed = false;
  return {
    stdio: guarded,
    close() {
      if (closed) return;
      closed = true;
      closeSync(nullFd);
    },
  };
}

/** Validates and adopts the two fixed descriptors installed by the Linux launcher. */
export function openNodeInheritedInstanceLease(): VerifiedInstanceLeaseHandle {
  if (process.platform !== 'linux') {
    throw new NodeInheritedInstanceLeaseError('platform_unsupported');
  }

  validateControlDescriptor(INSTANCE_LEASE_CONTROL_FD);
  const evidence = readLauncherEvidence(INSTANCE_LEASE_CONTROL_FD);
  if (evidence.launcherPid !== process.ppid || evidence.controllerPid !== process.pid) {
    throw new NodeInheritedInstanceLeaseError('evidence_mismatch');
  }
  validateLeaseDescriptor(INSTANCE_LEASE_FD, evidence);
  assertLauncherConnected(INSTANCE_LEASE_CONTROL_FD);
  return new NodeInheritedInstanceLeaseHandle(
    INSTANCE_LEASE_FD,
    INSTANCE_LEASE_CONTROL_FD,
    evidence
  );
}
