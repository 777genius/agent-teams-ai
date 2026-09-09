import { canonicalJson, exactRecord } from './supervisor/canonical';
import { parseLegacyOwnerChildDescriptorCleanup, type LegacyOwnerChildDescriptorCleanup } from './owner-descriptor-legacy';
import { OWNER_CLEANUP_V3, parseOwnerDescriptorMapV2, parseOwnerLaunchEvidenceV2,
  type OwnerLaunchEvidenceV2, type OwnerParentCleanupV3 } from './owner-descriptor-v2';
import type { FilesystemEvidence, NetworkEvidence, ProcessStartEvidence, SupervisorOutcome, SupervisorPlan } from './processes';

export interface OwnerChildDescriptorCleanupV3 {
  readonly contract: typeof OWNER_CLEANUP_V3;
  readonly ownerStartTokens: readonly string[];
  readonly records: readonly OwnerParentCleanupV3[];
  readonly launches: readonly OwnerLaunchEvidenceV2[];
}
export type OwnerChildDescriptorCleanup = LegacyOwnerChildDescriptorCleanup | OwnerChildDescriptorCleanupV3;
export interface OwnerCleanupContext {
  readonly plan: SupervisorPlan;
  readonly supervisor: ProcessStartEvidence;
  readonly filesystem: FilesystemEvidence;
  readonly network: NetworkEvidence;
  readonly launches: readonly unknown[];
}
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`p3c_owner_cleanup_v3_${reason}`);
}
export function parseOwnerLaunchEnvelope(value: unknown, plan: SupervisorPlan, sequence: number, supervisorToken: string) {
  const r = exactRecord(value, ['schemaVersion', 'protocol', 'type', 'sequence', 'controllerNonce', 'runId',
    'observerStartToken', 'evidence'], 'owner_launch_envelope');
  check(r.schemaVersion === 2 && r.protocol === plan.protocol && r.type === 'owner-native-launch' && r.sequence === sequence &&
    r.controllerNonce === plan.controllerNonce && r.runId === plan.runId && r.observerStartToken === supervisorToken, 'envelope');
  // Used only as the proposed parent for parseStart; full native/process/namespace joining is mandatory below.
  const proposed = r.evidence as OwnerLaunchEvidenceV2;
  const map = parseOwnerDescriptorMapV2(proposed?.descriptorMap);
  return { evidence: r.evidence, parentToken: map.wrapperStartToken };
}
export function parseOwnerChildDescriptorCleanup(
  value: unknown, starts: readonly Pick<ProcessStartEvidence, 'role' | 'pid' | 'startToken'>[], context?: OwnerCleanupContext
): OwnerChildDescriptorCleanup {
  if (!context || !('protocolVersion' in context.plan.ownerChildProtocol) || context.plan.ownerChildProtocol.protocolVersion !== 2)
    return parseLegacyOwnerChildDescriptorCleanup(value, starts);
  const c = exactRecord(value, ['schemaVersion', 'contract', 'records'], 'owner_cleanup_v3');
  const owners = starts.filter(s => s.role === 'owner');
  check(c.schemaVersion === 3 && c.contract === OWNER_CLEANUP_V3 && Array.isArray(c.records) &&
    owners.length > 0 && c.records.length === owners.length && context.launches.length === owners.length, 'version_count');
  const launches = context.launches.map((value, i) => parseOwnerLaunchEvidenceV2(value, {
    plan: context.plan, supervisor: context.supervisor, owner: owners[i] as ProcessStartEvidence,
    pidNamespaceInode: context.filesystem.pidNamespaceInode, networkNamespaceInode: context.network.namespaceInode,
  }));
  check(new Set(launches.map(l => l.parentCleanup.spawnNonce)).size === owners.length &&
    new Set(launches.map(l => l.parentCleanup.ownerProcessStartToken)).size === owners.length &&
    new Set(launches.map(l => `${l.parentCleanup.wrapperPid}:${l.parentCleanup.wrapperStartTicks}`)).size === owners.length,
  'replayed_spawn');
  for (const [i, launch] of launches.entries()) check(canonicalJson(c.records[i]) === canonicalJson(launch.parentCleanup), 'native_cleanup_disagreement');
  return Object.freeze({ contract: OWNER_CLEANUP_V3, ownerStartTokens: Object.freeze(owners.map(s => s.startToken)),
    records: Object.freeze(launches.map(l => l.parentCleanup)), launches: Object.freeze(launches) });
}
/** Adds descriptor-role joins without taking ownership of P1 parsing or P2 WAL image custody. */
export function assertOwnerDescriptorCaptureBindings(
  cleanup: OwnerChildDescriptorCleanup, raw: SupervisorOutcome['rawFiles'], captures: SupervisorOutcome['captureFiles']
): void {
  if (cleanup.contract !== OWNER_CLEANUP_V3) return;
  const native = Object.values(captures).flatMap(c => c.shards);
  const allNativeIdentities = new Set(native.map(s => `${s.captureDevice}:${s.captureInode}`));
  check(canonicalJson([...raw.opencode.producerStartTokens].sort()) === canonicalJson([...cleanup.ownerStartTokens].sort()), 'raw_recorder');
  for (const launch of cleanup.launches) {
    const rows = launch.descriptorMap.descriptors;
    const rawRow = rows.find(r => r.role === 'raw-opencode-retention')!;
    const wal = rows.find(r => r.role === 'owner-wal-native')!;
    check(rawRow.device === raw.opencode.captureDevice && rawRow.inode === raw.opencode.captureInode, 'raw_descriptor');
    const ownedWal = captures.ownerWalTimelinePath.shards.filter(s => s.producerStartToken === launch.ownerProcessStartToken);
    check(ownedWal.length === 1 && ownedWal[0].producerRole === 'owner' && ownedWal[0].producerFd === 9 &&
      ownedWal[0].captureDevice === wal.device && ownedWal[0].captureInode === wal.inode, 'wal_descriptor');
    check(native.filter(s => s.captureDevice === wal.device && s.captureInode === wal.inode).length === 1, 'wal_capture_alias');
    for (const [origin, file] of Object.entries(raw)) {
      if (origin !== 'opencode') check(file.captureDevice !== rawRow.device || file.captureInode !== rawRow.inode, 'raw_capture_alias');
    }
    for (const row of rows) {
      if (row.role !== 'owner-wal-native') check(!allNativeIdentities.has(`${row.device}:${row.inode}`), 'capture_alias');
    }
  }
}
