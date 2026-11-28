import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readOpenCodeV2CheckpointSessionId } from '@agent-teams/provider-implementations/opencode';
import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import {
  captureOpenCodeV2EmbeddedCheckpoint,
  createOpenCodeV2EmbeddedMemberProvider,
  prepareOpenCodeV2EmbeddedCheckpoint,
} from '../dist/adapters/providers/OpenCodeV2EmbeddedMemberProvider.js';
import {
  AcceptedOpenCodeV2FileKey,
  createOpenCodeV2FileMaterialization,
  openCodeV2SelectedSourceReference,
  selectedFilePaths,
} from '../dist/adapters/providers/OpenCodeV2SelectedFileKey.js';
import { FileCheckpointStorage } from '../dist/adapters/runtime/FileCheckpointStorage.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { CheckpointCoordinator } from '../dist/runtime/CheckpointCoordinator.js';
import {
  checkpointFingerprint,
  checkpointJson,
  checkpointPayloadDigest,
} from '../dist/runtime/checkpointIdentity.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { emptySession, historyDigest } from '../dist/runtime/sessionState.js';
import { opencodeV2ModelProbeProfile } from './fixtures/opencode-v2-model-probe-profile.ts';
import type { MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { CheckpointPayload } from '../dist/runtime/checkpointContracts.js';
import type { RuntimeSessionRecord } from '../dist/runtime/contracts.js';

// Saved from the unchanged driver's TEST fixture before Family B. This is a
// real pinned checkpoint vector, not qualification of an installed native engine.
const legacyCheckpoint = {
  version: 1,
  engine: 'opencode-v2',
  nativeSessionId: 'ses_TESTowned',
  compatibility: '772f246ae4fb87d63d3da2d9b48448fcdc9166455519b56b5c21ea02b8ae2477',
};
const policy = {
  kind: 'protected',
  key: { version: 1, salt: '1'.repeat(32) },
  files: { version: 1, salt: '2'.repeat(32) },
} as const;

function sourceFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-embedded-checkpoint-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'TEST-selected.key'),
    key = 'TEST-original-file-key';
  writeFileSync(file, key, { mode: 0o600 });
  writeFileSync(
    join(root, 'opencode.json'),
    JSON.stringify({
      provider: { 'TEST-provider': { options: { apiKey: `{file:${file}}` } } },
    }),
    { mode: 0o600 }
  );
  const profile = runtimeMemberProfileSchema.parse(opencodeV2ModelProbeProfile(root));
  assert.ok(profile.provider === 'opencode' && profile.embedded);
  profile.embedded.configurationSource = captureOpenCodeConfigurationSource(profile).reference;
  let current = true,
    checks = 0;
  const isCurrent = () => {
    checks++;
    return current;
  };
  const captured = captureOpenCodeV2Configuration(
    profile,
    { providerId: 'TEST-provider', modelId: 'TEST-model' },
    isCurrent
  );
  const source = captured.selectedFile;
  assert.ok(source);
  const check = () => {
    assert.equal(current, true, 'original selected TEST source remains current');
  };
  async function issue() {
    assert.ok(source, 'the captured original selected-file source must exist');
    const material = createOpenCodeV2FileMaterialization(source.descriptor, check, policy);
    const value = selectedFilePaths(source.descriptor)
      .map((path) => material.readFileString(path).trim())
      .join('');
    assert.equal(value, key);
    material.materializedKey(value);
    const issuer = {
      nonce: '4'.repeat(64),
      pid: process.pid,
      integrationId: 'TEST-provider',
      reference: openCodeV2SelectedSourceReference(
        source.descriptor,
        '4'.repeat(64),
        'TEST-provider',
        'fresh'
      ),
    };
    const password = Buffer.alloc(32, 7).toString('base64url'),
      request = { method: 'POST' as const, deadline: Date.now() + 30000 };
    await material.prepareIssue(value, issuer, request, password);
    return AcceptedOpenCodeV2FileKey.accept(
      source,
      material.issue(value, issuer),
      issuer,
      isCurrent,
      { policy, password, request }
    );
  }
  return {
    root,
    file,
    key,
    profile,
    source,
    issue,
    check,
    checks: () => checks,
    revoke: () => {
      current = false;
    },
    isCurrent,
  };
}

function capture(f: ReturnType<typeof sourceFixture>, proof: AcceptedOpenCodeV2FileKey) {
  const result = captureOpenCodeV2EmbeddedCheckpoint({
    result: { ok: true, value: legacyCheckpoint },
    source: f.source,
    proof,
    nativeSessionId: legacyCheckpoint.nativeSessionId,
    scopeDigest: proof.scopeDigest,
  });
  assert.ok(result.ok, 'the accepted original selected-file session must capture');
  return checkpointJson(result.value);
}

function originalCheckpoint(
  f: ReturnType<typeof sourceFixture>,
  opaque: CheckpointPayload['opaque']
) {
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId: 'TEST-member',
    generation: 'TEST-source',
  };
  const config = {
    tenantId: 'TEST-tenant',
    projectId: 'TEST-project',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-revision',
    requiredCapabilities: ['text'],
  };
  const source = emptySession(binding, 'TEST-profile', 'TEST-old-host');
  Object.assign(source, {
    config,
    phase: 'closed',
    custody: 'released',
    sessionRef: 'TEST-native-source',
    sealed: true,
  });
  const checkpointId = 'TEST-checkpoint',
    reference = `cp1-${runtimeDigest({ binding, checkpointId })}`;
  const body: Omit<CheckpointPayload, 'digest'> = {
    schemaVersion: 1,
    reference,
    checkpointId,
    fingerprint: checkpointFingerprint(binding, 'TEST-profile', config, checkpointId),
    sourceBinding: binding,
    profileId: 'TEST-profile',
    sourceConfig: config,
    sourceSessionRef: source.sessionRef!,
    historyDigest: historyDigest(source),
    completedOperations: [],
    opaque,
  };
  const storage = new FileCheckpointStorage(f.root),
    payload = { ...body, digest: checkpointPayloadDigest(body) };
  storage.writeCheckpoint(payload);
  source.checkpoints = [
    {
      checkpointId,
      reference,
      fingerprint: body.fingerprint,
      hostIncarnation: 'TEST-old-host',
      status: 'published',
      historyDigest: body.historyDigest,
      payloadDigest: payload.digest,
    },
  ];
  const records: RuntimeSessionRecord[] = [source];
  let reads = 0,
    writes = 0,
    allowed = true;
  const coordinator = new CheckpointCoordinator({
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-new-host',
    authorize: () => allowed,
    driver: () => assert.fail('authorized checkpoint read cannot inspect a native driver'),
    store: {
      fenced(target, action) {
        return action({
          get: () => records.find((row) => runtimeDigest(row.binding) === runtimeDigest(target)),
          siblings: () => records,
          put(record) {
            writes++;
            records.push(record);
          },
        });
      },
    },
    storage: {
      writeCheckpoint: (value) => storage.writeCheckpoint(value),
      readCheckpointPayload(ref) {
        reads++;
        return storage.readCheckpointPayload(ref);
      },
    },
  });
  const opening = coordinator.prepareRestore({
    reference,
    sourceBinding: binding,
    binding: { ...binding, generation: 'TEST-target' },
    config: { ...config, generation: 2 },
  });
  assert.equal(opening.allocate, true);
  assert.equal(writes, 1, 'the existing original Runtime opening intent precedes crypto');
  const path = join(f.root, 'runtime-checkpoints', `${reference}.json`);
  return {
    coordinator,
    payload,
    path,
    reference,
    request: opening.config,
    source,
    target: opening.record,
    records,
    read: (ref: string, input: MemberProviderContext['request']) =>
      coordinator.readCheckpoint(ref, input),
    reads: () => reads,
    writes: () => writes,
    forbid: () => {
      allowed = false;
    },
    remove: () => unlinkSync(path),
    replace(next: CheckpointPayload['opaque']) {
      const replaced = { ...body, opaque: next },
        digest = checkpointPayloadDigest(replaced);
      writeFileSync(path, JSON.stringify({ ...replaced, digest }), { mode: 0o600 });
      assert.ok(source.checkpoints?.[0]);
      source.checkpoints[0].payloadDigest = digest;
    },
  };
}

function cryptoBarrier(t: TestContext) {
  const original = crypto.scrypt;
  let complete: (() => void) | undefined,
    started = 0;
  let ready!: () => void;
  const pending = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const mocked = t.mock.method(
    crypto,
    'scrypt',
    (...[input, salt, length, options, callback]: Parameters<typeof crypto.scrypt>) => {
      started++;
      original(input, salt, length, options, (error, bytes) => {
        complete = () => callback(error, bytes);
        ready();
      });
    }
  );
  syncBuiltinESMExports();
  t.after(async () => {
    if (started) await pending;
    const callback = complete;
    complete = undefined;
    callback?.();
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    pending,
    started: () => started,
    finish() {
      assert.ok(complete, 'the actual original scrypt callback must reach the finite barrier');
      const callback = complete;
      complete = undefined;
      callback();
    },
  };
}

function context(
  f: ReturnType<typeof sourceFixture>,
  original: ReturnType<typeof originalCheckpoint>
): MemberProviderContext {
  return {
    profile: { ...f.profile, generation: 2 },
    request: original.request,
    instructions: 'TEST original checkpoint context',
    connection: {
      execute: () => assert.fail('no product command'),
      lookup: () => assert.fail('no command lookup'),
      getTask: () => assert.fail('no task read'),
      listTasks: () => assert.fail('no task list'),
    },
    endpoint: {
      url: 'http://127.0.0.1:19333/TEST',
      bearerToken: 'TEST-private-endpoint',
      binding: {
        backendId: 'TEST-backend',
        teamId: 'TEST-team',
        runId: 'TEST-run',
        memberId: 'TEST-member',
        generation: 'TEST-target',
        teamName: 'TEST-team',
      },
      revoke: () => {},
      close: async () => {},
    },
    isCurrent: f.isCurrent,
    canAllocate: f.isCurrent,
    onProgress: () => {},
    readCheckpoint: original.read,
  };
}

test('protected checkpoint persists only durable witness and strips metadata before the unchanged pinned codec', async (t) => {
  const f = sourceFixture(t),
    proof = await f.issue(),
    opaque = capture(f, proof),
    original = originalCheckpoint(f, opaque);
  const bytes = readFileSync(original.path, 'utf8'),
    saved = JSON.parse(bytes);
  assert.deepEqual(saved.opaque, opaque);
  assert.deepEqual(Object.keys(saved.opaque).sort(), [
    'checkpoint',
    'kind',
    'nativeFileKeyWitness',
    'version',
  ]);
  const durable = JSON.parse(
    Buffer.from(saved.opaque.nativeFileKeyWitness, 'base64url').toString('utf8')
  );
  for (const forbidden of [
    'descriptorDigest',
    'sourceDigest',
    'namespaceDigest',
    'authDigest',
    'sha256',
    'materializedKeyDigest',
    'issuer',
    'reference',
    'request',
    'mac',
  ])
    assert.equal(JSON.stringify(durable).includes(`"${forbidden}"`), false, forbidden);
  assert.equal(bytes.includes(f.key), false);
  assert.throws(() => readOpenCodeV2CheckpointSessionId(opaque), /checkpoint-incompatible/);
  const before = original.reads();
  const prepared = await prepareOpenCodeV2EmbeddedCheckpoint({
    request: original.request,
    readCheckpoint: original.read,
    source: f.source,
    assertCurrent: f.check,
  });
  assert.equal(
    original.reads(),
    before + 2,
    'actual Runtime source reread follows retained crypto'
  );
  assert.ok(prepared.fileKeyOriginal instanceof AcceptedOpenCodeV2FileKey);
  assert.deepEqual(prepared.fileKeyOriginal.originalPolicy(), proof.originalPolicy());
  assert.equal(prepared.fileKeyOriginal.scopeDigest, proof.scopeDigest);
  assert.equal(prepared.nativeSessionId, legacyCheckpoint.nativeSessionId);
  assert.deepEqual(
    await prepared.readCheckpoint(original.reference, original.request),
    legacyCheckpoint
  );
  assert.equal(original.reads(), before + 3, 'SPI read cannot reuse a cached payload');
  assert.equal(
    original.writes(),
    1,
    'restoration verification does not publish another Runtime intent'
  );
  assert.equal(readFileSync(original.path, 'utf8'), bytes);
});

test('normal and closing checkpoints share synchronous evidence without renewed source authority or KDF', async (t) => {
  const f = sourceFixture(t),
    proof = await f.issue(),
    expected = capture(f, proof);
  f.revoke();
  const checks = f.checks();
  const files = t.mock.method(AcceptedOpenCodeV2FileKey.prototype, 'filesCurrent', () =>
    assert.fail('closing checkpoint cannot reread files')
  );
  const kdf = t.mock.method(crypto, 'scrypt', () =>
    assert.fail('checkpoint must remain synchronous')
  );
  syncBuiltinESMExports();
  try {
    assert.deepEqual(capture(f, proof), expected);
    assert.equal(f.checks(), checks, 'seal cannot require another original owner callback');
    for (const changed of [
      {},
      { proof, scopeDigest: 'f'.repeat(64) },
      { proof, scopeDigest: proof.scopeDigest, nativeSessionId: 'ses_FOREIGN' },
    ]) {
      assert.deepEqual(
        captureOpenCodeV2EmbeddedCheckpoint({
          result: { ok: true, value: legacyCheckpoint },
          source: f.source,
          nativeSessionId: legacyCheckpoint.nativeSessionId,
          ...changed,
        }),
        { ok: false, code: 'unavailable' }
      );
    }
    const failure = { ok: false, code: 'unsupported' } as const;
    assert.equal(
      captureOpenCodeV2EmbeddedCheckpoint({ result: failure, source: f.source }),
      failure
    );
    const plain = { ok: true, value: legacyCheckpoint } as const;
    assert.equal(captureOpenCodeV2EmbeddedCheckpoint({ result: plain }), plain);
  } finally {
    files.mock.restore();
    kdf.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const change of [
  'deleted',
  'replaced',
  'released-custody',
  'opening-removed',
  'two-openings',
  'authority',
] as const)
  test(
    `actual Runtime ${change} during retained crypto refuses embedded child before allocation`,
    { timeout: 30000 },
    async (t) => {
      const f = sourceFixture(t),
        proof = await f.issue(),
        opaque = capture(f, proof),
        original = originalCheckpoint(f, opaque);
      const input = context(f, original),
        provider = createOpenCodeV2EmbeddedMemberProvider(input);
      let spawns = 0,
        forgedReads = 0;
      const spawn = t.mock.method(childProcess, 'spawn', () => {
        spawns++;
        return assert.fail('TEST child must not allocate');
      });
      t.after(() => {
        spawn.mock.restore();
        syncBuiltinESMExports();
      });
      syncBuiltinESMExports();
      const barrier = cryptoBarrier(t);
      const reads = original.reads();
      const outcome = provider.factory.open(original.request).then(
        () => assert.fail('changed original checkpoint cannot open'),
        (error) => error
      );
      await barrier.pending;
      assert.equal(barrier.started(), 1);
      if (change === 'deleted') {
        original.remove();
        input.readCheckpoint = async () => {
          forgedReads++;
          return opaque;
        };
      } else if (change === 'replaced')
        original.replace({ ...legacyCheckpoint, nativeSessionId: 'ses_OTHER' });
      else if (change === 'released-custody') original.source.custody = 'unknown';
      else if (change === 'opening-removed') original.target.phase = 'closed';
      else if (change === 'two-openings')
        original.records.push({
          ...structuredClone(original.target),
          binding: { ...original.target.binding, generation: 'TEST-competing-target' },
        });
      else original.forbid();
      const bytes = existsSync(original.path) ? readFileSync(original.path, 'utf8') : undefined;
      barrier.finish();
      assert.ok((await outcome) instanceof Error);
      assert.equal(
        original.reads(),
        reads + 2,
        'actual original Runtime storage is read after crypto'
      );
      assert.equal(spawns, 0);
      assert.equal(
        forgedReads,
        0,
        'a replacement context callback cannot substitute another checkpoint owner'
      );
      assert.equal(original.writes(), 1, 'retain the original opening intent without a new claim');
      assert.equal(
        existsSync(
          join(
            f.root,
            'agent-teams-v2-' +
              runtimeDigest({
                teamId: f.profile.teamId,
                memberId: f.profile.memberId,
                sessionId: f.profile.sessionId,
              }).slice(0, 32)
          )
        ),
        false,
        'refusal precedes private child namespace creation'
      );
      if (bytes !== undefined) assert.equal(readFileSync(original.path, 'utf8'), bytes);
      assert.equal(await provider.cleanup(), true);
    }
  );

test('a later SPI read rechecks original payload, request and owner instead of returning cached native bytes', async (t) => {
  const f = sourceFixture(t),
    proof = await f.issue(),
    opaque = capture(f, proof),
    original = originalCheckpoint(f, opaque);
  const prepared = await prepareOpenCodeV2EmbeddedCheckpoint({
    request: original.request,
    readCheckpoint: original.read,
    source: f.source,
    assertCurrent: f.check,
  });
  const reads = original.reads();
  await assert.rejects(prepared.readCheckpoint('cp1-' + '0'.repeat(64), original.request));
  await assert.rejects(
    prepared.readCheckpoint(original.reference, { ...original.request, generation: 3 })
  );
  assert.equal(original.reads(), reads, 'foreign ref/request never reaches the original owner');
  original.replace({ ...legacyCheckpoint, nativeSessionId: 'ses_OTHER' });
  await assert.rejects(prepared.readCheckpoint(original.reference, original.request));
  assert.equal(original.reads(), reads + 1);
});

test('original plain legacy checkpoint is unchanged and selects explicit restore-only policy without KDF', async (t) => {
  const f = sourceFixture(t),
    original = originalCheckpoint(f, legacyCheckpoint),
    bytes = readFileSync(original.path, 'utf8');
  const mocked = t.mock.method(crypto, 'scrypt', () =>
    assert.fail('plain original checkpoint has no KDF policy')
  );
  syncBuiltinESMExports();
  try {
    const prepared = await prepareOpenCodeV2EmbeddedCheckpoint({
      request: original.request,
      readCheckpoint: original.read,
      source: f.source,
      assertCurrent: f.check,
    });
    assert.deepEqual(prepared.fileKeyOriginal, { kind: 'legacy-checkpoint' });
    assert.deepEqual(
      await prepared.readCheckpoint(original.reference, original.request),
      legacyCheckpoint
    );
    assert.equal(readFileSync(original.path, 'utf8'), bytes);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('legacy checkpoint observation stays plain without reading its intentionally absent durable encoding', async (t) => {
  const f = sourceFixture(t),
    legacy = { kind: 'legacy' } as const;
  const material = createOpenCodeV2FileMaterialization(f.source.descriptor, f.check, legacy);
  const value = selectedFilePaths(f.source.descriptor)
    .map((path) => material.readFileString(path).trim())
    .join('');
  material.materializedKey(value);
  const issuer = {
    nonce: '5'.repeat(64),
    pid: process.pid,
    integrationId: 'TEST-provider',
    reference: openCodeV2SelectedSourceReference(
      f.source.descriptor,
      '5'.repeat(64),
      'TEST-provider',
      'restore'
    ),
  };
  const request = { method: 'GET' as const, deadline: Date.now() + 30000 },
    password = Buffer.alloc(32, 8).toString('base64url');
  const mocked = t.mock.method(crypto, 'scrypt', () =>
    assert.fail('original legacy observation must not run KDF')
  );
  syncBuiltinESMExports();
  try {
    await material.prepareIssue(value, issuer, request, password);
    const wire = material.issue(value, issuer),
      observed = JSON.parse(Buffer.from(wire, 'base64url').toString('utf8'));
    assert.equal(typeof observed.scopeDigest, 'string');
    const proof = AcceptedOpenCodeV2FileKey.accept(f.source, wire, issuer, f.isCurrent, {
      policy: legacy,
      password,
      request: { ...request, originalScopeDigest: observed.scopeDigest },
    });
    assert.equal(proof.originalPolicy().kind, 'legacy');
    assert.throws(
      () => proof.encoded,
      'plain checkpoint has no independently retained durable v1 encoding'
    );
    const original = originalCheckpoint(f, {
      kind: 'opencode-v2-file-checkpoint',
      version: 1,
      checkpoint: legacyCheckpoint,
      nativeFileKeyWitness: wire,
    });
    await assert.rejects(
      prepareOpenCodeV2EmbeddedCheckpoint({
        request: original.request,
        readCheckpoint: original.read,
        source: f.source,
        assertCurrent: f.check,
      }),
      /unavailable/
    );
    f.revoke();
    assert.deepEqual(
      capture(f, proof),
      legacyCheckpoint,
      'closing legacy capture cannot touch the throwing encoding getter'
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('malformed envelope cannot downgrade, disclose getters or allocate a child', async (t) => {
  const f = sourceFixture(t),
    proof = await f.issue(),
    opaque = capture(f, proof);
  assert.ok(opaque && typeof opaque === 'object' && !Array.isArray(opaque));
  let getters = 0;
  const proxyKeys: PropertyKey[] = [];
  const getter = Object.defineProperty({ ...opaque }, 'checkpoint', {
    enumerable: true,
    get() {
      getters++;
      return legacyCheckpoint;
    },
  });
  const nestedGetter = Object.defineProperty({ ...legacyCheckpoint }, 'nativeSessionId', {
    enumerable: true,
    get() {
      getters++;
      return legacyCheckpoint.nativeSessionId;
    },
  });
  const cases = [
    { ...opaque, kind: 'unknown' },
    { ...opaque, version: 2 },
    { ...opaque, extra: true },
    { ...opaque, nativeFileKeyWitness: '' },
    { ...opaque, checkpoint: { ...legacyCheckpoint, extra: true } },
    { ...opaque, checkpoint: nestedGetter },
    { ...legacyCheckpoint, nativeFileKeyWitness: opaque.nativeFileKeyWitness },
    getter,
    new Proxy(opaque, {
      get(_target, key) {
        proxyKeys.push(key);
        return undefined;
      },
    }),
  ];
  for (const candidate of cases) {
    let reads = 0;
    await assert.rejects(
      prepareOpenCodeV2EmbeddedCheckpoint({
        request: {
          tenantId: 'TEST-tenant',
          projectId: 'TEST-project',
          sessionId: 'TEST-session',
          generation: 2,
          configRevision: 'TEST-revision',
          requiredCapabilities: ['text'],
          checkpointRef: 'TEST-ref',
        },
        readCheckpoint: async () => {
          reads++;
          return candidate;
        },
        source: f.source,
        assertCurrent: f.check,
      })
    );
    assert.equal(reads, 1, 'invalid envelope never proceeds to another native/owner read');
  }
  assert.equal(getters, 0);
  assert.deepEqual(proxyKeys, ['then', 'then'], 'only the two async returns inspect thenability');
});

test('selected-file readiness missing its nominal handoff refuses before server creation', async (t) => {
  const f = sourceFixture(t),
    original = originalCheckpoint(f, legacyCheckpoint);
  const { checkpointRef, ...request } = original.request;
  assert.equal(checkpointRef, original.reference);
  const input: MemberProviderContext = { ...context(f, original), request };
  input.assertReadinessCredential = () => assert.fail('no accepted native credential');
  assert.throws(() => createOpenCodeV2EmbeddedMemberProvider(input), /unavailable/);
  assert.equal(original.writes(), 1);
  input.readinessFileKey = await f.issue();
  const matched = createOpenCodeV2EmbeddedMemberProvider(input);
  assert.equal(matched.isReady(), false, 'a valid handoff constructs but never starts a child');
  assert.equal(await matched.cleanup(), true);
});

test('maximum envelope accounting keeps the existing whole-record storage boundary', (t) => {
  const f = sourceFixture(t);
  const opaque = {
    kind: 'opencode-v2-file-checkpoint',
    version: 1,
    checkpoint: {
      version: 1,
      engine: 'opencode-v2',
      nativeSessionId: 'ses_' + 'A'.repeat(256),
      compatibility: 'a'.repeat(64),
    },
    nativeFileKeyWitness: 'A'.repeat(65536),
  };
  // This is a maximum-size accounting vector, not a claim that arbitrary text is an accepted witness.
  assert.equal(Buffer.byteLength(JSON.stringify(opaque)), 66026);
  assert.equal(Buffer.byteLength(JSON.stringify(opaque, null, 2)), 66070);
  const original = originalCheckpoint(f, opaque),
    size = Buffer.byteLength(JSON.stringify(original.payload, null, 2));
  assert.doesNotThrow(() =>
    new FileCheckpointStorage(f.root, size).writeCheckpoint(original.payload)
  );
  assert.throws(
    () => new FileCheckpointStorage(f.root, size - 1).writeCheckpoint(original.payload),
    { code: 'hold' }
  );
  assert.ok(size < 8 * 1024 * 1024);
  const checkpointId = 'TEST-whole-record-bound',
    binding = original.payload.sourceBinding;
  const { digest: _digest, ...base } = original.payload;
  const operations = [
    {
      inputId: 'TEST-input',
      operationRef: 'TEST-operation',
      fingerprint: 'X',
      outcome: 'succeeded',
    },
  ];
  const bounded = () => {
    const body = {
      ...base,
      checkpointId,
      reference: `cp1-${runtimeDigest({ binding, checkpointId })}`,
      fingerprint: checkpointFingerprint(binding, base.profileId, base.sourceConfig, checkpointId),
      completedOperations: operations,
      historyDigest: runtimeDigest({ baseline: null, operations }),
    };
    return { ...body, digest: checkpointPayloadDigest(body) };
  };
  const maximum = 8 * 1024 * 1024;
  operations[0]!.fingerprint = 'X'.repeat(
    maximum - Buffer.byteLength(JSON.stringify(bounded(), null, 2)) + 1
  );
  assert.equal(Buffer.byteLength(JSON.stringify(bounded(), null, 2)), maximum);
  const storage = new FileCheckpointStorage(f.root);
  storage.writeCheckpoint(bounded());
  assert.deepEqual(storage.readCheckpointPayload(bounded().reference), bounded());
  operations[0]!.fingerprint += 'X';
  assert.equal(Buffer.byteLength(JSON.stringify(bounded(), null, 2)), maximum + 1);
  assert.throws(() => storage.writeCheckpoint(bounded()), { code: 'hold' });
});
