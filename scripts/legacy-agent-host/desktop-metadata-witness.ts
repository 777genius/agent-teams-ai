/** TEST-only live observations. These records never grant process or signal authority. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { command } from './desktop-backend-observations.ts';
import { assertDesktopMetadataLineageRetained, captureDesktopSourceMetadataLineage } from './desktop-opencode-metadata-lineage.ts';
import type { DesktopMetadataEvent, DesktopSourceMetadataLineage } from './desktop-opencode-metadata-lineage.ts';

type Observation = Omit<Parameters<typeof captureDesktopSourceMetadataLineage>[0], 'original' | 'witness' | 'released'> & {
  events?: readonly DesktopMetadataEvent[];
};

export interface DesktopMetadataWitness {
  observe(): void;
  read(): DesktopSourceMetadataLineage | undefined;
  retain(value: DesktopSourceMetadataLineage): void;
}

function retained(before: DesktopSourceMetadataLineage, after: DesktopSourceMetadataLineage): void {
  assert.deepEqual(after.host, before.host, 'same original early metadata Host');
  assert.deepEqual(after.profileHashes.slice(0, before.profileHashes.length), before.profileHashes);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events, 'original early metadata log prefix');
  for (const partition of before.partitions) {
    const next = after.partitions.find(row => row.profileHashes[0] === partition.profileHashes[0]);
    assert.ok(next, 'an early physical metadata partition is retained');
    assertDesktopMetadataLineageRetained(partition, next);
  }
}

/** Invoked only at already-existing UI fences; a missed or changed birth stays a refusal. */
export function createDesktopMetadataWitness(read: () => Observation | undefined): DesktopMetadataWitness {
  let original: DesktopSourceMetadataLineage | undefined, failure: unknown, failed = false;
  const guard = () => { if (failed) throw failure; };
  const retain = (value: DesktopSourceMetadataLineage) => {
    guard();
    try {
      if (original) retained(original, value);
      assert.match(value.host.birth, /^linux-starttime:\d+$/u, 'an early witness needs the original Linux Host birth');
      for (const partition of value.partitions) {
        for (const ready of partition.events.filter(row => row.stage === 'ready'))
          assert.ok(partition.births.some(birth => birth.pid === ready.pid),
            'every ready metadata process needs its original retained physical birth');
        for (const birth of partition.births) {
          assert.match(birth.birth, /^linux-starttime:\d+$/u, 'an early witness needs the original Linux kernel birth');
          const ready = partition.events.find(row => row.pid === birth.pid && row.stage === 'ready'); assert.ok(ready);
          assert.equal(ready.startIdentityHash, createHash('sha256').update(birth.pid + ':' +
            birth.birth.slice('linux-starttime:'.length)).digest('hex'), 'the ready record names this exact native birth');
        }
      }
      original = structuredClone(value);
    } catch (error) { failed = true; failure = error; throw error; }
  };
  return {
    observe() {
      guard();
      try {
        const observation = read();
        if (!observation) {
          assert.equal(original, undefined, 'an original early metadata lifecycle cannot disappear');
          return;
        }
        const { events, ...physical } = observation;
        retain(captureDesktopSourceMetadataLineage({ ...physical, ...(original ? { original } : {}) }, events));
      } catch (error) { failed = true; failure = error; throw error; }
    },
    read() { guard(); return original && structuredClone(original); },
    retain,
  };
}

/** Same regular-file/currentness fences as the original membership read, without an await. */
export function readDesktopMetadataSourceFile(path: string, maximum: number): Record<string, unknown> {
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum);
  assert.equal(realpathSync(path), path);
  const same = (after: typeof before) => {
    assert.ok(after.isFile() && !after.isSymbolicLink());
    for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'] as const)
      assert.equal(after[key], before[key], 'original file observation is current');
  };
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    same(fstatSync(file)); const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(file, bytes, length, bytes.length - length, length);
      if (!count) break; length += count;
    }
    assert.equal(length, before.size); assert.ok(length <= maximum);
    same(fstatSync(file)); same(lstatSync(path));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, unknown>;
  } finally { closeSync(file); }
}

/** Only currently-ready metadata PIDs are sampled; Runtime/probe Bun children are never adopted. */
export function createDesktopLinuxMetadataObservation(options: {
  root: string;
  group(): number;
  node: string;
  hostEntry: string;
  executable: string;
  embeddedEntry: string;
  profileHashes(): readonly string[];
  events(hostPid: number): readonly DesktopMetadataEvent[];
}): () => Observation | undefined {
  let originalHost: ProcessFact | undefined, eventsSeen = false;
  const identity = (pid: number) => {
    const bytes = readFileSync(`/proc/${pid}/stat`, 'utf8'); assert.ok(Buffer.byteLength(bytes) <= 4096);
    const fields = bytes.slice(bytes.lastIndexOf(')') + 2).trim().split(/\s+/u);
    assert.match(fields[19] ?? '', /^\d+$/u);
    return { parentPid: Number(fields[1]), groupId: Number(fields[2]), birth: 'linux-starttime:' + fields[19] };
  };
  const capture = (row: ProcessFact, executable: string, argv: readonly string[], startIdentityHash?: string): ProcessFact => {
    const before = identity(row.pid);
    if (startIdentityHash !== undefined) assert.equal(startIdentityHash, createHash('sha256')
      .update(row.pid + ':' + before.birth.slice('linux-starttime:'.length)).digest('hex'), 'original ready kernel birth');
    assert.equal(realpathSync(`/proc/${row.pid}/exe`), executable);
    const bytes = readFileSync(`/proc/${row.pid}/cmdline`); assert.ok(bytes.length <= 128 * 1024);
    assert.deepEqual(bytes.toString('utf8').split('\0').filter(Boolean), argv);
    assert.deepEqual(identity(row.pid), before, 'original Linux metadata birth did not change');
    assert.equal(before.parentPid, row.parentPid); assert.equal(before.groupId, row.groupId);
    return { ...row, ...before, command: executable };
  };
  return () => {
    assert.equal(process.platform, 'linux');
    const table = processFacts(), hosts = table.filter(row => row.groupId === options.group() &&
      command(row.pid) === options.node + ' ' + options.hostEntry);
    if (hosts.length === 0 && !originalHost) return undefined;
    assert.equal(hosts.length, 1, 'one original captured metadata Host');
    const host = capture(hosts[0]!, options.node, [options.node, options.hostEntry]);
    if (originalHost) assert.deepEqual(host, originalHost); else originalHost = host;
    const profileHashes = options.profileHashes();
    let events: readonly DesktopMetadataEvent[];
    try { events = options.events(host.pid); }
    catch (error) { if (!eventsSeen && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    assert.ok(events.length <= 128);
    if (events.length === 0) {
      assert.equal(eventsSeen, false, 'an original metadata log cannot disappear');
      return undefined; // Pending only; the full oracle still requires lifecycle evidence.
    }
    eventsSeen = true;
    const active = new Map<string, DesktopMetadataEvent>();
    for (const event of events) {
      assert.equal(event.hostPid, host.pid); assert.ok(profileHashes.includes(event.profileHash));
      if (event.stage === 'ready') active.set(event.profileHash, event);
      else active.delete(event.profileHash);
    }
    const observed = table.map(row => {
      if (!Array.from(active.values()).some(event => event.pid === row.pid)) return row;
      assert.equal(row.parentPid, host.pid); assert.equal(row.groupId, row.pid);
      const ready = Array.from(active.values()).find(event => event.pid === row.pid)!;
      return capture(row, options.executable, [options.executable, '--no-env-file', '--config=/dev/null',
        '--no-install', options.embeddedEntry], ready.startIdentityHash);
    });
    assert.deepEqual(identity(host.pid), { parentPid: host.parentPid, groupId: host.groupId, birth: host.birth });
    return { root: options.root, host, profileHashes, observed, executable: options.executable, events };
  };
}
