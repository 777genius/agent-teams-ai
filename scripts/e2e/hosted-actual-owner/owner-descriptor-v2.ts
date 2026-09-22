import { canonicalJson, exactRecord, sha256 } from './supervisor/canonical';
import { decodeDelivery, decodeExecuted, decodeExit, decodeHeld, decodeSealed, descriptorMap,
  NATIVE_EVENT, wrapperStartToken, type HeldOwner, type NativeDescriptor } from './supervisor/native-protocol';
import type { AssembledBootstrap } from './supervisor/bootstrap-v2';
import type { NativeEventRecord } from './supervisor/native-launch';
import type { OwnerWrapperObservation } from './owner-wrapper-observation';
import { OWNER_V2_ROLE_FDS, type OwnerV2Role } from './owner-child-protocol';
import type { ProcessStartEvidence, SupervisorPlan } from './processes';
import { assertOwnerPlanV2 } from './owner-plan';

export const OWNER_MAP_V2 = 'agent-teams.hosted-owner-child-fd-map/v2' as const;
export const OWNER_CLEANUP_V3 = 'agent-teams.hosted-owner-child-parent-fd-cleanup/v3' as const;
export const OWNER_LAUNCH_EVIDENCE_V2 = 'agent-teams.p3c.owner-native-launch/v2' as const;
export type OwnerDescriptorMapV2 = ReturnType<typeof descriptorMap>;
export interface OwnerParentCleanupV3 {
  readonly schemaVersion: 3;
  readonly contract: typeof OWNER_CLEANUP_V3;
  readonly wrapperPid: number;
  readonly wrapperStartTicks: string;
  readonly wrapperStartToken: string;
  readonly ownerPid: number;
  readonly ownerStartTicks: string;
  readonly ownerProcessStartToken: string;
  readonly spawnNonce: string;
  readonly spawnBoundaryMonotonicNs: string;
  readonly descriptors: readonly {
    readonly role: OwnerV2Role;
    readonly parentFd: number;
    readonly beforeSpawn: { readonly method: 'proc-fd-identity'; readonly observedMonotonicNs: string;
      readonly path: string; readonly device: string; readonly inode: string; readonly mode: number };
    readonly afterSpawn: { readonly method: 'fstat-ebadf'; readonly observedMonotonicNs: string; readonly errno: 'EBADF' };
  }[];
}
export interface OwnerLaunchEvidenceV2 {
  readonly schemaVersion: 2;
  readonly contract: typeof OWNER_LAUNCH_EVIDENCE_V2;
  readonly ownerProcessStartToken: string;
  readonly descriptorMap: OwnerDescriptorMapV2;
  readonly descriptorMapSha256: string;
  readonly bootstrapDigests: AssembledBootstrap['digests'];
  readonly parentCleanup: OwnerParentCleanupV3;
  readonly wrapperObservation: OwnerWrapperObservation;
  readonly executedImageSha256: string;
  readonly nativeEvents: readonly NativeEventRecord[];
}
export interface OwnerDescriptorContextV2 {
  readonly plan: SupervisorPlan;
  readonly supervisor: ProcessStartEvidence;
  readonly owner: ProcessStartEvidence;
  readonly pidNamespaceInode: string;
  readonly networkNamespaceInode: string;
}
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`p3c_owner_descriptor_v2_${reason}`);
}
function keys(value: unknown, names: string): Record<string, unknown> {
  return exactRecord(value, names.split(','), 'owner_descriptor_v2');
}
function decimal(value: unknown, positive = false): string {
  check(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/u.test(value) &&
    BigInt(value) <= 0xffffffffffffffffn && (!positive || value !== '0'), 'decimal');
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  check(Number.isSafeInteger(value) && !Object.is(value, -0) && Number(value) >= min && Number(value) <= max, 'integer');
  return value as number;
}
function hex(value: unknown): string {
  check(typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value), 'digest'); return value;
}
function equal(actual: unknown, expected: unknown, reason: string): void {
  check(canonicalJson(actual) === canonicalJson(expected), reason);
}
/** Structural parsing only. The independently retained native launch must also match before admission. */
export function parseOwnerDescriptorMapV2(value: unknown): OwnerDescriptorMapV2 {
  check(Buffer.byteLength(canonicalJson(value)) <= 8192, 'map_bound');
  const m = keys(value, 'schemaVersion,contract,wrapperPid,wrapperStartTicks,wrapperStartToken,spawnNonce,descriptors');
  check(m.schemaVersion === 2 && m.contract === OWNER_MAP_V2, 'map_version');
  const pid = integer(m.wrapperPid, 1, 0x7fffffff), ticks = decimal(m.wrapperStartTicks, true);
  integer(Number(ticks), 1, Number.MAX_SAFE_INTEGER);
  check(hex(m.wrapperStartToken) === sha256(canonicalJson({ contract: 'agent-teams.hosted-owner-wrapper-process-start/v1',
    pid, startTime: ticks })), 'wrapper_token');
  hex(m.spawnNonce);
  const roles = Object.keys(OWNER_V2_ROLE_FDS) as OwnerV2Role[];
  check(Array.isArray(m.descriptors) && m.descriptors.length === roles.length, 'role_count');
  const descriptors = m.descriptors.map((value, i) => {
    const d = keys(value, 'role,childFd,kind,device,inode,uid,gid,mode,accessMode,append');
    const role = roles[i];
    check(d.role === role && d.childFd === OWNER_V2_ROLE_FDS[role], 'role_fd');
    decimal(d.device); decimal(d.inode, true); integer(d.uid, 0, 0xffffffff); integer(d.gid, 0, 0xffffffff);
    integer(d.mode, 0, 0o7777);
    const writer = role === 'raw-opencode-retention' || role === 'owner-wal-native';
    const file = writer || role === 'sealed-launcher-lease' || role === 'executable-anchor';
    // Accepted native MVP uses connected AF_UNIX streams; a future FIFO codec is not native proof.
    check(d.kind === (file ? 'regular-file' : 'socket') &&
      d.accessMode === (writer ? 'write-only' : file ? 'read-only' : 'read-write') &&
      d.append === writer && (!file || d.mode === (role === 'executable-anchor' ? 0o500 : 0o600)), 'role_metadata');
    return Object.freeze({ ...d });
  });
  check(new Set(descriptors.map(d => `${d.device}:${d.inode}`)).size === roles.length, 'role_alias');
  return Object.freeze({ ...m, descriptors: Object.freeze(descriptors) }) as unknown as OwnerDescriptorMapV2;
}
function readNativeEvents(value: unknown) {
  check(Array.isArray(value) && (value.length === 4 || value.length === 5), 'native_count');
  const order = [NATIVE_EVENT.held, NATIVE_EVENT.sealed, NATIVE_EVENT.exec, NATIVE_EVENT.delivered, NATIVE_EVENT.exited];
  let size = 0;
  const bodies = value.map((v, i) => {
    const e = keys(v, 'type,bodyBase64');
    check(e.type === order[i] && typeof e.bodyBase64 === 'string' && e.bodyBase64.length <= 5464, 'native_order');
    const body = Buffer.from(e.bodyBase64, 'base64'); size += body.length + 12;
    check(body.length <= 4096 && body.toString('base64') === e.bodyBase64 && size <= 16384, 'native_encoding');
    return body;
  });
  return { held: decodeHeld(bodies[0]), sealed: decodeSealed(bodies[1]), executed: decodeExecuted(bodies[2]),
    delivery: decodeDelivery(bodies[3]), exit: bodies[4] ? decodeExit(bodies[4]) : undefined };
}
function sameObject(a: NativeDescriptor, b: NativeDescriptor): boolean {
  return ['childFd', 'kind', 'accessMode', 'append', 'mode', 'uid', 'gid', 'device', 'inode', 'size', 'nlink',
    'mtimeNs', 'ctimeNs'].every(k => a[k as keyof NativeDescriptor] === b[k as keyof NativeDescriptor]);
}
function validateWrapper(value: unknown, held: HeldOwner, context: OwnerDescriptorContextV2): OwnerWrapperObservation {
  const w = keys(value, 'method,pid,parentPid,startTicks,observedMonotonicNs,pidNamespaceInode,networkNamespaceInode,uid,gid,executable');
  const e = keys(w.executable, 'device,inode,size,sha256'), helper = context.plan.ownerLaunchHelper!;
  check(w.method === 'proc-stat-exe-ns' && w.pid === held.parentPid && w.parentPid === context.supervisor.pid &&
    w.startTicks === held.parentStartTicks && w.pidNamespaceInode === context.pidNamespaceInode &&
    w.networkNamespaceInode === context.networkNamespaceInode &&
    e.device === helper.device && e.inode === helper.inode && e.size === String(helper.size) && e.sha256 === helper.sha256,
  'independent_wrapper');
  decimal(w.observedMonotonicNs, true); integer(w.uid, 0, 0xffffffff); integer(w.gid, 0, 0xffffffff);
  return Object.freeze({ ...w, executable: Object.freeze({ ...e }) }) as unknown as OwnerWrapperObservation;
}
function validateCleanup(value: unknown, held: HeldOwner, owner: ProcessStartEvidence): OwnerParentCleanupV3 {
  const c = keys(value, 'schemaVersion,contract,wrapperPid,wrapperStartTicks,wrapperStartToken,ownerPid,ownerStartTicks,ownerProcessStartToken,spawnNonce,spawnBoundaryMonotonicNs,descriptors');
  check(c.schemaVersion === 3 && c.contract === OWNER_CLEANUP_V3 && c.wrapperPid === held.parentPid &&
    c.wrapperStartTicks === held.parentStartTicks && c.wrapperStartToken === wrapperStartToken(held) &&
    c.ownerPid === owner.pid && c.ownerStartTicks === owner.startTime && c.ownerProcessStartToken === owner.startToken &&
    c.spawnNonce === held.spawnNonce && c.spawnBoundaryMonotonicNs === held.forkMonotonicNs, 'cleanup_binding');
  check(Array.isArray(c.descriptors) && c.descriptors.length === 8, 'cleanup_count');
  let previousClosed = BigInt(held.forkMonotonicNs);
  const descriptors = c.descriptors.map((value, i) => {
    const d = keys(value, 'role,parentFd,beforeSpawn,afterSpawn');
    const role = (Object.keys(OWNER_V2_ROLE_FDS) as OwnerV2Role[])[i];
    const observed = held.descriptors.find(d => d.childFd === OWNER_V2_ROLE_FDS[role]);
    check(observed && d.role === role && d.parentFd === observed.sourceFd, 'cleanup_role');
    const before = keys(d.beforeSpawn, 'method,observedMonotonicNs,path,device,inode,mode');
    const after = keys(d.afterSpawn, 'method,observedMonotonicNs,errno');
    equal(before, { method: 'proc-fd-identity', observedMonotonicNs: held.beforeMonotonicNs,
      path: `/proc/${held.parentPid}/fd/${observed.sourceFd}`, device: observed.device, inode: observed.inode, mode: observed.mode }, 'cleanup_before');
    equal(after, { method: 'fstat-ebadf', observedMonotonicNs: observed.closedMonotonicNs, errno: 'EBADF' }, 'cleanup_after');
    const closed = BigInt(decimal(after.observedMonotonicNs, true));
    check(closed > previousClosed && closed <= BigInt(held.heldMonotonicNs), 'adjacent_close_order');
    previousClosed = closed;
    return Object.freeze({ ...d, beforeSpawn: Object.freeze({ ...before }), afterSpawn: Object.freeze({ ...after }) });
  });
  return Object.freeze({ ...c, descriptors: Object.freeze(descriptors) }) as unknown as OwnerParentCleanupV3;
}
/** Called on a selected-supervisor transcript, with its separately parsed process and namespace records.
 * Neither a map publication, a custody boolean, nor JSON seals can substitute for the binary events.
 */
export function parseOwnerLaunchEvidenceV2(value: unknown, context: OwnerDescriptorContextV2): OwnerLaunchEvidenceV2 {
  assertOwnerPlanV2(context.plan);
  const r = keys(value, 'schemaVersion,contract,ownerProcessStartToken,descriptorMap,descriptorMapSha256,bootstrapDigests,parentCleanup,wrapperObservation,executedImageSha256,nativeEvents');
  check(r.schemaVersion === 2 && r.contract === OWNER_LAUNCH_EVIDENCE_V2, 'launch_version');
  const { held, sealed, executed, delivery, exit } = readNativeEvents(r.nativeEvents);
  const owner = context.owner, supervisor = context.supervisor;
  check(owner.role === 'owner' && supervisor.role === 'supervisor' && r.ownerProcessStartToken === owner.startToken &&
    held.ownerPid === owner.pid && held.ownerStartTicks === owner.startTime && held.pidfdInode === owner.pidfdInode &&
    held.callerPid === supervisor.pid && held.callerStartTicks === supervisor.startTime &&
    owner.parentStartToken === wrapperStartToken(held) && owner.observerStartToken === supervisor.startToken &&
    new Set([owner.startToken, wrapperStartToken(held), supervisor.startToken]).size === 3 &&
    new Set([held.ownerPid, held.parentPid, held.callerPid]).size === 3, 'parent_child_start');
  hex(owner.startToken); hex(supervisor.startToken);
  check(held.ownerPidNamespaceInode === context.pidNamespaceInode && held.parentPidNamespaceInode === context.pidNamespaceInode &&
    held.ownerNetworkNamespaceInode === context.networkNamespaceInode && held.parentNetworkNamespaceInode === context.networkNamespaceInode,
  'namespace');
  const map = parseOwnerDescriptorMapV2(r.descriptorMap);
  equal(map, descriptorMap(held), 'observed_map');
  check(hex(r.descriptorMapSha256) === sha256(canonicalJson(map)), 'map_digest');
  const digests = keys(r.bootstrapDigests, 'bootstrapDigest,bootstrapV2HeaderSha256,leaseArtifactSha256,launcherArtifactDigest,expectedHostSha256,descriptorMapSha256,bootstrapStatementSha256');
  for (const digest of Object.values(digests)) hex(digest);
  check(digests.descriptorMapSha256 === r.descriptorMapSha256, 'bootstrap_map_binding');
  const wrapper = validateWrapper(r.wrapperObservation, held, context);
  const parentCleanup = validateCleanup(r.parentCleanup, held, owner);
  for (const d of held.descriptors) {
    integer(d.sourceFd, 3, 0x7fffffff);
    check(d.uid === wrapper.uid && d.gid === wrapper.gid, 'descriptor_owner');
    decimal(d.device); decimal(d.inode, true); decimal(d.size); decimal(d.nlink);
  }
  const lease = held.descriptors.find(d => d.childFd === OWNER_V2_ROLE_FDS['sealed-launcher-lease'])!;
  const wal = held.descriptors.find(d => d.childFd === OWNER_V2_ROLE_FDS['owner-wal-native'])!;
  const raw = held.descriptors.find(d => d.childFd === OWNER_V2_ROLE_FDS['raw-opencode-retention'])!;
  const anchor = held.descriptors.find(d => d.childFd === OWNER_V2_ROLE_FDS['executable-anchor'])!;
  const construction = sealed.construction;
  check(lease.seals === 0 && lease.size === '0' && wal.size === '0' && wal.nlink === '1' && raw.nlink === '1' &&
    BigInt(raw.size) <= 64n * 1024n * 1024n && anchor.nlink === '1', 'held_phase');
  check(construction.seals === 15 && construction.accessMode === 'read-write' && construction.childFd === 3 &&
    construction.kind === 'regular-file' && construction.append === false && construction.mode === 0o600 &&
    construction.device === lease.device && construction.inode === lease.inode && construction.uid === lease.uid &&
    construction.gid === lease.gid && construction.nlink === lease.nlink && construction.closedMonotonicNs === '0' &&
    !held.descriptors.some(d => d.sourceFd === construction.sourceFd) &&
    BigInt(construction.size) >= 1n && BigInt(construction.size) <= 65536n, 'kernel_sealed_phase');
  check(BigInt(held.beforeMonotonicNs) < BigInt(held.forkMonotonicNs) &&
    BigInt(supervisor.observedMonotonicNs) <= BigInt(held.beforeMonotonicNs) &&
    BigInt(wrapper.observedMonotonicNs) >= BigInt(held.heldMonotonicNs) &&
    BigInt(sealed.constructionClosedMonotonicNs) > BigInt(wrapper.observedMonotonicNs) &&
    BigInt(sealed.constructionClosedMonotonicNs) <= BigInt(sealed.observedMonotonicNs) &&
    BigInt(executed.observedMonotonicNs) > BigInt(sealed.observedMonotonicNs) &&
    BigInt(owner.observedMonotonicNs) >= BigInt(executed.observedMonotonicNs) &&
    BigInt(delivery.observedMonotonicNs) >= BigInt(executed.observedMonotonicNs) &&
    BigInt(delivery.observedMonotonicNs) - BigInt(held.beforeMonotonicNs) <= 5_000_000_000n, 'launch_order');
  check(executed.ownerPid === owner.pid && executed.ownerStartTicks === owner.startTime && sameObject(anchor, executed.executable) &&
    owner.executableDevice === anchor.device && owner.executableInode === anchor.inode &&
    owner.executableSha256 === hex(r.executedImageSha256) && r.executedImageSha256 === context.plan.expectedExecutableSha256.owner &&
    owner.executableDevice === context.plan.expectedExecutableDevice.owner && owner.executableInode === context.plan.expectedExecutableInode.owner,
  'executed_image');
  check(delivery.bootstrapBytes >= 70 && delivery.bootstrapBytes <= 65604 && delivery.authBytes >= 6 && delivery.authBytes <= 8196, 'delivery');
  if (exit) check(exit.ownerPid === owner.pid && exit.reaped && BigInt(exit.observedMonotonicNs) >= BigInt(delivery.observedMonotonicNs), 'exit');
  return Object.freeze({ ...r, descriptorMap: map, bootstrapDigests: Object.freeze({ ...digests }), parentCleanup, wrapperObservation: wrapper,
    nativeEvents: Object.freeze((r.nativeEvents as NativeEventRecord[]).map(e => Object.freeze({ ...e }))) }) as unknown as OwnerLaunchEvidenceV2;
}
