import { canonicalJson, sha256 } from './canonical';

export const NATIVE_MAGIC = 0x414f4c31;
export const NATIVE_COMMAND = { init: 1, assembled: 2, execAck: 3, cancel: 4 } as const;
export const NATIVE_EVENT = { held: 101, sealed: 102, exec: 103, delivered: 104, exited: 105, failed: 199 } as const;
export const OWNER_ROLES = [
  ['sealed-launcher-lease', 3], ['bootstrap', 4], ['activation-v2', 5], ['liveness', 6],
  ['private-server-auth', 7], ['raw-opencode-retention', 8], ['owner-wal-native', 9],
  ['executable-anchor', 11],
] as const;
export type OwnerRole = (typeof OWNER_ROLES)[number][0];
export interface NativeDescriptor {
  readonly sourceFd: number;
  readonly childFd: number;
  readonly kind: 'regular-file' | 'socket';
  readonly accessMode: 'read-only' | 'write-only' | 'read-write';
  readonly append: boolean;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly seals: number | null;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly nlink: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly closedMonotonicNs: string;
}
export interface HeldOwner {
  readonly parentPid: number;
  readonly callerPid: number;
  readonly ownerPid: number;
  readonly parentStartTicks: string;
  readonly callerStartTicks: string;
  readonly ownerStartTicks: string;
  readonly pidfdDevice: string;
  readonly pidfdInode: string;
  readonly parentPidNamespaceInode: string;
  readonly parentNetworkNamespaceInode: string;
  readonly ownerPidNamespaceInode: string;
  readonly ownerNetworkNamespaceInode: string;
  readonly spawnNonce: string;
  readonly beforeMonotonicNs: string;
  readonly forkMonotonicNs: string;
  readonly heldMonotonicNs: string;
  readonly descriptors: readonly NativeDescriptor[];
}
export interface SealedLease {
  readonly observedMonotonicNs: string;
  readonly construction: NativeDescriptor;
  readonly constructionClosedMonotonicNs: string;
}
export interface ExecutedOwner {
  readonly ownerPid: number;
  readonly ownerStartTicks: string;
  readonly observedMonotonicNs: string;
  readonly executable: NativeDescriptor;
}
export interface Delivery {
  readonly observedMonotonicNs: string;
  readonly bootstrapBytes: number;
  readonly authBytes: number;
}
export interface OwnerExit {
  readonly ownerPid: number;
  readonly reaped: boolean;
  readonly waitStatus: number;
  readonly observedMonotonicNs: string;
}
export interface NativeFailure {
  readonly phase: number;
  readonly errno: number;
  readonly ownerPid: number;
  readonly reaped: boolean;
  readonly waitStatus: number;
  readonly observedMonotonicNs: string;
  readonly bootstrapBytes: number;
  readonly authBytes: number;
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}
  u32(): number { const n = this.bytes.readUInt32BE(this.offset); this.offset += 4; return n; }
  u64(): string { const n = this.bytes.readBigUInt64BE(this.offset); this.offset += 8; return String(n); }
  hex32(): string {
    const b = this.bytes.subarray(this.offset, this.offset + 32);
    if (b.length !== 32) throw new Error('owner_native_short_nonce');
    this.offset += 32; return b.toString('hex');
  }
  done(): void { if (this.offset !== this.bytes.length) throw new Error('owner_native_event_length'); }
  descriptor(): NativeDescriptor {
    const sourceFd = this.u32(), childFd = this.u32(), kind = this.u32(), access = this.u32(), append = this.u32();
    if (![1, 2].includes(kind) || access > 2 || append > 1) throw new Error('owner_native_descriptor');
    const mode = this.u32(), uid = this.u32(), gid = this.u32(), seals = this.u32();
    return Object.freeze({ sourceFd, childFd, kind: kind === 1 ? 'regular-file' : 'socket',
      accessMode: (['read-only', 'write-only', 'read-write'] as const)[access], append: !!append,
      mode, uid, gid, seals: seals === 0xffffffff ? null : seals,
      device: this.u64(), inode: this.u64(), size: this.u64(), nlink: this.u64(),
      mtimeNs: this.u64(), ctimeNs: this.u64(), closedMonotonicNs: this.u64() });
  }
}
export function decodeHeld(bytes: Buffer): HeldOwner {
  const r = new Reader(bytes);
  const head = { parentPid: r.u32(), callerPid: r.u32(), ownerPid: r.u32(),
    parentStartTicks: r.u64(), callerStartTicks: r.u64(), ownerStartTicks: r.u64(),
    pidfdDevice: r.u64(), pidfdInode: r.u64(), parentPidNamespaceInode: r.u64(),
    parentNetworkNamespaceInode: r.u64(), ownerPidNamespaceInode: r.u64(), ownerNetworkNamespaceInode: r.u64(),
    spawnNonce: r.hex32(), beforeMonotonicNs: r.u64(), forkMonotonicNs: r.u64(), heldMonotonicNs: r.u64() };
  if (r.u32() !== 8) throw new Error('owner_native_role_count');
  const descriptors = OWNER_ROLES.map(([, fd]) => {
    const d = r.descriptor();
    if (d.childFd !== fd || BigInt(d.closedMonotonicNs) < BigInt(head.forkMonotonicNs) ||
      BigInt(d.closedMonotonicNs) > BigInt(head.heldMonotonicNs)) throw new Error('owner_native_parent_closure');
    return d;
  });
  r.done();
  if (head.parentPid === head.ownerPid || head.callerPid === head.parentPid ||
    [head.parentPid, head.callerPid, head.ownerPid].some(n => n < 1 || n > 0x7fffffff) || head.ownerPid < 2 ||
    [head.parentStartTicks, head.ownerStartTicks, head.callerStartTicks].some(n => !Number.isSafeInteger(Number(n))) ||
    head.parentPidNamespaceInode !== head.ownerPidNamespaceInode ||
    head.parentNetworkNamespaceInode !== head.ownerNetworkNamespaceInode ||
    BigInt(head.beforeMonotonicNs) > BigInt(head.forkMonotonicNs) ||
    new Set(descriptors.map(d => `${d.device}:${d.inode}`)).size !== 8 ||
    new Set(descriptors.map(d => d.sourceFd)).size !== 8) throw new Error('owner_native_held_identity');
  return Object.freeze({ ...head, descriptors: Object.freeze(descriptors) });
}
export function decodeSealed(bytes: Buffer): SealedLease {
  const r = new Reader(bytes);
  const value = { observedMonotonicNs: r.u64(), construction: r.descriptor(), constructionClosedMonotonicNs: r.u64() };
  r.done(); return Object.freeze(value);
}
export function decodeExecuted(bytes: Buffer): ExecutedOwner {
  const r = new Reader(bytes);
  const value = { ownerPid: r.u32(), ownerStartTicks: r.u64(), observedMonotonicNs: r.u64(), executable: r.descriptor() };
  r.done(); return Object.freeze(value);
}
export function decodeDelivery(bytes: Buffer): Delivery {
  const r = new Reader(bytes);
  const value = { observedMonotonicNs: r.u64(), bootstrapBytes: r.u32(), authBytes: r.u32() };
  r.done(); return Object.freeze(value);
}
export function decodeExit(bytes: Buffer): OwnerExit {
  const r = new Reader(bytes);
  const value = { ownerPid: r.u32(), reaped: r.u32() === 1, waitStatus: r.u32(), observedMonotonicNs: r.u64() };
  r.done(); return Object.freeze(value);
}
export function decodeFailure(bytes: Buffer): NativeFailure {
  const r = new Reader(bytes);
  const value = { phase: r.u32(), errno: r.u32(), ownerPid: r.u32(), reaped: r.u32() === 1,
    waitStatus: r.u32(), observedMonotonicNs: r.u64(), bootstrapBytes: r.u32(), authBytes: r.u32() };
  r.done(); return Object.freeze(value);
}
export function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
export function nativeMessage(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([u32(NATIVE_MAGIC), u32(type), u32(body.length), body]);
}
export function wrapperStartToken(held: HeldOwner): string {
  return sha256(canonicalJson({ contract: 'agent-teams.hosted-owner-wrapper-process-start/v1',
    pid: held.parentPid, startTime: held.parentStartTicks }));
}
export function descriptorMap(held: HeldOwner) {
  return Object.freeze({ schemaVersion: 2 as const, contract: 'agent-teams.hosted-owner-child-fd-map/v2' as const,
    wrapperPid: held.parentPid, wrapperStartTicks: held.parentStartTicks,
    wrapperStartToken: wrapperStartToken(held), spawnNonce: held.spawnNonce,
    descriptors: Object.freeze(held.descriptors.map((d, i) => Object.freeze({ role: OWNER_ROLES[i][0],
      childFd: d.childFd, kind: d.kind, device: d.device, inode: d.inode, uid: d.uid, gid: d.gid,
      mode: d.mode, accessMode: d.accessMode, append: d.append }))) });
}
