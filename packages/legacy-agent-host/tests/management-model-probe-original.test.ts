import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';

import type { TestContext } from 'node:test';
import type { ManagementCommandStore, NativeLocalReadinessEvidence, StoredModelProbe } from '../dist/management/commandRecords.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const input = {
  commandId: 'TEST-original-model-probe', profileId: 'TEST-profile', configRevision: 'TEST-config',
  providerId: 'TEST-provider', modelId: 'TEST-model', context: 'd'.repeat(64),
};
const target = {
  profileId: input.profileId, configRevision: input.configRevision,
  selectionDigest: 'a'.repeat(64), resourceId: 'b'.repeat(64),
};
const evidence: NativeLocalReadinessEvidence = {
  schemaVersion: 1, ordinary: 'confirmed', coordination: 'compatible', decision: 'allow', reasons: [],
  routeDigest: '1'.repeat(64), configurationDigest: '2'.repeat(64), accountDigest: '3'.repeat(64),
  metadata: {
    provider: 'custom', tools: true, modelListed: true, contextTokens: null,
    parameterCount: null, configuredContextTokens: null, trainedContextTokens: null,
    contextSource: 'unknown',
  },
};

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-probe-original-')));
  const base = new FileManagementCommandStore(root);
  let ownWrites = 0, runs = 0, closes = 0, evidenceReads = 0, refuseRead = false;
  const store: ManagementCommandStore = {
    read: (commandId) => {
      if (refuseRead) throw new Error('TEST original receipt read unavailable');
      return base.read(commandId);
    },
    list: () => base.list(),
    write: (record) => { ownWrites++; base.write(record); },
  };
  const fence = new ManagementResourceFence(store.list());
  const result = deferred<boolean>(), closed = deferred<boolean>(), closeStarted = deferred<void>();
  const owner = new ModelProbeOwner({
    store, fence, assertWriter: () => {}, select: () => ({ ...target }),
    prepare: () => ({
      timeoutMs: 30_000,
      run: async () => { runs++; return result.promise; },
      readiness: () => { evidenceReads++; return structuredClone(evidence); },
      close: async () => { closes++; closeStarted.resolve(); return closed.promise; },
    }),
  });
  t.after(async () => {
    result.resolve(false); closed.resolve(true);
    await owner.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const read = (): StoredModelProbe => {
    const saved = base.read(input.commandId);
    assert.ok(saved && saved.kind === 'model.probe');
    return saved;
  };
  const file = () => {
    const names = readdirSync(join(root, 'management-commands'));
    assert.equal(names.length, 1);
    return join(root, 'management-commands', names[0]!);
  };
  const bytes = () => {
    const names = readdirSync(join(root, 'management-commands'));
    return names.map((name) => [name, readFileSync(join(root, 'management-commands', name), 'utf8')]);
  };
  return { base, owner, fence, result, closed, closeStarted, read, file, bytes,
    setReadRefusal: (value: boolean) => { refuseRead = value; },
    counts: () => ({ ownWrites, runs, closes, evidenceReads }) };
}

const changes: readonly {
  name: string; replace?: (original: StoredModelProbe) => StoredModelProbe;
}[] = [
  { name: 'changed original expiry', replace: (saved) => ({ ...saved, expiresAt: saved.expiresAt + 1_000 }) },
  { name: 'changed original context', replace: (saved) => ({ ...saved, context: 'e'.repeat(64) }) },
  { name: 'changed original resource', replace: (saved) => ({ ...saved, resourceId: 'f'.repeat(64) }) },
  { name: 'missing original' },
];

for (const boundary of ['native result', 'native close'] as const) {
  for (const change of changes) {
    test(`model probe retains ${change.name} after awaited ${boundary} and holds original custody`, async (t) => {
      const f = fixture(t);
      f.owner.startNativeReadiness(input, () => true);
      const original = f.read();
      assert.equal(f.counts().runs, 1);
      if (boundary === 'native close') {
        f.result.resolve(true);
        await f.closeStarted.promise;
      }
      if (change.replace) {
        const replacement = change.replace(original);
        assert.equal(replacement.fingerprint, original.fingerprint, 'the request fingerprint alone cannot bind this original');
        f.base.write(replacement);
      } else unlinkSync(f.file());
      const retained = f.bytes();
      if (boundary === 'native result') {
        f.result.resolve(true);
        await f.closeStarted.promise;
      }
      f.closed.resolve(true);
      const failure = await f.owner.close().then(() => undefined, (error: unknown) => error);
      assert.deepEqual(f.bytes(), retained, 'late completion must neither overwrite a replacement nor recreate a missing receipt');
      assert.ok(failure && typeof failure === 'object' && 'code' in failure && failure.code === 'held');
      assert.equal(f.counts().ownWrites, 1, 'only the original running claim is published');
      assert.equal(f.counts().runs, 1);
      assert.equal(f.counts().closes, 1, 'the original native owner is still closed once');
      assert.equal(f.counts().evidenceReads, boundary === 'native result' ? 0 : 1);
      assert.throws(() => f.fence.reserve(target.resourceId, 'TEST-next-probe'), { code: 'held' });
    });
  }
}

for (const cause of ['replacement', 'read failure'] as const) {
  test(`model probe keeps observed original ${cause} uncertainty when the original reappears during cleanup`, async (t) => {
    const f = fixture(t);
    f.owner.startNativeReadiness(input, () => true);
    const original = f.read();
    if (cause === 'replacement') f.base.write({ ...original, context: 'e'.repeat(64) });
    else f.setReadRefusal(true);
    f.result.resolve(true);
    await f.closeStarted.promise;
    if (cause === 'replacement') f.base.write(original);
    else f.setReadRefusal(false);
    const retained = f.bytes();
    f.closed.resolve(true);
    const failure = await f.owner.close().then(() => undefined, (error: unknown) => error);
    assert.deepEqual(f.bytes(), retained, 'restoring exact bytes cannot grant a late publication');
    assert.ok(failure && typeof failure === 'object' && 'code' in failure && failure.code === 'held');
    assert.deepEqual(f.counts(), { ownWrites: 1, runs: 1, closes: 1, evidenceReads: 0 });
    assert.throws(() => f.fence.reserve(target.resourceId, 'TEST-next-probe'), { code: 'held' });
  });
}

test('unchanged model probe still publishes confirmed evidence after the original native close', async (t) => {
  const f = fixture(t);
  f.owner.startNativeReadiness(input, () => true);
  const original = f.read();
  f.result.resolve(true);
  await f.closeStarted.promise;
  assert.deepEqual(f.read(), original, 'running original remains durable until physical close');
  f.closed.resolve(true);
  await f.owner.close();
  const completed = f.read();
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.ok, true);
  assert.equal(completed.resourceHeld, false);
  assert.deepEqual(completed.readiness?.evidence, evidence);
  assert.equal(completed.fingerprint, original.fingerprint);
  assert.equal(completed.expiresAt, original.expiresAt);
  assert.deepEqual(f.counts(), { ownWrites: 2, runs: 1, closes: 1, evidenceReads: 1 });
  f.fence.reserve(target.resourceId, 'TEST-next-probe');
  f.fence.release(target.resourceId, 'TEST-next-probe', true);
});

test('original owner cancellation may retire its own receipt while native completion is pending', async (t) => {
  const f = fixture(t);
  f.owner.startNativeReadiness(input, () => true);
  const cancellation = f.owner.cancelRetained(input.commandId, input.context);
  await f.closeStarted.promise;
  assert.equal(f.read().readinessRetired, true);
  f.result.resolve(true); f.closed.resolve(true);
  await cancellation;
  await f.owner.close();
  const saved = f.read();
  assert.equal(saved.phase, 'cancelled');
  assert.equal(saved.ok, false);
  assert.equal(saved.resourceHeld, false);
  assert.equal(saved.readinessRetired, true);
  assert.equal(saved.readiness, undefined);
  assert.deepEqual(f.counts(), { ownWrites: 3, runs: 1, closes: 1, evidenceReads: 0 });
  f.fence.reserve(target.resourceId, 'TEST-next-probe');
  f.fence.release(target.resourceId, 'TEST-next-probe', true);
});
