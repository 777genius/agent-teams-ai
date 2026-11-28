import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs, { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import {
  AcceptedOpenCodeV2FileKey, DeferredOpenCodeV2FileKey, createOpenCodeV2FileMaterialization,
  openCodeV2NativeFileWitnessSchema, openCodeV2SelectedSourceReference, originalOpenCodeV2FilePolicy,
  parseOpenCodeV2FilePolicy,
} from '../dist/adapters/providers/OpenCodeV2SelectedFileKey.js';
import type { OpenCodeV2FilePolicy } from '../dist/adapters/providers/OpenCodeV2SelectedFileKey.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import { managementDigest } from '../dist/management/identity.js';
import { deriveSecretFingerprint } from '../dist/management/secretFingerprint.js';
import { createOpenCodeV2NativeFileTransform } from '../dist/adapters/providers/OpenCodeV2NativeFileKey.js';

function fixture(t: TestContext, key = 'TEST-original-file-key') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-file-witness-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'TEST-original.key');
  writeFileSync(path, key, { mode: 0o600 });
  let current = true;
  const source = DeferredOpenCodeV2FileKey.capture({
    sourceDigest: 'a'.repeat(64), namespaceDigest: 'b'.repeat(64), authDigest: 'c'.repeat(64),
    origin: { kind: 'inline', digest: 'd'.repeat(64), value: '{file:TEST-original.key}' },
    providerId: 'TEST-provider', modelId: 'TEST-model', cwd: root, home: root,
    environment: {}, isCurrent: () => current,
  });
  // This exercises the real private issuer and journal using isolated TEST material.
  // The pinned native Effect/ConfigVariable path has a separate qualification fixture.
  async function issue(options: { policy?: OpenCodeV2FilePolicy; nonce?: string; pid?: number; password?: string;
    method?: 'GET' | 'POST'; deadline?: number; original?: AcceptedOpenCodeV2FileKey } = {}) {
    const nonce = options.nonce ?? 'e'.repeat(64), pid = options.pid ?? process.pid;
    const policy = options.policy ?? originalOpenCodeV2FilePolicy(source, 'fresh'); assert.ok(policy);
    const request = { method: options.method ?? 'POST', deadline: options.deadline ?? Date.now() + 5000 };
    const password = options.password ?? Buffer.alloc(32, 7).toString('base64url');
    const check = () => { assert.equal(current, true); assert.ok(Date.now() < request.deadline); };
    const materializer = createOpenCodeV2FileMaterialization(source.descriptor, check, policy);
    const selected = materializer.readFileString(path).trim();
    assert.equal(materializer.materializedKey(selected), key);
    const issuer = { nonce, pid, integrationId: 'TEST-provider',
      reference: openCodeV2SelectedSourceReference(source.descriptor, nonce, 'TEST-provider', 'fresh') };
    const prepared = await materializer.prepareIssue(selected, issuer, request, password);
    const live = materializer.issue(selected, issuer);
    // Explicit legacy compatibility fixture: this is a pre-existing retained original, not fresh admission.
    const accepted = policy.kind === 'legacy' && options.original === undefined
      ? await AcceptedOpenCodeV2FileKey.retained(source, live, () => {})
      : AcceptedOpenCodeV2FileKey.accept(source, live, issuer, () => current,
        { policy, password, request, ...(options.original ? { original: options.original } : {}) });
    return { encoded: accepted.encoded, live, issuer, accepted, policy, password, request, prepared };
  }
  return { root, path, key, source, issue, revoke() { current = false; } };
}

async function releasedProbe(t: TestContext, f: ReturnType<typeof fixture>) {
  const issued = await f.issue(), store = new FileManagementCommandStore(f.root);
  const input = { commandId: 'TEST-original-probe', profileId: 'TEST-profile',
    configRevision: 'TEST-config', providerId: 'TEST-provider', modelId: 'TEST-model',
    context: 'f'.repeat(64) };
  const target = { profileId: input.profileId, configRevision: input.configRevision,
    selectionDigest: '1'.repeat(64), resourceId: '2'.repeat(64) };
  let runs = 0, closes = 0, observations = 0;
  const owner = new ModelProbeOwner({ store, fence: new ManagementResourceFence(store.list()),
    assertWriter() {}, select: () => target,
    prepare: () => ({ timeoutMs: 1000,
      async run() { runs++; return true; },
      async close() { closes++; return true; },
      readiness: () => ({ schemaVersion: 1, ordinary: 'confirmed', coordination: 'not-applicable',
        decision: 'allow', reasons: ['not-applicable'], routeDigest: '3'.repeat(64),
        configurationDigest: '4'.repeat(64), accountDigest: managementDigest({ key: issued.accepted.scopeDigest }),
        metadata: { provider: 'custom', tools: null, modelListed: null, contextTokens: null,
          parameterCount: null, configuredContextTokens: null, trainedContextTokens: null,
          contextSource: 'unknown' } }),
      nativeFileKeyWitness() { assert.equal(closes, 1); observations++; return issued.accepted; },
    }),
  });
  t.after(() => owner.close());
  owner.startNativeReadiness(input, () => true);
  const end = performance.now() + 2000;
  while (store.read(input.commandId)?.phase === 'running' && performance.now() < end)
    await new Promise<void>(resolve => setImmediate(resolve));
  const saved = store.read(input.commandId);
  assert.ok(saved?.kind === 'model.probe');
  assert.equal(saved.phase, 'completed'); assert.equal(saved.resourceHeld, false); assert.equal(saved.ok, true);
  assert.deepEqual({ runs, closes, observations }, { runs: 1, closes: 1, observations: 1 });
  assert.ok(saved.nativeFileKeyWitness);
  const files = readdirSync(join(f.root, 'management-commands'));
  assert.equal(files.length, 1);
  const receiptPath = join(f.root, 'management-commands', files[0]!);
  const bytes = readFileSync(receiptPath, 'utf8');
  assert.equal(JSON.parse(bytes).nativeFileKeyWitness, saved.nativeFileKeyWitness);
  return { issued, saved, bytes, store, owner, input, receiptPath };
}

test('legacy original file scope is stable across child issuers and cold retained reads preserve exact bytes', async t => {
  const f = fixture(t), first = await f.issue({ policy: { kind: 'legacy' }, method: 'GET' });
  const second = await f.issue({ policy: first.accepted.originalPolicy(), method: 'GET', original: first.accepted,
    nonce: 'f'.repeat(64), pid: process.pid + 1 });
  assert.notEqual(first.live, second.live);
  assert.equal(first.encoded, second.encoded, 'a legacy observation cannot replace original stored bytes');
  assert.equal(first.accepted.scopeDigest, second.accepted.scopeDigest,
    'the legacy algorithm already excludes child identity from its scope');
  assert.equal(openCodeV2NativeFileWitnessSchema.safeParse(first.encoded).success, true);
  let reads = 0;
  const retained = await AcceptedOpenCodeV2FileKey.retained(f.source, first.encoded, () => { reads++; });
  assert.equal(retained.encoded, first.encoded); assert.equal(reads, 2);
  assert.equal(retained.scopeDigest, first.accepted.scopeDigest);
  assert.equal(retained.filesCurrent(), true);
});

test('a released ModelProbe durable file witness contains no fast secret-derived or live issuer fields', async t => {
  const f = fixture(t), original = await releasedProbe(t, f);
  const proof = JSON.parse(Buffer.from(original.saved.nativeFileKeyWitness!, 'base64url').toString('utf8'));
  assert.equal(original.bytes.includes(f.key), false);
  const forbidden = ['descriptorDigest', 'sourceDigest', 'namespaceDigest', 'authDigest',
    'materializedKeyDigest', 'issuer', 'mac', 'password'].filter(name => Object.hasOwn(proof, name));
  for (const [index, dependency] of proof.dependencies.entries())
    if (Object.hasOwn(dependency, 'sha256')) forbidden.push('dependencies[' + index + '].sha256');
  assert.deepEqual(forbidden, [], 'the original completed/released journal must persist only the protected witness');
  assert.equal(proof.schemaVersion, 2);
  assert.deepEqual(Object.keys(proof), ['schemaVersion', 'key', 'files', 'scopeDigest', 'dependencies']);
  assert.equal(openCodeV2NativeFileWitnessSchema.safeParse(original.issued.live).success, false);
});

function controlledFingerprints(t: TestContext, real = false) {
  const callbacks: ((error?: Error) => void)[] = [];
  const original = crypto.scrypt;
  let started = 0;
  t.mock.method(crypto, 'scrypt', (...[input, salt, length, options, callback]: Parameters<typeof crypto.scrypt>) => {
    assert.ok(Buffer.isBuffer(input) && Buffer.isBuffer(salt)); started++;
    callbacks.push(error => {
      if (error) callback(error, Buffer.alloc(0));
      else if (real) original(input, salt, length, options, callback);
      else callback(null, crypto.createHash('sha256').update(input).update(salt).digest());
    });
  });
  syncBuiltinESMExports();
  const finish = (error?: Error) => { const callback = callbacks.shift(); assert.ok(callback); callback(error); };
  t.after(() => { while (callbacks.length) finish(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { started: () => started, finish };
}
async function until(check: () => boolean) {
  const end = performance.now() + 2000;
  while (!check() && performance.now() < end) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(check(), 'the controlled original callback must reach its finite barrier');
}

test('protected continuation retains its original policy across child passwords while independent originals differ', async t => {
  const f = fixture(t), first = await f.issue();
  const second = await f.issue({ policy: first.accepted.originalPolicy(), nonce: 'f'.repeat(64),
    pid: process.pid + 1, password: Buffer.alloc(32, 8).toString('base64url') });
  assert.equal(second.accepted.scopeDigest, first.accepted.scopeDigest);
  assert.equal(second.encoded, first.encoded);
  assert.notEqual(second.live, first.live);
  const independent = await f.issue();
  assert.notEqual(independent.accepted.scopeDigest, first.accepted.scopeDigest);
  assert.notDeepEqual(independent.accepted.originalPolicy(), first.accepted.originalPolicy());
  const wrong = originalOpenCodeV2FilePolicy(f.source, 'fresh'); assert.ok(wrong?.kind === 'protected');
  await assert.rejects(f.issue({ policy: { ...wrong, scopeDigest: first.accepted.scopeDigest } }));
});

test('a one-character key and exact file bytes use the domain-separated original slow preimages', async t => {
  const f = fixture(t, 'x'), original = await f.issue();
  const proof = JSON.parse(Buffer.from(original.encoded, 'base64url').toString('utf8'));
  assert.deepEqual(proof.key, await deriveSecretFingerprint({
    domain: 'agent-teams/opencode-selected-file-key/v2', key: f.key,
  }, proof.key.fingerprintKdf));
  const { digest: _originalTransientDigest, ...descriptor } = f.source.descriptor;
  const files = proof.dependencies.map((file: { path: string }) => ({ ...file,
    bytes: readFileSync(file.path).toString('base64url') }));
  assert.deepEqual(proof.files, await deriveSecretFingerprint({
    domain: 'agent-teams/opencode-selected-file-files/v2', descriptor, files,
  }, proof.files.fingerprintKdf));
  assert.equal(JSON.stringify(proof).includes(crypto.createHash('sha256').update(f.key).digest('hex')), false);
});

test('live proof requires the original password, issuer, method, deadline, policy and canonical encoding', async t => {
  const f = fixture(t), original = await f.issue();
  const auth = { policy: original.policy, password: original.password, request: original.request };
  const accept = (live: string, input = auth, issuer = original.issuer) =>
    AcceptedOpenCodeV2FileKey.accept(f.source, live, issuer, () => true, input);
  assert.equal(accept(original.live).encoded, original.encoded);
  assert.throws(() => accept(original.live, { ...auth, password: Buffer.alloc(32, 1).toString('base64url') }));
  assert.throws(() => accept(original.live, { ...auth, request: { ...auth.request, method: 'GET' } }));
  assert.throws(() => accept(original.live, { ...auth, request: { ...auth.request, deadline: Date.now() - 1 } }));
  assert.throws(() => accept(original.live, auth, { ...original.issuer, nonce: '0'.repeat(64) }));
  const foreign = originalOpenCodeV2FilePolicy(f.source, 'fresh'); assert.ok(foreign);
  assert.throws(() => accept(original.live, { ...auth, policy: foreign }));
  const parsed = JSON.parse(Buffer.from(original.live, 'base64url').toString('utf8'));
  for (const changed of [{ ...parsed, extra: true }, { ...parsed, mac: '0'.repeat(64) },
    { ...parsed, request: { ...parsed.request, deadline: parsed.request.deadline + 1 } }])
    assert.throws(() => accept(Buffer.from(JSON.stringify(changed)).toString('base64url')));
  const text = Buffer.from(original.live, 'base64url').toString('utf8');
  assert.throws(() => accept(Buffer.from(text.replace('{', '{"schemaVersion":2,')).toString('base64url')));
  assert.throws(() => accept(Buffer.from(text + '\n').toString('base64url')));
  assert.throws(() => accept(original.live + '='));
  assert.throws(() => accept(original.encoded), 'durable evidence is not a same-child live response');
  assert.equal(openCodeV2NativeFileWitnessSchema.safeParse(original.encoded).success, true);
  const stored = JSON.parse(Buffer.from(original.encoded, 'base64url').toString('utf8'));
  assert.equal(openCodeV2NativeFileWitnessSchema.safeParse(Buffer.from(JSON.stringify({ ...stored,
    files: { ...stored.files, fingerprintKdf: { ...stored.files.fingerprintKdf, salt: stored.files.fingerprintKdf.salt + '\n' } },
  })).toString('base64url')).success, false);
});

test('the strict durable codec keeps its exact 65536-character bound without granting changed metadata authority', async t => {
  const f = fixture(t), original = await f.issue();
  const proof = JSON.parse(Buffer.from(original.encoded, 'base64url').toString('utf8'));
  const resized = (length: number) => {
    const value = structuredClone(proof);
    value.dependencies[0].identity[0] = '1'.repeat(length);
    value.scopeDigest = managementDigest({ domain: 'agent-teams/opencode-selected-file-scope/v2',
      key: value.key, files: value.files, dependencies: value.dependencies });
    return Buffer.from(JSON.stringify(value));
  };
  const length = 49152 - resized(1).length + 1;
  assert.ok(length > 1);
  const exact = resized(length).toString('base64url');
  assert.equal(exact.length, 65536);
  assert.equal(openCodeV2NativeFileWitnessSchema.safeParse(exact).success, true);
  assert.equal(openCodeV2NativeFileWitnessSchema.safeParse(resized(length + 1).toString('base64url')).success, false);
  const controlled = controlledFingerprints(t);
  await assert.rejects(AcceptedOpenCodeV2FileKey.retained(f.source, exact, () => {}));
  assert.equal(controlled.started(), 0, 'a public structural checksum cannot qualify fabricated file metadata');
});

for (const fault of ['deleted', 'replaced', 'source', 'files'] as const) {
  test('cold protected proof refuses original ' + fault + ' during async verification without rewriting receipt', async t => {
    const f = fixture(t), original = await releasedProbe(t, f), controlled = controlledFingerprints(t, true);
    let reads = 0;
    const retained = AcceptedOpenCodeV2FileKey.retained(f.source, original.saved.nativeFileKeyWitness!, () => {
      reads++;
      assert.deepEqual(original.store.read(original.input.commandId), original.saved);
    });
    const rejected = assert.rejects(retained);
    assert.equal(controlled.started(), 1);
    if (fault === 'deleted') unlinkSync(original.receiptPath);
    if (fault === 'replaced') {
      const replacement = { ...original.saved, expiresAt: original.saved.expiresAt + 1 };
      original.store.write(replacement);
      assert.deepEqual(original.store.read(original.input.commandId), replacement);
    }
    if (fault === 'source') f.revoke();
    if (fault === 'files') writeFileSync(f.path, 'TEST-replaced-file', { mode: 0o600 });
    const bytes = fault === 'deleted' ? undefined : readFileSync(original.receiptPath);
    controlled.finish(); await rejected;
    assert.equal(reads, 2, 'the actual original receipt is read again after the controlled KDF');
    if (bytes) assert.deepEqual(readFileSync(original.receiptPath), bytes);
    else assert.equal(original.store.read(original.input.commandId), undefined);
  });
}

test('same-child prepared GET and synchronous currentness perform no further derivation', async t => {
  const f = fixture(t), original = await f.issue();
  const controlled = controlledFingerprints(t);
  const current = createOpenCodeV2FileMaterialization(f.source.descriptor, () => {}, original.policy);
  const key = current.readFileString(f.path), request = { ...original.request, method: 'GET' as const };
  await current.prepareIssue(key, original.issuer, request, original.password, original.prepared);
  const live = current.issue(key, original.issuer);
  const accepted = AcceptedOpenCodeV2FileKey.accept(f.source, live, original.issuer, () => true,
    { policy: original.policy, password: original.password, request });
  assert.equal(accepted.encoded, original.encoded);
  for (let index = 0; index < 20; index++) {
    assert.equal(accepted.filesCurrent(), true);
    assert.equal(AcceptedOpenCodeV2FileKey.matches(accepted, f.source), true);
    assert.equal(accepted.originalPolicy().kind, 'protected');
  }
  assert.equal(controlled.started(), 0);
  f.revoke();
  assert.equal(accepted.filesCurrent(), true, 'closing verification remains independent of a sealed owner');
  assert.equal(AcceptedOpenCodeV2FileKey.matches(accepted, f.source), true);
  assert.equal(accepted.originalPolicy().kind, 'protected');
});

test('explicit legacy checkpoint observation has no durable encoding and missing policy cannot select legacy', async t => {
  const f = fixture(t), original = await f.issue({ policy: { kind: 'legacy' }, method: 'GET' });
  const transient = AcceptedOpenCodeV2FileKey.accept(f.source, original.live, original.issuer, () => true, {
    policy: { kind: 'legacy' }, password: original.password,
    request: { ...original.request, originalScopeDigest: original.accepted.scopeDigest },
  });
  assert.equal(transient.originalPolicy().kind, 'legacy');
  assert.equal(transient.scopeDigest, original.accepted.scopeDigest);
  assert.throws(() => transient.encoded);
  assert.throws(() => originalOpenCodeV2FilePolicy(f.source, 'fresh', transient));
  assert.throws(() => originalOpenCodeV2FilePolicy(f.source, 'restore'));
  assert.throws(() => parseOpenCodeV2FilePolicy(undefined, 'fresh'));
  assert.throws(() => parseOpenCodeV2FilePolicy({ kind: 'legacy' }, 'fresh'));
  assert.deepEqual(originalOpenCodeV2FilePolicy(f.source, 'restore', { kind: 'legacy-checkpoint' }), { kind: 'legacy' });
  assert.equal(originalOpenCodeV2FilePolicy(f.source, 'catalog'), undefined);
});

test('the original 256KiB source admission retains its range with at most 384KiB total native verification reads', async t => {
  const f = fixture(t), second = join(f.root, 'TEST-second.key');
  writeFileSync(f.path, 'a' + ' '.repeat(65535), { mode: 0o600 });
  writeFileSync(second, 'b' + ' '.repeat(65535), { mode: 0o600 });
  const source = DeferredOpenCodeV2FileKey.capture({ ...f.source.descriptor,
    origin: { ...f.source.descriptor.origin, value: '{file:' + f.path + '}{file:' + second + '}' },
    environment: {}, isCurrent: () => true });
  const policy = originalOpenCodeV2FilePolicy(source, 'fresh'); assert.ok(policy);
  const controlled = controlledFingerprints(t), read = fs.readSync;
  let bytesRead = 0;
  t.mock.method(fs, 'readSync', (...args: [number, Buffer, number, number, number]) => {
    const length = read(...args); bytesRead += length; return length;
  });
  syncBuiltinESMExports();
  const materializer = createOpenCodeV2FileMaterialization(source.descriptor, () => {}, policy);
  const key = [f.path, second].map(path => materializer.readFileString(path).trim()).join('');
  assert.equal(key, 'ab'); assert.equal(bytesRead, 128 * 1024);
  const issuer = { nonce: 'e'.repeat(64), pid: process.pid, integrationId: 'TEST-provider',
    reference: openCodeV2SelectedSourceReference(source.descriptor, 'e'.repeat(64), 'TEST-provider', 'fresh') };
  const request = { method: 'POST' as const, deadline: Date.now() + 5000 };
  const pending = materializer.prepareIssue(key, issuer, request, Buffer.alloc(32, 7).toString('base64url'));
  controlled.finish(); await until(() => controlled.started() === 2); controlled.finish(); await pending;
  assert.equal(bytesRead, 256 * 1024, 'the additional pre-effect pass is the same bounded 128KiB unique source');
  materializer.issue(key, issuer);
  assert.equal(bytesRead, 384 * 1024, 'the original final pass still has its reserved budget');
  const refused = createOpenCodeV2FileMaterialization(source.descriptor, () => {}, policy);
  refused.readFileString(f.path); refused.readFileString(second); refused.readFileString(f.path);
  await assert.rejects(refused.prepareIssue(key, issuer, request, Buffer.alloc(32, 7).toString('base64url')));
  assert.equal(controlled.started(), 2, 'an over-budget original source never enters the KDF queue');
});

// This small controlled Effect interpreter exercises the actual Host transform and its ordering.
// It does not stand in for the separate delivered Bun/Effect/native qualification.
async function nativeTransformFixture(t: TestContext) {
  const f = fixture(t), modulePath = join(f.root, 'TEST-controlled-effect.mjs');
  writeFileSync(modulePath, `
const evaluate = (effect, context) => effect(context);
export const Effect = {
  sync: work => async () => work(),
  try: input => async () => { try { return input.try(); } catch(error) { throw input.catch(error); } },
  tryPromise: input => async context => { try { return await input.try(context.signal); } catch(error) { throw input.catch(error); } },
  flatMap: (effect, next) => async context => evaluate(next(await evaluate(effect, context)), context),
  provideService: (effect, tag, service) => async context => evaluate(effect,
    { ...context, services: new Map(context.services).set(tag, service) }),
  catch: (effect, recover) => async context => { try { return await evaluate(effect, context); }
    catch(error) { return evaluate(recover(error), context); } },
};
export const Option = { some: value => value };
export const FSUtil = { Service: Symbol('TEST-files') };
export const ConfigVariable = { substitute: input => async context => {
  let value = JSON.parse(input.text).apiKey;
  for (const match of [...value.matchAll(/\\{file:([^}]+)\\}/g)]) {
    const bytes = await evaluate(context.services.get(FSUtil.Service).readFileString(match[1]), context);
    value = value.replace(match[0], bytes.trim());
  }
  return JSON.stringify({ apiKey: value });
} };
export const HttpServerRequest = {
  HttpServerRequest: async context => context.services.get(HttpServerRequest.HttpServerRequest),
  MaxBodySize: Symbol('TEST-body'),
  fromWeb: request => ({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers),
    remoteAddress: undefined, source: { rawHeaders: [...request.headers].flat() },
    arrayBuffer: async () => request.arrayBuffer(), modify(input) { return { ...this, ...input }; } }),
};
export const HttpServerResponse = { jsonUnsafe: (value, options = {}) => ({ status: options.status ?? 200,
  headers: options.headers ?? {}, cookies: options.cookies, body: { _tag: 'Uint8Array',
    body: Buffer.from(JSON.stringify(value)), contentType: 'application/json' } }) };
export const authorizedRequest = (request, credentials) => async () =>
  request.headers.authorization === 'Basic ' + Buffer.from('opencode:' + credentials.password).toString('base64');
export const unauthorizedResponse = () => HttpServerResponse.jsonUnsafe({}, { status: 401 });
export const calls = { connect: 0, read: 0, keys: [] };
export const app = async context => {
  const request = await evaluate(HttpServerRequest.HttpServerRequest, context);
  if (request.method === 'POST') {
    calls.connect++; calls.keys.push(JSON.parse(Buffer.from(await evaluate(request.arrayBuffer, context)).toString()).key);
    return { status: 204, headers: {}, cookies: undefined, body: { _tag: 'Empty' } };
  }
  calls.read++; return HttpServerResponse.jsonUnsafe({ data: { id: 'TEST-provider', connections: [] } });
};
export const run = (effect, request, signal) => evaluate(effect, { signal,
  services: new Map([[HttpServerRequest.HttpServerRequest, request]]) });
`, { mode: 0o600 });
  const engine = await import(pathToFileURL(modulePath).href) as {
    app: unknown; calls: { connect: number; read: number; keys: string[] };
    run(effect: unknown, request: unknown, signal: AbortSignal): Promise<{ status: number; body: { body: Buffer } }>;
  };
  const source = DeferredOpenCodeV2FileKey.capture({ ...f.source.descriptor, cwd: process.cwd(), home: homedir(),
    origin: { ...f.source.descriptor.origin, value: '{file:' + f.path + '}' }, environment: {}, isCurrent: () => true });
  const policy = originalOpenCodeV2FilePolicy(source, 'fresh'); assert.ok(policy);
  const nonce = 'e'.repeat(64), password = Buffer.alloc(32, 7).toString('base64url'), owner = new AbortController();
  const transform = await createOpenCodeV2NativeFileTransform({ descriptor: source.descriptor, mode: 'fresh', policy,
    nonce, password, signal: owner.signal, graph: { modulePath, effectPath: modulePath, requiredBunVersion: 'TEST-controlled',
      selectedFileModules: { variablePath: modulePath, fileSystemPath: modulePath, authorizationPath: modulePath, httpPath: modulePath } } });
  const reference = openCodeV2SelectedSourceReference(source.descriptor, nonce, 'TEST-provider', 'fresh');
  function run(method: 'GET' | 'POST', deadline: number, signal = new AbortController().signal) {
    const headers = { host: '127.0.0.1', authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'),
      ...(method === 'GET' ? { 'x-agent-teams-selected-source': 'v1:' + reference,
        'x-agent-teams-selected-source-deadline': String(deadline) } : {}) };
    const bytes = Buffer.from(JSON.stringify({ selectedSource: { schemaVersion: 1, reference, deadline } }));
    const request = { url: '/api/integration/TEST-provider' + (method === 'POST' ? '/connect/key' : '') + '?' +
        new URLSearchParams({ 'location[directory]': source.descriptor.cwd }),
      method, headers, remoteAddress: undefined, source: { rawHeaders: Object.entries(headers).flat() },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      modify(input: object) { return { ...this, ...input }; } };
    return engine.run(transform(engine.app), request, signal);
  }
  return { ...f, source, policy, owner, engine, run, nonce, password, reference };
}

for (const fault of ['none', 'owner-abort', 'fiber-abort', 'expired', 'file-drift', 'kdf-failed'] as const) {
  test('actual native transform prepares before Connect: ' + fault, async t => {
    const f = await nativeTransformFixture(t), controlled = controlledFingerprints(t);
    const deadline = Date.now() + 5000, fiber = new AbortController();
    const pending = f.run('POST', deadline, fiber.signal);
    await until(() => controlled.started() === 1);
    assert.equal(f.engine.calls.connect, 0, 'the key proof is still pending');
    if (fault === 'owner-abort') f.owner.abort();
    if (fault === 'fiber-abort') fiber.abort();
    if (fault === 'expired') t.mock.timers.enable({ apis: ['Date'], now: deadline });
    if (fault === 'file-drift') writeFileSync(f.path, 'TEST-changed', { mode: 0o600 });
    controlled.finish(fault === 'kdf-failed' ? new Error('TEST controlled derivation failure') : undefined);
    if (fault === 'none' || fault === 'file-drift') {
      await until(() => controlled.started() === 2);
      assert.equal(f.engine.calls.connect, 0, 'the files proof is still pending'); controlled.finish();
    }
    const response = await pending;
    assert.equal(response.status, fault === 'none' ? 200 : 400);
    assert.equal(f.engine.calls.connect, fault === 'none' ? 1 : 0);
    if (fault === 'none') {
      assert.deepEqual(f.engine.calls.keys, [f.key]);
      const live = JSON.parse(response.body.body.toString('utf8')).witness as string;
      const accepted = AcceptedOpenCodeV2FileKey.accept(f.source, live,
        { nonce: f.nonce, pid: process.pid, integrationId: 'TEST-provider', reference: f.reference }, () => true,
        { policy: f.policy, password: f.password, request: { method: 'POST', deadline } });
      assert.equal(accepted.originalPolicy().kind, 'protected');
      for (let index = 0; index < 2; index++) assert.equal((await f.run('GET', deadline)).status, 200);
      assert.equal(controlled.started(), 2, 'same-child reads retain the original preparation without another KDF');
      assert.equal(f.engine.calls.read, 2); assert.equal(f.engine.calls.connect, 1);
    }
  });
}
