import type { ProcessStartEvidence, SupervisorPlan } from '../../../../scripts/e2e/hosted-actual-owner/processes';
import { ownerChildPlanV2, OWNER_V2_ARGV } from '../../../../scripts/e2e/hosted-actual-owner/owner-child-protocol';
import { OWNER_LAUNCH_EVIDENCE_V2, type OwnerLaunchEvidenceV2 } from '../../../../scripts/e2e/hosted-actual-owner/owner-descriptor-v2';
import { descriptorMap, wrapperStartToken, type HeldOwner, type NativeDescriptor, type SealedLease,
  type ExecutedOwner, type Delivery } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/native-protocol';
import { canonicalJson, sha256 } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/canonical';

export const hex = (n: number) => n.toString(16).padStart(64, '0');
export type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n: string) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const descriptor = (d: NativeDescriptor) => Buffer.concat([
  ...[d.sourceFd, d.childFd, d.kind === 'regular-file' ? 1 : 2,
    ['read-only', 'write-only', 'read-write'].indexOf(d.accessMode), Number(d.append), d.mode, d.uid, d.gid,
    d.seals ?? 0xffffffff].map(u32),
  ...[d.device, d.inode, d.size, d.nlink, d.mtimeNs, d.ctimeNs, d.closedMonotonicNs].map(u64),
]);
// Test-only AOL1 encoding of the accepted C event layout. These are structural counterexamples,
// never qualifying supervisor evidence. Root's benign native tests supply independent kernel proof.
export function events(h: HeldOwner, s: SealedLease, e: ExecutedOwner, d: Delivery) {
  const held = Buffer.concat([
    ...[h.parentPid, h.callerPid, h.ownerPid].map(u32),
    ...[h.parentStartTicks, h.callerStartTicks, h.ownerStartTicks, h.pidfdDevice, h.pidfdInode,
      h.parentPidNamespaceInode, h.parentNetworkNamespaceInode, h.ownerPidNamespaceInode, h.ownerNetworkNamespaceInode].map(u64),
    Buffer.from(h.spawnNonce, 'hex'), ...[h.beforeMonotonicNs, h.forkMonotonicNs, h.heldMonotonicNs].map(u64),
    u32(h.descriptors.length), ...h.descriptors.map(descriptor),
  ]);
  const sealed = Buffer.concat([u64(s.observedMonotonicNs), descriptor(s.construction), u64(s.constructionClosedMonotonicNs)]);
  const exec = Buffer.concat([u32(e.ownerPid), u64(e.ownerStartTicks), u64(e.observedMonotonicNs), descriptor(e.executable)]);
  const delivery = Buffer.concat([u64(d.observedMonotonicNs), u32(d.bootstrapBytes), u32(d.authBytes)]);
  return [held, sealed, exec, delivery].map((b, i) => ({ type: 101 + i, bodyBase64: b.toString('base64') }));
}
export function fixture() {
  const sourceFds = [41, 27, 63, 39, 52, 70, 74, 81];
  const descriptors = [3, 4, 5, 6, 7, 8, 9, 11].map((childFd, i): Mutable<NativeDescriptor> => {
    const socket = [4, 5, 6, 7].includes(childFd), writer = [8, 9].includes(childFd);
    return { sourceFd: sourceFds[i], childFd, kind: socket ? 'socket' : 'regular-file',
      accessMode: socket ? 'read-write' : writer ? 'write-only' : 'read-only', append: writer,
      mode: socket ? 0o777 : childFd === 11 ? 0o500 : 0o600, uid: 0, gid: 0,
      seals: childFd === 3 ? 0 : null, device: socket ? '9' : '1', inode: String(1000 + i),
      size: childFd === 11 ? '4096' : '0', nlink: childFd === 3 ? '0' : '1',
      mtimeNs: '1', ctimeNs: '1', closedMonotonicNs: String(210 + i * 10) };
  });
  const held: Mutable<HeldOwner> = { parentPid: 200, callerPid: 100, ownerPid: 201,
    parentStartTicks: '11', callerStartTicks: '10', ownerStartTicks: '12', pidfdDevice: '5', pidfdInode: '6',
    parentPidNamespaceInode: '5001', parentNetworkNamespaceInode: '5002', ownerPidNamespaceInode: '5001',
    ownerNetworkNamespaceInode: '5002', spawnNonce: hex(1), beforeMonotonicNs: '100', forkMonotonicNs: '200',
    heldMonotonicNs: '300', descriptors };
  const sealed: Mutable<SealedLease> = { observedMonotonicNs: '340', constructionClosedMonotonicNs: '330',
    construction: { ...descriptors[0], sourceFd: 40, accessMode: 'read-write', seals: 15, size: '240',
      closedMonotonicNs: '0', mtimeNs: '320', ctimeNs: '320' } };
  // Actual helper opens /proc/child/exe after closes; reuse of this number is legitimate here.
  const executed: Mutable<ExecutedOwner> = { ownerPid: 201, ownerStartTicks: '12', observedMonotonicNs: '400',
    executable: { ...descriptors[7], sourceFd: 41, closedMonotonicNs: '0' } };
  const delivery: Mutable<Delivery> = { observedMonotonicNs: '500', bootstrapBytes: 2048, authBytes: 128 };
  const plan = { schemaVersion: 2, protocol: 'agent-teams.p3c.supervisor-transcript/v1', controllerNonce: hex(2), runId: hex(3),
    ownerChildProtocol: ownerChildPlanV2(), ownerRecipeSha256: hex(4), ownerHarnessContractSha256: hex(5),
    ownerLaunchHelper: { root: 'p3b2', relativePath: 'native/owner-launch', device: '1', inode: '999', size: 2048,
      mode: 0o500, nlink: 1, sha256: hex(6) },
    expectedExecutableDevice: { owner: '1' }, expectedExecutableInode: { owner: '1007' },
    expectedExecutableSha256: { owner: hex(7), opencode: hex(8) }, expectedProducerModuleSha256: { owner: hex(7) },
    expectedArgv: { owner: OWNER_V2_ARGV }, runtimeManifest: { schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e/v1', runId: hex(3), refs: { openCodeExecutableSha256: hex(8) } },
  } as unknown as SupervisorPlan; // Only consumed plan fields. Never a complete run/qualification fixture.
  const owner = { role: 'owner', pid: 201, startTime: '12', startToken: hex(9), pidfdInode: '6',
    parentStartToken: wrapperStartToken(held), observerStartToken: hex(10), observedMonotonicNs: '600',
    executableDevice: '1', executableInode: '1007', executableSha256: hex(7) } as ProcessStartEvidence;
  const supervisor = { role: 'supervisor', pid: 100, startTime: '10', startToken: hex(10),
    observedMonotonicNs: '50' } as ProcessStartEvidence;
  const map = descriptorMap(held);
  const evidence: Mutable<OwnerLaunchEvidenceV2> = {
    schemaVersion: 2, contract: OWNER_LAUNCH_EVIDENCE_V2, ownerProcessStartToken: owner.startToken,
    descriptorMap: structuredClone(map) as Mutable<typeof map>, descriptorMapSha256: sha256(canonicalJson(map)),
    bootstrapDigests: { bootstrapDigest: hex(21), bootstrapV2HeaderSha256: hex(22), leaseArtifactSha256: hex(23),
      launcherArtifactDigest: hex(24), expectedHostSha256: hex(25), descriptorMapSha256: sha256(canonicalJson(map)), bootstrapStatementSha256: hex(26) },
    parentCleanup: { schemaVersion: 3, contract: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v3',
      wrapperPid: held.parentPid, wrapperStartTicks: held.parentStartTicks, wrapperStartToken: wrapperStartToken(held),
      ownerPid: held.ownerPid, ownerStartTicks: held.ownerStartTicks, ownerProcessStartToken: owner.startToken,
      spawnNonce: held.spawnNonce, spawnBoundaryMonotonicNs: held.forkMonotonicNs,
      descriptors: map.descriptors.map((row, i) => ({ role: row.role, parentFd: descriptors[i].sourceFd,
        beforeSpawn: { method: 'proc-fd-identity', observedMonotonicNs: held.beforeMonotonicNs,
          path: `/proc/${held.parentPid}/fd/${descriptors[i].sourceFd}`, device: row.device, inode: row.inode, mode: row.mode },
        afterSpawn: { method: 'fstat-ebadf', observedMonotonicNs: descriptors[i].closedMonotonicNs, errno: 'EBADF' } })),
    },
    wrapperObservation: { method: 'proc-stat-exe-ns', pid: held.parentPid, parentPid: held.callerPid,
      startTicks: held.parentStartTicks, observedMonotonicNs: '310', pidNamespaceInode: '5001', networkNamespaceInode: '5002',
      uid: 0, gid: 0, executable: { device: '1', inode: '999', size: '2048', sha256: hex(6) } },
    executedImageSha256: hex(7), nativeEvents: events(held, sealed, executed, delivery),
  };
  const context = { plan, owner, supervisor, pidNamespaceInode: '5001', networkNamespaceInode: '5002' };
  return { evidence, context, held, sealed, executed, delivery,
    repack() { evidence.nativeEvents = events(held, sealed, executed, delivery); } };
}
