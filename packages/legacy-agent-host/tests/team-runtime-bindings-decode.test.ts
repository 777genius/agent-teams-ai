import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { FileTeamRuntimeBindings } from '../dist/adapters/team/FileTeamRuntimeBindings.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import type { TeamLaunchRecord } from '../dist/team-launch/contracts.js';
import type { TeamStore } from '../dist/team/ports.js';

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'TEST-launch-decode-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const store = new TeamOwnerStore(root, 'test-team');
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
    memberId: 'A', generation: 'original-1' };
  const members = ['A', 'B'].map(memberId => ({ memberId, binding: { ...binding, memberId },
    runtimeGeneration: 1, configurationDigest: runtimeDigest({ memberId }),
    baseConfigurationDigest: runtimeDigest({ base: memberId }), contextDigest: runtimeDigest({ context: memberId }),
    configRevision: 'TEST-config', skipped: false, timeoutMs: 10000 }));
  const definition = { launchId: binding.runId, rosterRevision: 'TEST-roster', members };
  const row: TeamLaunchRecord = { schemaVersion: 1, definition, fingerprint: runtimeDigest(definition),
    members: members.map(member => ({ memberId: member.memberId, currentAttemptId: 'initial',
      attempts: [{ attemptId: 'initial', hostIncarnation: 'TEST-host', startedAtMs: 0, deadlineMs: 0,
        claimed: false, status: 'not-started', reason: 'TEST', nativeReady: false, contextApplied: false,
        everReady: false, usable: false, controlAvailable: false, noAllocation: false }] })), retries: [] };
  const name = `launches/${runtimeDigest(binding.runId)}.json`, path = join(store.directory, name);
  store.write(name, row);
  fs.writeFileSync(path, JSON.stringify(row));
  const text = fs.readFileSync(path, 'utf8'), bindings = new FileTeamRuntimeBindings(store);
  const counts = { parses: 0, validations: 0, fileReads: 0 };
  const parse = JSON.parse, stringify = JSON.stringify, readFile = fs.readFileSync;
  const mocks = [
    t.mock.method(JSON, 'parse', (...args: Parameters<typeof parse>) => {
      if (/"launchId"\s*:\s*"TEST-run"/.test(args[0])) counts.parses++;
      return parse(...args);
    }),
    t.mock.method(JSON, 'stringify', (...args: Parameters<typeof stringify>) => {
      if (args[0]?.schemaVersion === 1 && args[0]?.definition) counts.validations++;
      return stringify(...args);
    }),
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof readFile>) => {
      if (args[0] === path) { counts.fileReads++; assert.equal(args[1], 'utf8'); }
      return readFile(...args);
    }),
  ];
  syncBuiltinESMExports();
  t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
  const reading = (read: TeamStore['read']) => new FileTeamRuntimeBindings({
    read, fenced: action => store.fenced(action), write: (file, value) => store.write(file, value),
    list: directory => store.list(directory), productFingerprint: team => store.productFingerprint(team),
  });
  return { store, row, name, path, text, binding, bindings, counts, reading,
    write: (value: string) => fs.writeFileSync(path, value), stringify };
}

test('same fresh launch text is parsed every time and reuses only pure validation while projections stay fresh', t => {
  const f = fixture(t);
  const first = f.bindings.current(f.binding)!;
  first.binding.generation = 'TEST-caller-mutation';
  assert.equal(f.bindings.current(f.binding)!.binding.generation, 'original-1');
  assert.equal(f.bindings.current({ ...f.binding, memberId: 'B' })!.binding.memberId, 'B');
  assert.equal(f.bindings.retained(f.binding, f.binding), false);
  assert.deepEqual(f.counts, { parses: 4, validations: 1, fileReads: 4 });
  assert.throws(() => f.bindings.current(f.binding, 'cp1-' + 'a'.repeat(64)), /hold/);
  assert.throws(() => f.bindings.current({ ...f.binding, memberId: 'unknown' }), /hold/);
  assert.equal(f.counts.fileReads, 6); assert.equal(f.counts.parses, 6);
});

test('same-sized changed bytes with restored mtime and malformed history invalidate warm validation', t => {
  const f = fixture(t); f.bindings.current(f.binding);
  const stat = fs.statSync(f.path);
  const changed = structuredClone(f.row); changed.fingerprint = '0'.repeat(64);
  const invalid = f.stringify(changed); assert.equal(invalid.length, f.text.length);
  f.write(invalid); fs.utimesSync(f.path, stat.atime, stat.mtime);
  assert.throws(() => f.bindings.current(f.binding), /hold/);
  f.write(f.text); assert.equal(f.bindings.current(f.binding)!.generation, 1);
  assert.equal(f.counts.validations, 2);
  const corrupt = { ...f.row, restorations: [{}] }; f.write(f.stringify(corrupt));
  assert.throws(() => f.bindings.current(f.binding), /hold/);
  const afterFailure = f.counts.validations;
  f.write(f.text); f.bindings.current(f.binding);
  assert.equal(f.counts.parses, 5); assert.equal(f.counts.validations, afterFailure + 1);
});

test('different valid launch data and exact text formatting are reread without stale selections', t => {
  const f = fixture(t); f.bindings.current(f.binding);
  const changed = structuredClone(f.row); changed.definition.members[0]!.skipped = true;
  changed.fingerprint = runtimeDigest(changed.definition); f.write(f.stringify(changed));
  assert.equal(f.bindings.current(f.binding)!.workAllowed, false);
  f.write(' ' + f.text); assert.equal(f.bindings.current(f.binding)!.workAllowed, true);
  assert.equal(f.counts.parses, 3); assert.equal(f.counts.validations, 3);
});

test('missing, malformed JSON and parse ENOENT preserve old store behavior and discard the warm memo', t => {
  const f = fixture(t); f.bindings.current(f.binding);
  fs.unlinkSync(f.path); assert.equal(f.bindings.current(f.binding), undefined);
  f.write(f.text); f.bindings.current(f.binding); assert.equal(f.counts.parses, 2);
  assert.equal(f.counts.validations, 2);
  f.write('{'); assert.throws(() => f.bindings.current(f.binding), /hold/);
  f.write(f.text); f.bindings.current(f.binding); assert.equal(f.counts.parses, 3);
  assert.equal(f.counts.validations, 3);
  const parse = JSON.parse;
  const missing = t.mock.method(JSON, 'parse', () => { throw Object.assign(new Error('TEST'), { code: 'ENOENT' }); });
  f.write(' ' + f.text); assert.equal(f.bindings.current(f.binding), undefined);
  missing.mock.restore(); assert.equal(JSON.parse, parse);
  f.write(f.text); f.bindings.current(f.binding); assert.equal(f.counts.parses, 4);
  assert.equal(f.counts.validations, 4);
});

test('oversized UTF8 decoder input bypasses reuse without adding a record acceptance limit', t => {
  const f = fixture(t); f.write(' '.repeat(1024 * 1024) + f.text);
  f.bindings.current(f.binding); f.bindings.current(f.binding);
  assert.equal(f.counts.parses, 2); assert.equal(f.counts.validations, 2);
});

test('a mutation of initial runId after the original store read still refuses warm validation', t => {
  const f = fixture(t), read = f.store.read.bind(f.store);
  let change = false;
  const bindings = f.reading(<T>(name: string, decode?: (text: string) => T) => {
    const result = read<T>(name, decode); if (change) f.binding.runId = 'TEST-other-run'; return result;
  });
  bindings.current(f.binding); change = true;
  assert.throws(() => bindings.current(f.binding), /hold/);
  change = false; f.binding.runId = 'TEST-run'; bindings.current(f.binding);
  assert.equal(f.counts.parses, 3); assert.equal(f.counts.validations, 2);
});

test('ignored decoders and foreign returned objects keep original validation without JS-value memo keys', t => {
  const f = fixture(t);
  for (const invoke of [false, true]) {
    let value = structuredClone(f.row);
    const bindings = f.reading(<T>(_name: string, decode?: (text: string) => T) => {
      if (invoke) decode!(f.text); return value as T;
    });
    bindings.current(f.binding);
    const firstValidation = f.counts.validations;
    bindings.current(f.binding); assert.equal(f.counts.validations, firstValidation + 1);
    value.fingerprint = '0'.repeat(64); assert.throws(() => bindings.current(f.binding), /hold/);
    value = structuredClone(f.row);
    Object.defineProperty(value, 'schemaVersion', { get: () => 2 });
    assert.throws(() => bindings.current(f.binding), /hold/);
    value = structuredClone(f.row); value.definition = undefined as unknown as TeamLaunchRecord['definition'];
    assert.throws(() => bindings.current(f.binding), /hold/);
  }
});

test('every decoder invocation has a fresh frozen token and only the last completed token is accepted', t => {
  const f = fixture(t);
  const bindings = f.reading(<T>(_name: string, decode?: (text: string) => T) => {
    const first = decode!(f.text), second = decode!(f.text);
    assert.notEqual(first, second); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(second));
    assert.deepEqual(Object.keys(first as object), []); return first;
  });
  assert.throws(() => bindings.current(f.binding), /hold/);
  const interrupted = f.reading(<T>(_name: string, decode?: (text: string) => T) => {
    const first = decode!(f.text); assert.throws(() => decode!('{')); return first;
  });
  assert.throws(() => interrupted.current(f.binding), /hold/);
  const accepted = f.reading(<T>(_name: string, decode?: (text: string) => T) => {
    decode!(f.text); return decode!(f.text);
  });
  accepted.current(f.binding);
  const before = { ...f.counts }; accepted.current(f.binding);
  assert.equal(f.counts.parses, before.parses + 2); assert.equal(f.counts.validations, before.validations);
});

test('outer throw after a reentrant successful decode clears both provisional and nested entries', t => {
  const f = fixture(t), read = f.store.read.bind(f.store);
  let fail = false, inside = false;
  const bindings = f.reading(<T>(name: string, decode?: (text: string) => T) => {
    const result = read<T>(name, decode);
    if (fail && !inside) {
      inside = true; try { bindings.current(f.binding); } finally { inside = false; }
      throw new Error('TEST-outer-failure');
    }
    return result;
  });
  bindings.current(f.binding); fail = true;
  assert.throws(() => bindings.current(f.binding), /TEST-outer-failure/);
  const afterFailure = { ...f.counts }; fail = false; bindings.current(f.binding);
  assert.equal(f.counts.parses, afterFailure.parses + 1);
  assert.equal(f.counts.validations, afterFailure.validations + 1);
});

test('public projection clone failure propagates unchanged and the next call still reads and parses afresh', t => {
  const f = fixture(t); f.bindings.current(f.binding);
  const failure = new Error('TEST-clone');
  const clone = t.mock.method(globalThis, 'structuredClone', () => { throw failure; });
  assert.throws(() => f.bindings.current(f.binding), error => error === failure); clone.mock.restore();
  assert.equal(f.bindings.current(f.binding)!.binding.generation, 'original-1');
  assert.equal(f.counts.parses, 3); assert.equal(f.counts.fileReads, 3);
});

test('the optional decoder does not change malformed row header error boundaries', t => {
  const f = fixture(t); f.write('null');
  assert.throws(() => f.bindings.current(f.binding), TypeError);
});
