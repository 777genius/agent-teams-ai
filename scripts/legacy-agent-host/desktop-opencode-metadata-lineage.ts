import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';

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
function readEvents(root: string, hostPid: number): DesktopMetadataEvent[] {
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
  assert.ok(events.length > 0 && events.length <= 128, 'finite original metadata lifecycle observations');
  return events;
}

/** One captured owner per profile; a successor requires the previous exact ready's confirmed close. */
function lifecycle(events: readonly DesktopMetadataEvent[], profileHashes: readonly string[], hostPid: number) {
  assert.ok(profileHashes.length === 1 || profileHashes.length === 2);
  assert.equal(new Set(profileHashes).size, profileHashes.length);
  assert.ok(profileHashes.every(hash));
  assert.ok(events.length > 0 && events.length <= 128);
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
}): DesktopMetadataLineage {
  const { events, host, profileHashes, observed, original } = options;
  const state = lifecycle(events, profileHashes, host.pid);
  assert.equal(state.active.size, profileHashes.length, 'every selected metadata scope has one live owner');
  const births = (original?.births ?? []).map(row => ({ ...row }));
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
  profileHashes: readonly string[], observed: readonly ProcessFact[], original?: DesktopMetadataLineage
): DesktopMetadataLineage {
  return captureDesktopMetadataLineage({ events: readEvents(root, captured.host.pid), host: captured.host,
    profileHashes, observed, executable: process.env.OPENCODE_V2_EMBEDDED_BUN!, ...(original ? { original } : {}) });
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
