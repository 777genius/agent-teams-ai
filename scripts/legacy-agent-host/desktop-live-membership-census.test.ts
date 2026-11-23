import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { assertDesktopMembershipCensus, captureDesktopMembershipCensus, captureDesktopMembershipRuntimes } from './desktop-live-membership-census.ts';
import { captureDesktopSourceMetadataLineage } from './desktop-opencode-metadata-lineage.ts';
import type { DesktopMetadataEvent } from './desktop-opencode-metadata-lineage.ts';

function fixture() {
  const host: ProcessFact = { pid: 10, parentPid: 2, groupId: 2, birth: 'linux-starttime:100', command: '/TEST/node' };
  const child = (pid: number, command = '/TEST/bun'): ProcessFact => ({ pid, parentPid: host.pid,
    groupId: pid, birth: 'linux-starttime:' + pid * 10, command });
  const original = child(11), pending = child(12), claude = child(20, '/TEST/node'), codex = child(21, '/TEST/node');
  const ready = (birth: ProcessFact, profileHash: string): DesktopMetadataEvent => ({ hostPid: host.pid,
    profileHash, mode: 'directory', providerHash: null, pid: birth.pid, stage: 'ready',
    startIdentityHash: createHash('sha256').update(birth.pid + ':' + birth.birth.slice('linux-starttime:'.length)).digest('hex') });
  const originalReady = ready(original, 'a'.repeat(64)), pendingReady = ready(pending, 'b'.repeat(64));
  const released = (event: DesktopMetadataEvent): DesktopMetadataEvent => ({ ...event, stage: 'released' });
  const sources = { records: [{ revision: 'TEST-original-source', grant: { ownerId: 'TEST-owner' } }],
    current: [{ sourceId: 'TEST-source', revision: 'TEST-original-source' }],
    profileHashes: [originalReady.profileHash, pendingReady.profileHash] };
  const birthWitness = { host, births: [original, pending] }, children = [original, pending, claude, codex];
  const lineage = captureDesktopSourceMetadataLineage({ root: '/TEST-never-read', host,
    profileHashes: sources.profileHashes, observed: children, executable: original.command, birthWitness }, [originalReady]);
  const snapshot = captureDesktopMembershipCensus({ host, children, sources, lineage, providers: ['claude', 'codex'] });
  const events = [originalReady, pendingReady, released(originalReady), released(pendingReady)];
  const final = { sources, executable: original.command, observed: [] as ProcessFact[], birthWitness,
    lineage: captureDesktopSourceMetadataLineage({ root: '/TEST-never-read', host, profileHashes: sources.profileHashes,
      observed: [], executable: original.command, birthWitness, original: lineage, released: true }, events),
    runtimes: captureDesktopMembershipRuntimes(new Map([['claude', claude], ['codex', codex]])) };
  return { host, original, pending, claude, codex, originalReady, pendingReady, released, snapshot, final };
}

test('late original ready removes the false third Runtime without replacing the original physical census', () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  const premature = f.snapshot.children.filter(child => !f.snapshot.lineage.live.some(row => row.pid === child.pid));
  assert.equal(premature.length, 3);
  assert.throws(() => assert.equal(premature.length, f.snapshot.providers.length));
  const result = assertDesktopMembershipCensus(f.snapshot, f.final);
  assert.deepEqual(result.metadata, [f.original, f.pending]);
  assert.deepEqual(result.natives, [f.claude, f.codex]);
  assert.deepEqual(result.snapshot, before); assert.deepEqual(f.snapshot, before);
  assert.equal(result.snapshot.children.length, 4); assert.equal(result.snapshot.lineage.events.length, 1);
});

test('original children, source bindings and event prefix are detached and deeply immutable', () => {
  const f = fixture(), input = structuredClone(f.snapshot), saved = captureDesktopMembershipCensus(input);
  input.children[0]!.birth = 'linux-starttime:999';
  (input.sources.records[0] as { revision: string }).revision = 'TEST-replacement';
  (input.sources.current[0] as { revision: string }).revision = 'TEST-replacement';
  input.lineage.host.birth = 'linux-starttime:999';
  assert.deepEqual(saved, f.snapshot);
  assert.throws(() => { saved.children[0]!.birth = 'linux-starttime:999'; }, TypeError);
  assert.throws(() => { (saved.sources.current[0] as { revision: string }).revision = 'TEST-replacement'; }, TypeError);
  assert.throws(() => { f.final.runtimes[0]!.birth.pid = 999; }, TypeError);
  assert.deepEqual(assertDesktopMembershipCensus(saved, f.final).natives, [f.claude, f.codex]);
});

test('an unmatched original process still fails after it disappears before Quit', () => {
  const f = fixture(), unknown = { ...f.pending, pid: 13, groupId: 13, birth: 'linux-starttime:130' };
  const snapshot = captureDesktopMembershipCensus({ ...f.snapshot, children: [...f.snapshot.children, unknown] });
  assert.deepEqual(f.final.observed, []);
  assert.throws(() => assertDesktopMembershipCensus(snapshot, f.final), /every remaining original Host child/);
  assert.deepEqual(snapshot.children.at(-1), unknown);
});

for (const [field, value] of [['birth', 'linux-starttime:999'], ['parentPid', 99], ['command', '/TEST/foreign-bun']] as const)
  test('a later ready cannot replace the original child ' + field, () => {
    const f = fixture(), final = structuredClone(f.final);
    final.birthWitness.births[1] = { ...f.pending, [field]: value };
    assert.throws(() => assertDesktopMembershipCensus(f.snapshot, final));
  });

test('a later valid foreign source cannot claim a child captured before that source existed', () => {
  const f = fixture(), final = structuredClone(f.final), foreign = { ...f.pendingReady, profileHash: 'c'.repeat(64) };
  final.sources.profileHashes.push(foreign.profileHash);
  final.sources.records.push({ revision: 'TEST-later-source', grant: { ownerId: 'TEST-owner' } });
  final.lineage = captureDesktopSourceMetadataLineage({ root: '/TEST-never-read', host: f.host,
    profileHashes: final.sources.profileHashes, observed: [], executable: final.executable,
    original: f.snapshot.lineage, birthWitness: final.birthWitness, released: true },
  [f.originalReady, foreign, f.released(f.originalReady), f.released(foreign)]);
  assert.throws(() => assertDesktopMembershipCensus(f.snapshot, final), /scope was captured with this original physical census/);
});

test('serial ready and release logs cannot hide two physically overlapping same-profile metadata births', () => {
  const f = fixture(), final = structuredClone(f.final), next = { ...f.pendingReady, profileHash: f.originalReady.profileHash };
  final.lineage = captureDesktopSourceMetadataLineage({ root: '/TEST-never-read', host: f.host,
    profileHashes: final.sources.profileHashes, observed: [], executable: final.executable,
    original: f.snapshot.lineage, birthWitness: final.birthWitness, released: true },
  [f.originalReady, f.released(f.originalReady), next, f.released(next)]);
  assert.throws(() => assertDesktopMembershipCensus(f.snapshot, final), /same-profile metadata births overlap/);
});

test('PID reuse across later source profiles remains a lineage failure', () => {
  const f = fixture(), final = structuredClone(f.final);
  final.lineage = { ...final.lineage, events: [f.originalReady, f.released(f.originalReady),
    { ...f.pendingReady, pid: f.original.pid }, { ...f.released(f.pendingReady), pid: f.original.pid }] };
  assert.throws(() => assertDesktopMembershipCensus(f.snapshot, final), /no PID reuse/);
});

test('the original ready prefix cannot be rewritten by a later completed journal', () => {
  const f = fixture(), final = structuredClone(f.final);
  final.lineage = { ...final.lineage, events: final.lineage.events.map(event => event.pid === f.original.pid ?
    { ...event, startIdentityHash: 'd'.repeat(64) } : event) };
  assert.throws(() => assertDesktopMembershipCensus(f.snapshot, final), /immutable whole-log prefix/);
});

test('the original source record and captured source order cannot change', () => {
  for (const change of ['record', 'order']) {
    const f = fixture(), final = structuredClone(f.final);
    if (change === 'record') final.sources.records[0]!.grant.ownerId = 'TEST-other-owner';
    else final.sources.profileHashes.reverse();
    assert.throws(() => assertDesktopMembershipCensus(f.snapshot, final));
  }
});

test('a later ready without an original physical birth cannot classify metadata', () => {
  const f = fixture(), final = structuredClone(f.final); final.birthWitness.births.pop();
  assert.throws(() => assertDesktopMembershipCensus(f.snapshot, final), /needs a retained physical birth/);
});

test('unknown cleanup and unreleased metadata cannot pass final census reconciliation', () => {
  for (const stage of ['cleanup-unknown', 'ready'] as const) {
    const f = fixture(), final = structuredClone(f.final);
    final.lineage = { ...final.lineage, events: stage === 'ready' ? final.lineage.events.slice(0, -1) :
      final.lineage.events.map((event, index) => index === 3 ? { ...event, stage } : event) };
    assert.throws(() => assertDesktopMembershipCensus(f.snapshot, final));
  }
});

test('the same original Host must have exited before any final classification', () => {
  const f = fixture();
  assert.throws(() => assertDesktopMembershipCensus(f.snapshot, { ...f.final, observed: [f.host] }), /original Host exited/);
});

test('exact Runtime identity remains required even when the final total equals two', () => {
  const f = fixture(), runtimes = captureDesktopMembershipRuntimes(new Map([
    ['claude', { ...f.claude, birth: 'linux-starttime:999' }], ['codex', f.codex],
  ]));
  assert.throws(() => assertDesktopMembershipCensus(f.snapshot, { ...f.final, runtimes }), /exact Runtime already qualified/);
});

test('Runtime PID duplication cannot satisfy two distinct provider slots', () => {
  const f = fixture(), runtimes = captureDesktopMembershipRuntimes(new Map([['claude', f.claude], ['codex', f.claude]]));
  assert.throws(() => assertDesktopMembershipCensus(f.snapshot, { ...f.final, runtimes }));
});

async function originalRelease(f: ReturnType<typeof fixture>, calls: string[], snapshot = f.snapshot) {
  const source = await readFile(new URL('./desktop-live-membership-ui-smoke.ts', import.meta.url), 'utf8');
  const begin = '  const releasedEpoch = async () => {', end = '  const censusClosures:';
  assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
  const actual = stripTypeScriptTypes(source.slice(source.indexOf(begin), source.indexOf(end)));
  const make = Function('environment', `
    const {assert,finite,v2,physical,sourceProfiles,metadataCensus,fixture,openCodeExecutable,
      captureDesktopSourceMetadataLineage,assertDesktopMembershipCensus,epochCensuses,epochs,pins}=environment;
    let {host,lineage}=environment;
    const text=value=>value,metadataBirths=[],processFacts=()=>{throw Error('unexpected discovery');};
    ${actual}
    return releasedEpoch;`) as (environment: Record<string, unknown>) => () => Promise<void>;
  return make({ assert, finite: true, v2: true, host: f.host, lineage: f.snapshot.lineage,
    fixture: { root: '/TEST-never-read' }, openCodeExecutable: { path: f.final.executable },
    epochCensuses: [{ snapshot, runtimes: f.final.runtimes }], epochs: [],
    physical: async () => { calls.push('release-physical'); return f.final.observed; },
    sourceProfiles: async () => { calls.push('release-source'); return f.final.sources; },
    metadataCensus: { witness: () => { calls.push('release-witness'); return f.final.birthWitness; } },
    captureDesktopSourceMetadataLineage: (options: Parameters<typeof captureDesktopSourceMetadataLineage>[0]) => {
      calls.push('release-lineage'); return captureDesktopSourceMetadataLineage(options, f.final.lineage.events);
    },
    assertDesktopMembershipCensus: (...args: Parameters<typeof assertDesktopMembershipCensus>) => {
      calls.push('reconcile'); return assertDesktopMembershipCensus(...args);
    }, pins: async () => { calls.push('release-pins'); },
  });
}

async function originalRestart(releasedEpoch: () => Promise<void>, calls: string[]) {
  const source = await readFile(new URL('./desktop-live-membership-ui-smoke.ts', import.meta.url), 'utf8');
  const begin = '    cdp = await options.restartSameProfile(handleId, async () => {', end = '    assert.ok(afterQuitProbes);';
  assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
  const actual = stripTypeScriptTypes(source.slice(source.indexOf(begin), source.indexOf(end)));
  const run = Function('environment', `return (async () => {
    const {assert,options,releasedEpoch,probeLedger,beforeQuitProbes,proof,disposeReadObservations,armMetadataCensus}=environment;
    let cdp,afterQuitProbes,host,lineage,metadataBirths=[],epochCensuses=[];
    const handleId='TEST-original-handle',metadataCensus={assertHealthy(){}};
    ${actual}
  })();`) as (environment: Record<string, unknown>) => Promise<void>;
  await run({ assert, releasedEpoch, beforeQuitProbes: [], proof: {},
    probeLedger: async () => { calls.push('original-probe-ledger'); return []; },
    disposeReadObservations: () => calls.push('dispose-original'), armMetadataCensus: () => calls.push('arm-cold'),
    options: { capturedGroup: () => 2, restartSameProfile: async (handleId: string, afterQuit: () => Promise<void>) => {
      assert.equal(handleId, 'TEST-original-handle'); calls.push('original-Quit'); await afterQuit(); calls.push('cold-spawn');
    } },
  });
}

test('the actual first-Quit callback finishes snapshot reconciliation before cold spawn', async () => {
  const f = fixture(), calls: string[] = [];
  await originalRestart(await originalRelease(f, calls), calls);
  assert.deepEqual(calls, ['original-Quit', 'release-physical', 'release-source', 'release-witness', 'release-lineage',
    'reconcile', 'release-pins', 'original-probe-ledger', 'dispose-original', 'arm-cold', 'cold-spawn']);
});

test('a retained unmatched process blocks the actual first-Quit callback before cold spawn', async () => {
  const f = fixture(), calls: string[] = [], unknown = { ...f.pending, pid: 13, groupId: 13, birth: 'linux-starttime:130' };
  const snapshot = captureDesktopMembershipCensus({ ...f.snapshot, children: [...f.snapshot.children, unknown] });
  await assert.rejects(originalRestart(await originalRelease(f, calls, snapshot), calls),
    /every remaining original Host child/);
  assert.deepEqual(calls, ['original-Quit', 'release-physical', 'release-source', 'release-witness', 'release-lineage', 'reconcile']);
});
