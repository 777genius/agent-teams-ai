import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import type { DesktopMetadataWitness } from './desktop-metadata-witness.ts';

type Row = Record<string, unknown>;
export interface DesktopMetadataEvent {
  readonly hostPid: number;
  readonly profileHash: string;
  readonly mode: 'directory' | 'provider';
  readonly providerHash: string | null;
  readonly pid: number;
  readonly startIdentityHash: string;
  readonly stage: 'ready' | 'released' | 'cleanup-unknown';
}
export interface DesktopMetadataLineage {
  readonly profileHashes: readonly string[];
  readonly events: readonly DesktopMetadataEvent[];
  readonly births: readonly ProcessFact[];
}
export interface DesktopNativeHostSnapshot {
  host: ProcessFact;
  children: ProcessFact[];
  metadataLineage?: DesktopMetadataLineage;
}
interface DesktopMetadataFailure {
  readonly hostPid: number;
  readonly expectedProfileHashes: readonly string[];
  readonly events: readonly DesktopMetadataEvent[];
  readonly observedMetadataPids: readonly number[];
}
const failures = new WeakMap<Error, DesktopMetadataFailure>();

/** Only the original failed read can supply these closed diagnostic facts. */
export function readDesktopMetadataLineageFailure(error: unknown): DesktopMetadataFailure | undefined {
  return error instanceof Error ? failures.get(error) : undefined;
}
const object = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const desktopMetadataProfileHash = (value: { profileId: string; configRevision: string }): string =>
  createHash('sha256').update(JSON.stringify([value.profileId, value.configRevision])).digest('hex');
const identity = (value: DesktopMetadataEvent) => [value.hostPid, value.profileHash, value.mode,
  value.providerHash, value.pid, value.startIdentityHash];

/** Parse the existing private log only; this observation has no process/Host authority. */
export function readDesktopMetadataEvents(root: string, hostPid: number, allowEmpty = false): DesktopMetadataEvent[] {
  const directory = join(root, 'userData/logs');
  let rotated = Buffer.alloc(0);
  try { rotated = readFileSync(join(directory, 'app-errors.1.ndjson')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bytes = readFileSync(join(directory, 'app-errors.ndjson'));
  assert.ok(rotated.length + bytes.length <= 4 * 1024 * 1024, 'bounded existing app diagnostic logs');
  const events: DesktopMetadataEvent[] = [];
  for (const line of Buffer.concat([rotated, bytes]).toString('utf8').split('\n')) {
    if (!line) continue;
    const entry = object(JSON.parse(line));
    if (entry.namespace !== 'Host:OpenCodeMetadata') continue;
    const match = /^OpenCode metadata stage (\{.*\})$/.exec(String(entry.message));
    assert.ok(match, 'closed metadata diagnostic framing');
    const value = object(JSON.parse(match[1]!));
    if (value.hostPid !== hostPid) continue;
    if (value.stage === 'read-failed') {
      assert.deepEqual(Object.keys(value).sort(), ['aborted', 'deadlineExpired', 'elapsedMs', 'hostPid',
        'mode', 'profileHash', 'providerHash', 'readStage', 'reason', 'stage']);
      assert.ok(hash(value.profileHash));
      assert.ok(value.mode === 'directory' || value.mode === 'provider');
      assert.ok(value.providerHash === null || hash(value.providerHash));
      assert.equal(value.mode === 'directory', value.providerHash === null);
      assert.ok(typeof value.readStage === 'string' && ['admission', 'native-client', 'identity',
        'plugins', 'permissions', 'mcp', 'credential', 'directory', 'activation-wait', 'current',
        'projection', 'dispose', 'result-current'].includes(value.readStage));
      assert.ok(typeof value.reason === 'string' && ['held', 'conflict', 'invalid', 'busy', 'deadline',
        'cleanup_unknown', 'transport_failure', 'authority_mismatch', 'disposed', 'http_failure',
        'media_type', 'body_limit', 'frame_limit', 'invalid_response', 'invalid_native_catalog',
        'native_catalog_binding_mismatch', 'capabilities_pending', 'unqualified_version', 'ABORT_ERR',
        'unknown'].includes(value.reason));
      assert.ok(typeof value.elapsedMs === 'number' && Number.isSafeInteger(value.elapsedMs) &&
        value.elapsedMs >= 0 && value.elapsedMs <= 3_600_000);
      assert.equal(typeof value.deadlineExpired, 'boolean');
      assert.ok(value.aborted === null || typeof value.aborted === 'boolean');
      continue; // A read failure has no native birth or lifecycle/cleanup authority.
    }
    assert.deepEqual(Object.keys(value).sort(), ['hostPid', 'mode', 'pid', 'profileHash', 'providerHash', 'stage', 'startIdentityHash']);
    assert.ok(hash(value.profileHash));
    assert.ok(value.mode === 'directory' || value.mode === 'provider');
    assert.ok(value.providerHash === null || hash(value.providerHash));
    assert.equal(value.mode === 'directory', value.providerHash === null);
    assert.ok(typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 1);
    assert.ok(hash(value.startIdentityHash));
    assert.ok(value.stage === 'ready' || value.stage === 'released' || value.stage === 'cleanup-unknown');
    events.push({ hostPid, profileHash: value.profileHash, mode: value.mode, providerHash: value.providerHash,
      pid: value.pid, startIdentityHash: value.startIdentityHash, stage: value.stage });
  }
  assert.ok((allowEmpty || events.length > 0) && events.length <= 128, 'finite original metadata lifecycle observations');
  return events;
}
const readEvents = readDesktopMetadataEvents;

/** One captured owner per profile; a successor requires the previous exact ready's confirmed close. */
function lifecycle(events: readonly DesktopMetadataEvent[], profileHashes: readonly string[], hostPid: number, allowEmpty = false) {
  assert.ok(profileHashes.length === 1 || profileHashes.length === 2);
  assert.equal(new Set(profileHashes).size, profileHashes.length);
  assert.ok(profileHashes.every(hash));
  assert.ok((allowEmpty || events.length > 0) && events.length <= 128);
  const originals = new Map<number, DesktopMetadataEvent>(), active = new Map<string, DesktopMetadataEvent>();
  for (const event of events) {
    assert.equal(event.hostPid, hostPid);
    assert.ok(profileHashes.includes(event.profileHash), 'original captured scope, never current UI selection');
    assert.notEqual(event.pid, hostPid);
    if (event.stage === 'ready') {
      assert.ok(!originals.has(event.pid), 'a reused PID cannot become a new metadata baseline');
      assert.ok(!active.has(event.profileHash), 'no duplicate live metadata owner for the same captured profile');
      originals.set(event.pid, event); active.set(event.profileHash, event);
    } else {
      const original = originals.get(event.pid);
      assert.ok(original, 'release needs its original ready observation');
      assert.deepEqual(identity(event), identity(original));
      assert.equal(active.get(event.profileHash), original, 'exact original close, once');
      assert.equal(event.stage, 'released', 'unknown cleanup never proves original release');
      active.delete(event.profileHash);
    }
  }
  return { originals, active };
}


/** A passive readiness count, never a physical birth, Runtime or release qualification. */
export function desktopMetadataReadyScopeCount(
  events: readonly DesktopMetadataEvent[], profileHashes: readonly string[], hostPid: number
): number {
  return lifecycle(events, profileHashes, hostPid, true).active.size;
}

export function assertDesktopMetadataLineageRetained(
  original: DesktopMetadataLineage, current: DesktopMetadataLineage
): void {
  assert.ok(original.profileHashes.every(hash => current.profileHashes.includes(hash)));
  assert.deepEqual(current.events.slice(0, original.events.length), original.events,
    'all original ready/close observations remain an immutable prefix');
  assert.equal(new Set(current.births.map(row => row.pid)).size, current.births.length);
  for (const birth of original.births)
    assert.deepEqual(current.births.find(row => row.pid === birth.pid), birth,
      'an original physical birth is never replaced or discarded');
}

/** Pure lineage oracle also used by the existing critical lifecycle regression. */
export function captureDesktopMetadataLineage(options: {
  events: readonly DesktopMetadataEvent[];
  host: ProcessFact;
  profileHashes: readonly string[];
  observed: readonly ProcessFact[];
  executable: string;
  original?: DesktopMetadataLineage;
  initialBirths?: readonly ProcessFact[];
}): DesktopMetadataLineage {
  const { events, host, profileHashes, observed, original, initialBirths } = options;
  const state = lifecycle(events, profileHashes, host.pid);
  assert.equal(state.active.size, profileHashes.length, 'every selected metadata scope has one live owner');
  assert.ok(!original || initialBirths === undefined, 'initial physical births cannot replace an existing lineage');
  if (initialBirths) {
    assert.ok(initialBirths.length <= profileHashes.length);
    assert.equal(new Set(initialBirths.map(row => row.pid)).size, initialBirths.length);
    for (const before of initialBirths) {
      assert.ok(state.originals.has(before.pid), 'each pre-read physical birth has its original ready observation');
      assert.equal(before.parentPid, host.pid); assert.equal(before.groupId, before.pid);
      assert.equal(before.command, options.executable);
      assert.ok(typeof before.birth === 'string' && before.birth.length > 0);
    }
  }
  const births = (original?.births ?? initialBirths ?? []).map(row => ({ ...row }));
  for (const [pid, event] of state.originals) {
    const physical = observed.filter(row => row.pid === pid);
    if (state.active.get(event.profileHash) === event) {
      assert.equal(physical.length, 1, 'original ready is physically present');
      const current = physical[0]!;
      assert.equal(current.parentPid, host.pid); assert.equal(current.groupId, pid);
      assert.equal(current.command, options.executable, 'same captured Bun executable');
      const before = births.find(row => row.pid === pid);
      if (before) assert.deepEqual(current, before, 'original metadata birth is unchanged');
      else births.push({ ...current });
    } else assert.equal(physical.length, 0, 'confirmed retired original metadata PID is physically absent');
  }
  const result: DesktopMetadataLineage = {
    profileHashes: [...profileHashes], events: events.map(row => ({ ...row })), births,
  };
  if (original) assertDesktopMetadataLineageRetained(original, result);
  return result;
}

export function readDesktopMetadataLineage(root: string, captured: DesktopNativeHostSnapshot,
  profileHashes: readonly string[], observed: readonly ProcessFact[], original?: DesktopMetadataLineage,
  initialBirths?: readonly ProcessFact[]
): DesktopMetadataLineage {
  const events = readEvents(root, captured.host.pid);
  try {
    return captureDesktopMetadataLineage({ events, host: captured.host,
      profileHashes, observed, executable: process.env.OPENCODE_V2_EMBEDDED_BUN!, ...(original ? { original } : {}),
      ...(initialBirths ? { initialBirths } : {}) });
  } catch (error) {
    if (error instanceof Error && profileHashes.length >= 1 && profileHashes.length <= 2 && profileHashes.every(hash)) {
      const eventPids = new Set(events.map(event => event.pid));
      failures.set(error, Object.freeze({
        hostPid: captured.host.pid,
        expectedProfileHashes: Object.freeze([...profileHashes]),
        events: Object.freeze(events.map(event => Object.freeze({ ...event }))),
        observedMetadataPids: Object.freeze([...new Set(observed.filter(row => eventPids.has(row.pid)).map(row => row.pid))]),
      }));
    }
    throw error;
  }
}

export function desktopActiveMetadata(captured: DesktopNativeHostSnapshot): ProcessFact[] {
  assert.ok(captured.metadataLineage, 'captured original metadata lineage');
  const state = lifecycle(captured.metadataLineage.events, captured.metadataLineage.profileHashes, captured.host.pid);
  assert.equal(state.active.size, captured.metadataLineage.profileHashes.length);
  return [...state.active.values()].map(event => {
    const birth = captured.metadataLineage!.births.find(row => row.pid === event.pid);
    assert.ok(birth);
    assert.deepEqual(captured.children.find(row => row.pid === event.pid), birth);
    return birth;
  });
}

/** Called after the same Host has exited, before harness cleanup; reads cannot create/adopt a child. */
export function assertDesktopMetadataLineageReleased(root: string, original: DesktopNativeHostSnapshot,
  observed: readonly { pid: number }[]
): DesktopMetadataLineage {
  assert.ok(original.metadataLineage);
  const events = readEvents(root, original.host.pid), profileHashes = original.metadataLineage.profileHashes;
  const result = { profileHashes, events, births: original.metadataLineage.births };
  assertDesktopMetadataReleasedEvidence(original, result, observed);
  return result;
}

export function desktopMetadataProcess(captured: DesktopNativeHostSnapshot, profileHash: string): ProcessFact {
  assert.ok(captured.metadataLineage);
  const state = lifecycle(captured.metadataLineage.events, captured.metadataLineage.profileHashes, captured.host.pid);
  const selected = state.active.get(profileHash); assert.ok(selected, 'one live original owner for this captured source');
  const process = desktopActiveMetadata(captured).find(row => row.pid === selected.pid);
  assert.ok(process); return process;
}

export function assertDesktopMetadataReleasedEvidence(original: DesktopNativeHostSnapshot,
  result: DesktopMetadataLineage, observed: readonly { pid: number }[]
): void {
  assert.ok(original.metadataLineage);
  assert.deepEqual(result.profileHashes, original.metadataLineage.profileHashes);
  const state = lifecycle(result.events, result.profileHashes, original.host.pid);
  assert.equal(state.active.size, 0, 'guarded Quit confirmed close of every original metadata owner');
  assertDesktopMetadataLineageRetained(original.metadataLineage, result);
  for (const pid of state.originals.keys())
    assert.equal(observed.some(row => row.pid === pid), false, 'every original metadata PID is absent before harness cleanup');
}

export interface DesktopSourceMetadataLineage {
  readonly host: ProcessFact;
  readonly profileHashes: readonly string[];
  readonly events: readonly DesktopMetadataEvent[];
  readonly partitions: readonly DesktopMetadataLineage[];
  readonly live: readonly ProcessFact[];
}

/** Actual pre-ready observations under one captured Host; never process-control authority. */
export interface DesktopMetadataBirthWitness {
  readonly host: ProcessFact;
  readonly births: readonly ProcessFact[];
}

function witnessedPartition(options: {
  host: ProcessFact; executable: string; profileHash: string; events: readonly DesktopMetadataEvent[];
  observed: readonly ProcessFact[]; witness: DesktopMetadataBirthWitness;
  original?: DesktopMetadataLineage;
}): DesktopMetadataLineage {
  const { host, events, witness, observed } = options;
  assert.deepEqual(witness.host, host, 'pre-ready births belong to this exact original Host');
  assert.ok(witness.births.length <= 128);
  assert.equal(new Set(witness.births.map(row => row.pid)).size, witness.births.length);
  const state = lifecycle(events, [options.profileHash], host.pid);
  const births: ProcessFact[] = [];
  for (const [pid, ready] of state.originals) {
    const birth = witness.births.find(row => row.pid === pid);
    assert.ok(birth, 'every original metadata ready, including retired predecessors, needs a retained physical birth');
    assert.equal(birth.parentPid, host.pid); assert.equal(birth.groupId, pid);
    assert.equal(birth.command, options.executable);
    assert.match(birth.birth, /^linux-starttime:[1-9]\d*$/u);
    assert.equal(ready.startIdentityHash, createHash('sha256').update(pid + ':' +
      birth.birth.slice('linux-starttime:'.length)).digest('hex'), 'exact original Linux metadata birth');
    const physical = observed.filter(row => row.pid === pid);
    if (state.active.get(options.profileHash) === ready) {
      assert.equal(physical.length, 1, 'original ready is physically present');
      assert.deepEqual(physical[0], birth, 'the physically active original birth is unchanged');
    } else assert.equal(physical.length, 0, 'the original retired birth is physically absent');
    births.push({ ...birth });
  }
  const result = { profileHashes: [options.profileHash], events: events.map(row => ({ ...row })), births };
  if (options.original) assertDesktopMetadataLineageRetained(options.original, result);
  return result;
}

/** The live sampler may supply its same-census log snapshot; full reads always reread the original log. */
export function captureDesktopSourceMetadataLineage(options: {
  root: string;
  host: ProcessFact;
  profileHashes: readonly string[];
  observed: readonly ProcessFact[];
  executable: string;
  original?: DesktopSourceMetadataLineage;
  witness?: DesktopMetadataWitness;
  birthWitness?: DesktopMetadataBirthWitness;
  released?: boolean;
}, sampledEvents?: readonly DesktopMetadataEvent[]): DesktopSourceMetadataLineage {
  const { host, profileHashes, observed } = options;
  const witnessed = options.witness?.read(), original = witnessed ?? options.original;
  if (witnessed && options.original) {
    assert.deepEqual(witnessed.host, options.original.host);
    assert.deepEqual(witnessed.profileHashes.slice(0, options.original.profileHashes.length), options.original.profileHashes);
    assert.deepEqual(witnessed.events.slice(0, options.original.events.length), options.original.events);
    for (const partition of options.original.partitions) {
      const next = witnessed.partitions.find(row => row.profileHashes[0] === partition.profileHashes[0]);
      assert.ok(next); assertDesktopMetadataLineageRetained(partition, next);
    }
  }
  assert.ok(profileHashes.length >= 1 && profileHashes.length <= 3);
  assert.equal(new Set(profileHashes).size, profileHashes.length);
  assert.ok(profileHashes.every(hash));
  const events = sampledEvents ?? readEvents(options.root, host.pid);
  assert.ok(events.length > 0 && events.length <= 128, 'finite original metadata lifecycle observations');
  if (original) {
    assert.deepEqual(host, original.host, 'same original source-selection Host');
    assert.deepEqual(profileHashes.slice(0, original.profileHashes.length), original.profileHashes);
    assert.deepEqual(events.slice(0, original.events.length), original.events,
      'one immutable whole-log prefix before any profile partition');
  }
  const originals = new Map<number, DesktopMetadataEvent>(), active = new Map<string, DesktopMetadataEvent>();
  for (const event of events) {
    assert.equal(event.hostPid, host.pid);
    assert.ok(profileHashes.includes(event.profileHash), 'only original configuration/A/B source scopes');
    assert.notEqual(event.pid, host.pid);
    if (event.stage === 'ready') {
      assert.ok(!originals.has(event.pid), 'no PID reuse across any original source profile');
      assert.ok(!active.has(event.profileHash), 'one live metadata owner per source profile');
      originals.set(event.pid, event); active.set(event.profileHash, event);
    } else {
      const ready = originals.get(event.pid);
      assert.ok(ready, 'original ready precedes its close');
      assert.deepEqual(identity(event), identity(ready));
      assert.equal(active.get(event.profileHash), ready);
      assert.equal(event.stage, 'released', 'unknown cleanup cannot retire metadata');
      active.delete(event.profileHash);
    }
  }
  const partitions: DesktopMetadataLineage[] = [], live: ProcessFact[] = [];
  for (const profileHash of profileHashes) {
    const subset = events.filter(event => event.profileHash === profileHash);
    if (subset.length === 0) continue;
    const before = original?.partitions.find(value => value.profileHashes[0] === profileHash);
    const ready = active.get(profileHash);
    let result: DesktopMetadataLineage;
    if (options.birthWitness) {
      result = witnessedPartition({ host, executable: options.executable, profileHash, events: subset,
        observed, witness: options.birthWitness, ...(before ? { original: before } : {}) });
      if (ready) {
        const birth = result.births.find(value => value.pid === ready.pid); assert.ok(birth);
        live.push({ ...birth });
      }
    } else if (ready) {
      result = captureDesktopMetadataLineage({ events: subset, host, profileHashes: [profileHash],
        observed, executable: options.executable, ...(before ? { original: before } : {}) });
      const birth = result.births.find(value => value.pid === ready.pid); assert.ok(birth);
      live.push({ ...birth });
    } else {
      assert.ok(before, 'a retired profile needs its previously retained physical lineage');
      result = { profileHashes: [profileHash], events: subset, births: before.births };
      assertDesktopMetadataReleasedEvidence({ host, children: [], metadataLineage: before }, result, observed);
    }
    partitions.push(result);
  }
  if (options.released) assert.equal(live.length, 0, 'original Quit released all observed metadata owners');
  return { host: { ...host }, profileHashes: [...profileHashes], events: events.map(value => ({ ...value })),
    partitions, live };
}
