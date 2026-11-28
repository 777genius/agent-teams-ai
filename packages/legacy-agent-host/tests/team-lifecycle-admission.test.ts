import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { digest } from '../dist/team/identity.js';
import { teamExecutionAllowed } from '../dist/team/teamLifecycleAdmission.js';
import type { TeamLifecycleReceipt } from '../dist/team/lifecycleContracts.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { TeamStore } from '../dist/team/ports.js';

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'TEST-lifecycle-admission-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-admission' };
  const store = new TeamOwnerStore(root, binding.teamName);
  createFilesystemTeamOwner({
    root, binding, store,
    members: [{ memberId: 'TEST-lead', name: 'lead', role: 'lead' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'admin'] }],
  });
  const state = () => store.read<OwnerState>('state.json')!;
  const allowed = () => store.fenced(() => teamExecutionAllowed(state(), store));
  const commands = join(store.directory, 'commands');
  const writeRaw = (name: string, text: string) => {
    fs.mkdirSync(commands, { recursive: true });
    const path = join(commands, name + '.json');
    fs.writeFileSync(path, text);
    return path;
  };
  const receipt = (phase: TeamLifecycleReceipt['phase'] = 'completed'): TeamLifecycleReceipt => {
    const commandId = 'TEST-cleanup', createdAt = '2026-11-28T00:00:00.000Z';
    return {
      schemaVersion: 1, family: 'lifecycle', binding, commandId, principalId: 'human',
      fingerprint: digest({ binding, principalId: 'human', input: {
        commandId, operation: 'trash', expectedRevision: digest(null),
      } }),
      captureDigest: digest({ intents: [], runtimeBindings: [] }),
      authorityRevision: 1, operation: 'trash', createdAt, phase, before: null,
      after: { deletedAt: createdAt, cleanupCommandId: commandId, cleanupPending: true },
      targets: [], runtimeBindings: [],
    };
  };
  return { root, binding, store, state, allowed, commands, writeRaw, receipt };
}

test('fresh decoded listings retain false results and read every current JSON file', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.listDecoded('commands', () => false), []);
  assert.equal(f.allowed(), true, 'an absent command directory has no cleanup debt');
  f.writeRaw('a', '{"id":"a"}');
  f.writeRaw('b', '{"id":"b"}');
  const read = (): string[] => {
    const observed: string[] = [];
    assert.deepEqual(f.store.listDecoded('commands', bytes => {
      observed.push(JSON.parse(Buffer.from(bytes).toString('utf8')).id);
      return false;
    }), [false, false]);
    return observed.sort();
  };
  assert.deepEqual(read(), ['a', 'b']);
  f.writeRaw('b', '{"id":"changed"}');
  assert.deepEqual(read(), ['a', 'changed'], 'each listing reads the new bytes');
});

test('receipt rewrites with the same inode, size and mtime cannot reuse old permission', t => {
  const f = fixture(t);
  const complete = JSON.stringify(f.receipt()).padEnd(1024, ' ');
  const pending = JSON.stringify(f.receipt('prepared')).padEnd(1024, ' ');
  assert.equal(Buffer.byteLength(complete), Buffer.byteLength(pending));
  const path = f.writeRaw('original', complete);
  fs.utimesSync(path, 1_700_000_000, 1_700_000_000);
  const before = fs.statSync(path);
  assert.equal(f.allowed(), true);
  assert.equal(f.allowed(), true);
  fs.writeFileSync(path, pending);
  fs.utimesSync(path, 1_700_000_000, 1_700_000_000);
  const after = fs.statSync(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(f.allowed(), false, 'fresh prepared cleanup receipt blocks execution');
  fs.writeFileSync(path, complete);
  fs.utimesSync(path, 1_700_000_000, 1_700_000_000);
  assert.equal(f.allowed(), true, 'fresh completed bytes are independently admissible');
});

test('each guard observes added and removed pending receipts', t => {
  const f = fixture(t);
  f.writeRaw('ordinary', '{"family":"work-sync","phase":"completed"}');
  assert.equal(f.allowed(), true);
  const pending = f.writeRaw('late-cleanup', JSON.stringify(f.receipt('held')));
  assert.equal(f.allowed(), false);
  fs.unlinkSync(pending);
  assert.equal(f.allowed(), true, 'removed receipt classifications cannot invent current debt');
});

test('a warm receipt classification never substitutes for current lifecycle state', t => {
  const f = fixture(t);
  f.writeRaw('original', JSON.stringify(f.receipt()));
  assert.equal(f.allowed(), true);
  for (const [lifecycle, allowed] of [
    [{ cleanupCommandId: 'TEST-cleanup', cleanupPending: true }, false],
    [{ cleanupCommandId: 'TEST-cleanup', cleanupPending: false }, true],
    [{ cleanupCommandId: 'TEST-cleanup', cleanupPending: false, deletedAt: 'TEST-deleted' }, false],
    [{ cleanupCommandId: '', cleanupPending: false }, false],
  ] as const) {
    f.store.write('state.json', { ...f.state(), lifecycle });
    assert.equal(f.allowed(), allowed);
  }
});

test('malformed, falsy and invalid lifecycle receipts remain closed after a warm read', t => {
  const f = fixture(t);
  for (const invalid of ['{', 'false', 'null', '0', '""', '{"family":"lifecycle","phase":"completed"}',
    JSON.stringify({ ...f.receipt(), captureDigest: '0'.repeat(64) })]) {
    f.writeRaw('original', '{"family":"work-sync","phase":"completed"}');
    assert.equal(f.allowed(), true);
    f.writeRaw('original', invalid);
    assert.equal(f.allowed(), false, invalid);
  }
  // Classification still ignores truthy non-lifecycle JSON as the original list path did.
  for (const ordinary of ['true', '1', '"retained"', '[]', '{}']) {
    f.writeRaw('original', ordinary);
    assert.equal(f.allowed(), true, ordinary);
  }
});

for (const replacement of ['missing', 'unreadable'] as const) {
  test(`an enumerated receipt becoming ${replacement} cannot mean an empty command directory`, t => {
    const f = fixture(t), path = f.writeRaw('original', JSON.stringify(f.receipt()));
    assert.equal(f.allowed(), true);
    const original = fs.readdirSync;
    let changed = false;
    const interleave = t.mock.method(fs, 'readdirSync', ((target: fs.PathLike, options?: unknown) => {
      const names = Reflect.apply(original, fs, [target, options]);
      // Namespace validation already ran; change the actual file after this listing's enumeration.
      if (!changed && String(target) === f.commands && options === undefined) {
        changed = true;
        fs.unlinkSync(path);
        if (replacement === 'unreadable') fs.mkdirSync(path);
      }
      return names;
    }) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    try {
      assert.equal(f.allowed(), false);
      assert.equal(changed, true);
    } finally {
      interleave.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test('digest collisions cannot reuse classification for different freshly read bytes', t => {
  const f = fixture(t);
  const original = crypto.createHash;
  const collision = t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
    const hash = original(...args);
    let raw = false;
    const wrapped: crypto.Hash = new Proxy(hash, {
      get(target, key) {
        if (key === 'update') return (...input: unknown[]) => {
          raw ||= ArrayBuffer.isView(input[0]);
          Reflect.apply(target.update, target, input);
          return wrapped;
        };
        if (key === 'digest') return (...input: unknown[]) => {
          // Only the raw-byte lookup collides; canonical text-based identity hashes remain real.
          if (raw && input[0] === 'hex') return '0'.repeat(64);
          return Reflect.apply(target.digest, target, input);
        };
        return Reflect.get(target, key, target);
      },
    });
    return wrapped;
  });
  syncBuiltinESMExports();
  try {
    f.writeRaw('original', JSON.stringify(f.receipt()));
    assert.equal(f.allowed(), true);
    f.writeRaw('original', JSON.stringify(f.receipt('prepared')));
    assert.equal(f.allowed(), false, 'equal digest cannot authorize different bytes');
    f.writeRaw('original', JSON.stringify(f.receipt()));
    assert.equal(f.allowed(), true);
    f.writeRaw('original', 'false');
    assert.equal(f.allowed(), false, 'invalid JSON value cannot inherit a cached result');
  } finally {
    collision.mock.restore();
    syncBuiltinESMExports();
  }
});

test('receipt size above the retention budget does not impose a new admission limit', t => {
  const f = fixture(t);
  const padding = ' '.repeat(8 * 1024 * 1024);
  f.writeRaw('large', '{"family":"work-sync","phase":"completed"}' + padding);
  assert.equal(f.allowed(), true);
  assert.equal(f.allowed(), true);
  f.writeRaw('large', 'false' + padding);
  assert.equal(f.allowed(), false);
});

test('stores without fresh decoded listings retain the original list fallback', t => {
  const f = fixture(t);
  const legacy: TeamStore = {
    fenced: f.store.fenced.bind(f.store), read: f.store.read.bind(f.store),
    write: f.store.write.bind(f.store), list: f.store.list.bind(f.store),
    productFingerprint: f.store.productFingerprint.bind(f.store),
  };
  f.writeRaw('original', JSON.stringify(f.receipt()));
  assert.equal(teamExecutionAllowed(f.state(), legacy), true);
  f.writeRaw('original', JSON.stringify(f.receipt('prepared')));
  assert.equal(teamExecutionAllowed(f.state(), legacy), false);
  f.writeRaw('original', 'null');
  assert.equal(teamExecutionAllowed(f.state(), legacy), false);
});
