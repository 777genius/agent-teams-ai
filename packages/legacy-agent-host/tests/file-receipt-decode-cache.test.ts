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

test('command: one-entry bound and command/path binding survive warm reads and listing', t => {
  const f = fixture(t, 'command'), other = commandBody('TEST-other');
  f.commands.write(other); f.read();
  assert.deepEqual(f.commands.read(other.commandId), other);
  const parse = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof parse>) => { parses++; return parse(...args) as unknown; });
  assert.deepEqual(f.read(), f.body);
  assert.ok(parses > 0, 'reading a different receipt evicted the first decode');
  writeFileSync(f.path, JSON.stringify({ ...other, digest: managementDigest(other) }));
  assert.throws(f.read, { code: 'held' });
  assert.throws(() => [...f.commands.list()], { code: 'held' });
});
