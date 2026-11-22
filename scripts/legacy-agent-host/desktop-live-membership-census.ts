/** TEST-only joins of retained observations. No discovery, waiting, process control or new authority. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { captureDesktopSourceMetadataLineage } from './desktop-opencode-metadata-lineage.ts';
import type { DesktopMetadataBirthWitness, DesktopSourceMetadataLineage } from './desktop-opencode-metadata-lineage.ts';

type Provider = 'claude' | 'codex' | 'opencode';
interface Sources {
  readonly records: readonly unknown[];
  readonly current: readonly unknown[];
  readonly profileHashes: readonly string[];
}
export interface DesktopMembershipCensus {
  readonly host: ProcessFact;
  readonly children: readonly ProcessFact[];
  readonly sources: Sources;
  readonly lineage: DesktopSourceMetadataLineage;
  readonly providers: readonly Provider[];
}
export interface DesktopMembershipRuntimeSelection {
  readonly provider: Provider;
  readonly birth: ProcessFact;
}

function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (row: unknown): void => {
    if (row === null || typeof row !== 'object') return;
    for (const child of Object.values(row)) freeze(child);
    Object.freeze(row);
  };
  freeze(copy); return copy;
}

/** Preserve the original physical census even if its pending child exits before its ready log arrives. */
export function captureDesktopMembershipCensus(value: DesktopMembershipCensus): DesktopMembershipCensus {
  assert.match(value.host.birth, /^linux-starttime:[1-9]\d*$/u);
  assert.ok(value.children.length <= 128);
  assert.equal(new Set(value.children.map(row => row.pid)).size, value.children.length);
  for (const child of value.children) {
    assert.notEqual(child.pid, value.host.pid); assert.equal(child.parentPid, value.host.pid);
    assert.match(child.birth, /^linux-starttime:[1-9]\d*$/u);
  }
  assert.ok(value.providers.length <= 3 && value.providers.every(provider => ['claude', 'codex', 'opencode'].includes(provider)));
  assert.equal(new Set(value.providers).size, value.providers.length);
  assert.deepEqual(value.lineage.host, value.host);
  assert.deepEqual(value.lineage.profileHashes, value.sources.profileHashes);
  return immutableCopy(value);
}

/** These selections already passed the original per-provider Runtime/argv/peer checks at observation time. */
export function captureDesktopMembershipRuntimes(selected: ReadonlyMap<Provider, ProcessFact>): readonly DesktopMembershipRuntimeSelection[] {
  return immutableCopy([...selected].map(([provider, birth]) => ({ provider, birth })));
}

/** Reconcile only the original snapshot against the same Host's original completed Quit evidence. */
export function assertDesktopMembershipCensus(snapshot: DesktopMembershipCensus, final: {
  sources: Sources;
  lineage: DesktopSourceMetadataLineage;
  observed: readonly ProcessFact[];
  executable: string;
  birthWitness: DesktopMetadataBirthWitness;
  runtimes: readonly DesktopMembershipRuntimeSelection[];
}) {
  assert.equal(final.observed.some(row => row.pid === snapshot.host.pid), false, 'the original Host exited before census reconciliation');
  assert.deepEqual(final.sources.records.slice(0, snapshot.sources.records.length), snapshot.sources.records,
    'all original source records remain an immutable prefix');
  assert.deepEqual(final.sources.profileHashes.slice(0, snapshot.sources.profileHashes.length), snapshot.sources.profileHashes);
  assert.deepEqual(final.lineage.profileHashes, final.sources.profileHashes);
  // Supply the already-observed log and release census: the lineage oracle performs no new read here.
  const lineage = captureDesktopSourceMetadataLineage({ root: '', host: snapshot.host,
    profileHashes: final.sources.profileHashes, observed: final.observed, executable: final.executable,
    original: snapshot.lineage, birthWitness: final.birthWitness, released: true }, final.lineage.events);
  assert.deepEqual(lineage, final.lineage, 'the exact original completed lineage supplies the later role evidence');
  const metadata: ProcessFact[] = [], natives: ProcessFact[] = [], physicalScopes = new Set<string>();
  for (const child of snapshot.children) {
    const ready = lineage.events.find(event => event.stage === 'ready' && event.pid === child.pid);
    if (!ready) { natives.push(child); continue; }
    assert.ok(snapshot.sources.profileHashes.includes(ready.profileHash), 'the metadata scope was captured with this original physical census');
    const partition = lineage.partitions.find(row => row.profileHashes[0] === ready.profileHash);
    assert.ok(partition);
    assert.deepEqual(partition.births.find(row => row.pid === child.pid), child,
      'a later ready classifies the same original physical birth, never a reused PID');
    assert.equal(child.groupId, child.pid); assert.equal(child.command, final.executable);
    assert.equal(ready.startIdentityHash, createHash('sha256').update(child.pid + ':' +
      child.birth.slice('linux-starttime:'.length)).digest('hex'), 'the later ready confirms the retained kernel birth');
    if (snapshot.lineage.events.some(event => event.stage === 'ready' && event.pid === child.pid))
      assert.deepEqual(snapshot.lineage.live.find(row => row.pid === child.pid), child,
        'an already-retired metadata birth cannot be physically present in the original census');
    assert.equal(physicalScopes.has(ready.profileHash), false, 'no same-profile metadata births overlap in an original physical census');
    physicalScopes.add(ready.profileHash); metadata.push(child);
  }
  assert.equal(natives.length, snapshot.providers.length, 'every remaining original Host child is one expected Runtime');
  assert.deepEqual(final.runtimes.map(row => row.provider), snapshot.providers);
  assert.equal(new Set(final.runtimes.map(row => row.birth.pid)).size, snapshot.providers.length);
  for (const runtime of final.runtimes)
    assert.deepEqual(natives.filter(row => row.pid === runtime.birth.pid), [runtime.birth],
      'each remaining original child is the exact Runtime already qualified at observation time');
  return immutableCopy({ snapshot, runtimes: final.runtimes, metadata, natives });
}
