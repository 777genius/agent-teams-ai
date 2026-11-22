import assert from 'node:assert/strict';
import fs, { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileRuntimeSourceIndex } from '../dist/adapters/profile/FileRuntimeSourceIndex.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { managementDigest } from '../dist/management/identity.js';
import { storedManagementCommandSchema } from '../dist/management/commandRecords.js';
import type { TestContext } from 'node:test';
import type { StoredRuntimeSourceCommand } from '../dist/management/commandRecords.js';

function sourceBody(root: string, commandId = 'TEST-source') {
  const selection = { previousRevision: 'a'.repeat(64), commandId, grant: {
    targetId: 'b'.repeat(64), ownerId: 'TEST-owner', ownerRevision: 'TEST-revision',
    contextId: 'TEST-context', projectPath: root, runtimeId: 'codex' as const,
    profileId: 'TEST-profile', configRevision: 'TEST-config', teamScopes: [],
  }, candidate: { sourceKind: 'captured' as const,
    executable: { path: join(root, 'TEST-never-executed'), sha256: 'c'.repeat(64) } } };
  const record = { ...selection, revision: runtimeDigest(selection) };
  return { schemaVersion: 1 as const, records: [record], current: [{
    sourceId: selection.grant.targetId, revision: record.revision, commandId,
  }] };
}

function commandBody(commandId = 'TEST-command'): StoredRuntimeSourceCommand {
  return { schemaVersion: 1, kind: 'runtime.source', commandId,
    profileId: 'TEST-profile', configRevision: 'TEST-config', providerId: 'codex',
    fingerprint: 'a'.repeat(64), selectionDigest: 'b'.repeat(64), resourceId: 'c'.repeat(64),
    sourceId: 'c'.repeat(64), revision: 'd'.repeat(64), expectedRevision: 'b'.repeat(64),
    resourceHeld: false, phase: 'prepared', publicationJson: '{}' };
}

function fixture(t: TestContext, kind: 'source' | 'command') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-receipt-decode-')));
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); });
  let current = true;
  const index = new FileRuntimeSourceIndex(root, () => { if (!current) throw new Error('TEST-revoked'); });
  const commands = new FileManagementCommandStore(root);
  const body = kind === 'source' ? sourceBody(root) : commandBody();
  const digest = kind === 'source' ? runtimeDigest : managementDigest;
  const path = join(root, kind === 'source' ? 'runtime-sources/index.json'
    : 'management-commands/' + managementDigest('TEST-command') + '.json');
  writeFileSync(path, JSON.stringify({ ...body, digest: digest(body) }), { mode: 0o600 });
  const read = (): unknown => kind === 'source' ? index.read() : commands.read('TEST-command');
  return { root, path, body, read, index, commands, revoke: () => { current = false; } };
}

for (const kind of ['source', 'command'] as const) {
  test(kind + ': equal fresh bytes reuse decoding, with fresh physical reads and isolated return values', t => {
    const f = fixture(t, kind), parse = JSON.parse, open = fs.openSync, close = fs.closeSync;
    let parses = 0, opens = 0, closes = 0;
    t.mock.method(JSON, 'parse', (...args: Parameters<typeof parse>) => { parses++; return parse(...args) as unknown; });
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => { opens++; return open(...args); });
    t.mock.method(fs, 'closeSync', (...args: Parameters<typeof close>) => { closes++; return close(...args); });
    syncBuiltinESMExports();
    const first = f.read();
    assert.deepEqual(first, f.body);
    const initialParses = parses, initialOpens = opens, initialCloses = closes;
    assert.ok(initialParses > 0);
    assert.ok(initialOpens > 0);
    const changed = first as { records?: { grant: { ownerId: string } }[]; publicationJson?: string };
    if (changed.records) changed.records[0]!.grant.ownerId = 'TEST-caller-mutation';
    else changed.publicationJson = 'TEST-caller-mutation';
    assert.deepEqual(f.read(), f.body);
    assert.equal(parses, initialParses, 'only pure decoding is reused');
    assert.equal(opens, initialOpens * 2, 'second read still opens the original path');
    assert.equal(closes, initialCloses * 2, 'second read still closes the original descriptor');
  });

  test(kind + ': a warm decode cannot conceal changed bytes, invalid UTF-8, or rollback after refusal', t => {
    const f = fixture(t, kind), original = readFileSync(f.path);
    assert.deepEqual(f.read(), f.body);
    for (const bytes of [Buffer.from('{}'), Buffer.from([0xff, 0xfe]),
      Buffer.from(original.toString().replace('TEST-profile', 'TEST-foreign'))]) {
      writeFileSync(f.path, bytes);
      assert.throws(f.read, { code: 'held' });
      writeFileSync(f.path, original);
      assert.deepEqual(f.read(), f.body, 'restored bytes are read and validated again');
    }
  });

  test(kind + ': a warm decode cannot conceal private-mode revocation', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t, kind);
    f.read(); chmodSync(f.path, 0o644);
    assert.throws(f.read, { code: 'held' });
    chmodSync(f.path, 0o600);
    assert.deepEqual(f.read(), f.body);
  });

  test(kind + ': identical bytes substituted at the original open boundary remain held', t => {
    const f = fixture(t, kind), original = readFileSync(f.path), open = fs.openSync;
    f.read();
    let armed = true;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => {
      if (armed && args[0] === f.path) {
        armed = false;
        renameSync(f.path, f.path + '.old');
        writeFileSync(f.path, original, { mode: 0o600 });
      }
      return open(...args);
    });
    syncBuiltinESMExports();
    assert.throws(f.read, { code: 'held' });
    assert.equal(armed, false);
  });

  test(kind + ': a failed close preserves the failure and evicts the warmed decode', t => {
    const f = fixture(t, kind), close = fs.closeSync;
    f.read();
    t.mock.method(fs, 'closeSync', (...args: Parameters<typeof close>) => {
      close(...args); throw new Error('TEST-close-failure');
    });
    syncBuiltinESMExports();
    assert.throws(f.read, kind === 'source' ? /TEST-close-failure/ : { code: 'held' });
    t.mock.restoreAll(); syncBuiltinESMExports();
    const parse = JSON.parse;
    let parses = 0;
    t.mock.method(JSON, 'parse', (...args: Parameters<typeof parse>) => { parses++; return parse(...args) as unknown; });
    assert.deepEqual(f.read(), f.body);
    assert.ok(parses > 0, 'failed read supplied no reusable decode');
  });
}

test('source: valid replacement remains held after the first read failed only at close', t => {
  const f = fixture(t, 'source'), close = fs.closeSync;
  t.mock.method(fs, 'closeSync', (...args: Parameters<typeof close>) => {
    close(...args); throw new Error('TEST-close-failure');
  });
  syncBuiltinESMExports();
  assert.throws(f.read, /TEST-close-failure/);
  t.mock.restoreAll(); syncBuiltinESMExports();
  const replacement = sourceBody(f.root, 'TEST-different-valid-source');
  writeFileSync(f.path, JSON.stringify({ ...replacement, digest: runtimeDigest(replacement) }));
  assert.throws(f.read, { code: 'held' }, 'the original observedDigest assignment precedes close');
  assert.deepEqual(new FileRuntimeSourceIndex(f.root, () => {}, true).read(), replacement,
    'replacement is independently valid but cannot replace the original observation');
});

function commandPair(t: TestContext) {
  const f = fixture(t, 'command'), directory = join(f.root, 'management-commands');
  const save = (body: StoredRuntimeSourceCommand) => {
    const path = join(directory, managementDigest(body.commandId) + '.json');
    const bytes = JSON.stringify({ ...body, digest: managementDigest(body) });
    writeFileSync(path, bytes, { mode: 0o600 });
    return { body, path, bytes };
  };
  const entries = [save(commandBody()), save(commandBody('TEST-second'))];
  return { ...f, directory, entries, save, readAt: (index: number) => f.commands.read(entries[index]!.body.commandId) };
}

function countCommandDecodes(t: TestContext): () => number {
  const parse = storedManagementCommandSchema.parse;
  let count = 0;
  t.mock.method(storedManagementCommandSchema, 'parse', (...args: Parameters<typeof parse>) => {
    count++; return parse(...args);
  });
  return () => count;
}

test('command: two alternating receipts retain two pure decodes through 132 fresh reads', t => {
  const f = commandPair(t), decodes = countCommandDecodes(t);
  const open = fs.openSync, close = fs.closeSync, read = fs.readSync;
  let opens = 0, closes = 0, physicalReads = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => { opens++; return open(...args); });
  t.mock.method(fs, 'closeSync', (...args: Parameters<typeof close>) => { closes++; return close(...args); });
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof read>) => {
    const count = read(...args); if (count > 0) physicalReads++; return count;
  });
  syncBuiltinESMExports();
  for (let iteration = 0; iteration < 12; iteration++) {
    for (const index of [0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1]) {
      const value = f.readAt(index);
      assert.deepEqual(value, f.entries[index]!.body);
      if (value?.kind !== 'runtime.source') assert.fail('original source receipt');
      value.publicationJson = 'TEST-caller-mutation';
    }
  }
  assert.equal(decodes(), 2);
  assert.equal(opens, 132); assert.equal(closes, 132); assert.equal(physicalReads, 132);
});

for (const stage of ['missing', 'utf8', 'digest', 'schema', 'mode', 'open-replacement',
  'close', 'directory-replacement', 'directory-missing', 'command-id', 'list-name', 'list-command-id'] as const) {
  test('command: ' + stage + ' failure evicts both warmed decodes',
    { skip: stage === 'mode' && process.platform === 'win32' }, t => {
      const f = commandPair(t), original = f.entries[0]!;
      f.readAt(0); f.readAt(1);
      let restore = () => { writeFileSync(original.path, original.bytes); chmodSync(original.path, 0o600); };
      if (stage === 'missing') rmSync(original.path);
      else if (stage === 'utf8') writeFileSync(original.path, Buffer.from([0xff]));
      else if (stage === 'digest') writeFileSync(original.path, original.bytes.replace('TEST-profile', 'TEST-foreign'));
      else if (stage === 'schema') {
        const body = { ...original.body, phase: 'TEST-invalid' };
        writeFileSync(original.path, JSON.stringify({ ...body, digest: managementDigest(body) }));
      } else if (stage === 'mode') chmodSync(original.path, 0o644);
      else if (stage === 'command-id' || stage === 'list-command-id')
        writeFileSync(original.path, f.entries[1]!.bytes);
      else if (stage === 'list-name') {
        const path = join(f.directory, 'TEST-unrecognized'); writeFileSync(path, '{}');
        restore = () => rmSync(path);
      } else if (stage === 'directory-replacement' || stage === 'directory-missing') {
        renameSync(f.directory, f.directory + '.old');
        if (stage === 'directory-replacement') fs.mkdirSync(f.directory);
        restore = () => {
          rmSync(f.directory, { recursive: true, force: true }); renameSync(f.directory + '.old', f.directory);
        };
      } else if (stage === 'open-replacement') {
        const open = fs.openSync; let armed = true;
        t.mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => {
          if (armed && args[0] === original.path) {
            armed = false; renameSync(original.path, original.path + '.old');
            writeFileSync(original.path, original.bytes, { mode: 0o600 });
          }
          return open(...args);
        });
      } else {
        const close = fs.closeSync;
        t.mock.method(fs, 'closeSync', (...args: Parameters<typeof close>) => {
          close(...args); throw new Error('TEST-close-failure');
        });
      }
      syncBuiltinESMExports();
      try {
        if (stage === 'missing') assert.equal(f.readAt(0), undefined);
        else assert.throws(() => stage.startsWith('list-') ? [...f.commands.list()] : f.readAt(0),
          { code: stage === 'directory-missing' ? 'ENOENT' : 'held' });
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); restore(); }
      const decodes = countCommandDecodes(t);
      assert.deepEqual(f.readAt(0), f.entries[0]!.body);
      assert.deepEqual(f.readAt(1), f.entries[1]!.body);
      assert.equal(decodes(), 2, 'neither previously warmed receipt survives a failed read');
    });
}

test('command: valid changed bytes replace only their decode and third receipt evicts the least recent', t => {
  const f = commandPair(t), decodes = countCommandDecodes(t);
  f.readAt(0); f.readAt(1);
  const changed = f.save({ ...f.entries[0]!.body, publicationJson: '{"TEST":"changed"}' });
  assert.deepEqual(f.readAt(0), changed.body);
  assert.deepEqual(f.readAt(1), f.entries[1]!.body);
  assert.equal(decodes(), 3, 'fresh changed bytes decode again; the other receipt remains reusable');
  f.readAt(0);
  const third = f.save(commandBody('TEST-third'));
  f.commands.read(third.body.commandId); f.readAt(0);
  assert.equal(decodes(), 4, 'the more recently used first receipt survives');
  f.readAt(1);
  assert.equal(decodes(), 5, 'the least recently used second receipt was evicted');
  f.commands.read(third.body.commandId);
  assert.equal(decodes(), 6, 'the memo cannot retain three receipts');
});

test('command: two decodes cannot exceed the original total receipt byte budget', t => {
  const f = commandPair(t), decodes = countCommandDecodes(t), budget = 4 * 1024 * 1024 + 64 * 1024;
  const large = f.entries.map(entry => f.save({ ...entry.body,
    publicationJson: JSON.stringify({ TEST: '"'.repeat(600_000) }) }));
  assert.ok(large.every(entry => Buffer.byteLength(entry.bytes) < budget));
  assert.ok(large.reduce((sum, entry) => sum + Buffer.byteLength(entry.bytes), 0) > budget);
  for (const index of [0, 1, 0]) assert.deepEqual(f.readAt(index), large[index]!.body);
  assert.equal(decodes(), 3, 'the older valid decode is evicted to preserve the combined byte limit');
});

test('source: every hit still checks the original writer', t => {
  const f = fixture(t, 'source');
  f.read(); f.revoke();
  assert.throws(f.read, /TEST-revoked/);
});

test('source: a cached predecessor cannot roll back a successfully published revision', t => {
  const f = fixture(t, 'source'), original = readFileSync(f.path);
  const before = f.index.read();
  const { revision: _revision, ...selection } = sourceBody(f.root, 'TEST-next-source').records[0]!;
  selection.previousRevision = before.records[0]!.revision;
  f.index.publish({ revision: runtimeDigest(selection), ...selection }, 'a'.repeat(64));
  // publish's final read warmed A, but its original observedDigest now pins B.
  writeFileSync(f.path, original);
  assert.throws(f.read, { code: 'held' });
  assert.deepEqual(new FileRuntimeSourceIndex(f.root, () => {}, true).read(), before,
    'A is valid in isolation, but the original reader has already observed B');
});

test('command: two-entry reuse and command/path binding survive warm reads and listing', t => {
  const f = fixture(t, 'command'), other = commandBody('TEST-other');
  f.commands.write(other); f.read();
  assert.deepEqual(f.commands.read(other.commandId), other);
  const parse = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof parse>) => { parses++; return parse(...args) as unknown; });
  assert.deepEqual(f.read(), f.body);
  assert.equal(parses, 0, 'reading a second receipt retains the first pure decode');
  writeFileSync(f.path, JSON.stringify({ ...other, digest: managementDigest(other) }));
  assert.throws(f.read, { code: 'held' });
  assert.throws(() => [...f.commands.list()], { code: 'held' });
});
