/** TEST-only key connection through the actual 2.1.4 engine and Host credential ledger. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { fileHash, startHost, tick } from './fixtures/native-host.ts';
import { assertNativeV1Build, buildNativeV1Host } from './opencode-v1-version-source.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type {
  ProviderCredentialReceipt, ProviderManagementCatalog, ProviderModelProbeSnapshot,
} from '../dist/management/contracts.js';

const value = <T>(result: Record<string, unknown>): T => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value as T;
};
const selectedKey = 'TEST-native-selected-key-never-a-real-secret';
const rejectedKey = 'TEST-native-rejected-key-never-a-real-secret';
const foreignKey = 'TEST-native-foreign-key-never-import';

test('native V2 rejects a wrong key, accepts its explicit correction and retains unknown intents without replay', {
  skip: process.env.OPENCODE_V2_CREDENTIAL_GO !== '1', timeout: 240000,
}, async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0');
  const repo = resolve(import.meta.dirname, '../../..'), pkg = join(repo, 'packages/legacy-agent-host');
  const node = await realpath(process.execPath), entry = join(pkg, 'dist/cli.js');
  const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  const engine = await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
  const receiptPath = process.env.OPENCODE_V2_CREDENTIAL_RECEIPT!;
  assert.ok(receiptPath?.startsWith('/'));
  const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
  const build = await buildNativeV1Host(repo, sourceHead);
  const digests = { node: await fileHash(node), bun: await fileHash(bun),
    manifest: await fileHash(join(engine, 'opencode-v2-engine-manifest.json')),
    hostSource: build.hostSourceDigest, hostDist: build.hostDistDigest, provider: build.providerDigest };
  assert.equal(digests.manifest, process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-v2-credentials-')));
  const steps: string[] = [], failures: string[] = [];
  const requests: { authorizationMatched: boolean; tools: number; promptMatched: boolean; outcome: string }[] = [];
  const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  const nativePids = new Set<number>();
  let host: ReturnType<typeof startHost> | undefined, originalFailure: unknown;
  let passed = false, cleanup = false, nativeCredentialCount = 0;
  const cleanupErrors: unknown[] = [];
  async function children(): Promise<number[]> {
    const pid = host?.facts().pid;
    assert.ok(pid);
    const found: number[] = [];
    for (const candidate of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      const stat = await readFile(`/proc/${candidate}/stat`, 'utf8').catch(() => undefined);
      if (!stat) continue;
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
      if (Number(fields[1]) === pid && fields[0] !== 'Z') found.push(Number(candidate));
    }
    return found;
  }
  async function observeNative(expected = 1): Promise<void> {
    const original = await children();
    assert.equal(original.length, expected, 'the Host owns only its catalog and current finite operation');
    for (const pid of original) {
      assert.equal(await fileHash(`/proc/${pid}/exe`), digests.bun);
      nativePids.add(pid);
    }
  }
  const model = createServer((request, response) => {
    void (async () => {
      assert.equal(failures.length, 0);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const data = Buffer.from(chunk as Uint8Array);
        bytes += data.length;
        assert.ok(bytes <= 1024 * 1024);
        chunks.push(data);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.equal(body.model, 'TEST-model');
      assert.equal(body.reasoning_effort, undefined, 'verification fallback does not inherit the captured variant');
      assert.ok(body.tools === undefined || Array.isArray(body.tools) && body.tools.length === 0);
      const refused = requests.length === 0, timedOut = requests.length === 3;
      const authorizationMatched = request.headers.authorization === 'Bearer ' + (refused ? rejectedKey : selectedKey);
      const promptMatched = JSON.stringify(body.messages).includes(
        'Reply only OK. Do not use tools, access files or run commands.');
      assert.equal(authorizationMatched, true);
      assert.equal(promptMatched, true);
      for (const privateValue of [selectedKey, rejectedKey, foreignKey, 'agentTeamsCredential', 'scopeDigest', 'credentialId'])
        assert.equal(text.includes(privateValue), false, 'credential witnesses never enter model context');
      assert.ok(requests.length < 4, 'readback/reconnect cannot cause native inference replay');
      await observeNative(requests.length === 2 ? 2 : 1);
      requests.push({ authorizationMatched, tools: 0, promptMatched,
        outcome: refused ? 'refused' : timedOut ? 'timeout' : 'OK' });
      if (refused) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'TEST controlled model refusal',
          type: 'authentication_error', code: 'invalid_api_key' } }));
        return;
      }
      if (timedOut) {
        // The original native request is observed, but no terminal response is
        // supplied. Its captured deadline and original child cleanup must settle it.
        await new Promise<void>(done => response.once('close', done));
        return;
      }
      const event = (delta: Record<string, unknown>, finish: string | null) => ({
        id: 'TEST-native-v2-key-reply', object: 'chat.completion.chunk', created: 1700000000,
        model: 'TEST-model', choices: [{ index: 0, delta, finish_reason: finish }],
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(event({ role: 'assistant', content: 'OK' }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(event({}, 'stop'))}\n\n`);
      response.end('data: [DONE]\n\n');
    })().catch(() => {
      failures.push('TEST_native_key_model_request_refused');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST native key oracle refused request');
    });
  });
  try {
    for (const name of ['workspace', 'home', 'config', 'data', 'cache', 'tmp', 'store'])
      await mkdir(join(root, name), { mode: 0o700 });
    await mkdir(join(root, 'data/opencode'), { mode: 0o700 });
    const authPath = join(root, 'data/opencode/auth.json');
    const foreign = { 'TEST-foreign': { type: 'api', key: foreignKey } };
    await writeFile(authPath, JSON.stringify(foreign), { mode: 0o600 });
    await new Promise<void>(done => model.listen(0, '127.0.0.1', done));
    const address = model.address();
    assert.ok(address && typeof address !== 'string');
    const profile: TeamHostProfile = {
      schemaVersion: 1, principalId: 'TEST-human', teams: [],
      owner: { ownerId: 'TEST-key-owner', revision: 'TEST-owner-v1', profileId: 'TEST-host',
        storageRoot: join(root, 'store'), protocolVersion: 1, buildId: 'TEST-native-v2-credentials',
        nodeSha256: digests.node, hostEntrySha256: await fileHash(entry) },
      management: [{ provider: 'opencode', profileId: 'TEST-management', configRevision: 'TEST-config',
        nativeGeneration: 'v2', protocolRevision: '2.1.4', accountBinding: 'TEST-account',
        cwd: join(root, 'workspace'), executable: { path: bun, sha256: digests.bun },
        endpoint: `http://127.0.0.1:${address.port}`, timeoutMs: 30000, modelProbeTimeoutMs: 30000,
        nativeModel: { providerId: 'TEST-local', modelId: 'TEST-unavailable-model' }, variant: 'high',
        environment: { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
          XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'), PATH: `${dirname(node)}:/usr/bin:/bin`, NO_COLOR: '1' },
        embedded: { version: '2.1.4', platform: 'linux', arch: 'x64', directory: engine,
          manifestSha256: digests.manifest, externalDirectory: 'deny',
          providerConfiguration: { package: 'aisdk:@ai-sdk/openai-compatible',
            // Only native credential connection can supply the Authorization header.
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
            models: { 'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 128 },
              capabilities: { tools: true, input: ['text'], output: ['text'] } } } } },
      }],
    };
    const profilePath = join(root, 'profile.json');
    await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
    const profileHash = await fileHash(profilePath);
    const start = async () => {
      await assertNativeV1Build(repo, sourceHead, build);
      host = startHost({ node, entry, root, profile: profilePath, profileHash });
      await host.rpc('host.handshake', { protocolVersion: 1 });
    };
    const stop = async () => {
      assert.ok(host);
      await host.close();
      hosts.push(host.facts());
      host = undefined;
      for (const pid of nativePids) assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
    };
    const target = { profileId: 'TEST-management', configRevision: 'TEST-config' };
    const directory = async () => value<ProviderManagementCatalog>(await host!.rpc('management.catalog', target));
    const selected = (catalog: ProviderManagementCatalog) => {
      const found = catalog.providers.find(row => row.providerId === 'TEST-local');
      assert.ok(found);
      for (const key of [selectedKey, rejectedKey, foreignKey]) assert.equal(JSON.stringify(catalog).includes(key), false);
      return found;
    };
    const pending = { ...target, providerId: 'TEST-local' };
    const connect = { ...pending, commandId: 'TEST-key-connect', kind: 'credential.set', key: selectedKey };
    await start();
    const before = await directory();
    assert.deepEqual(before.runtime, { generation: 'v2', version: '2.1.4' });
    assert.ok(before.providers.length > 1, 'the passive native directory includes other integrations');
    assert.equal(selected(before).connected, false);
    assert.deepEqual(selected(before).authMethods, ['api']);
    assert.equal(requests.length, 0);
    await observeNative();
    steps.push('passive_all_provider_directory_without_import_or_inference');
    const rejected = { ...connect, commandId: 'TEST-rejected-connect', key: rejectedKey };
    const rejectedReceipt = value<ProviderCredentialReceipt>(await host!.rpc('management.credential', rejected));
    assert.equal(rejectedReceipt.phase, 'held');
    assert.equal(rejectedReceipt.reason, 'verification-rejected');
    assert.equal(requests.length, 1);
    assert.deepEqual(value(await host!.rpc('management.credential.pending', pending)),
      { generation: 'v2', receipt: null });
    const rejectedCatalog = selected(await directory());
    assert.equal(rejectedCatalog.configured, true);
    assert.equal(rejectedCatalog.connected, false);
    await observeNative();
    await stop();
    await start();
    // A confirmed owned publication + qualified failed terminal admits an
    // explicit corrected key. This cannot authorize overwriting a foreign key.
    // Drop the original application acknowledgement; reconciliation uses its exact intent only.
    value<ProviderCredentialReceipt>(await host!.rpc('management.credential', connect));
    const original = value<ProviderCredentialReceipt>(await host!.rpc('management.credential.resume', connect));
    assert.equal(original.phase, 'completed');
    assert.deepEqual(value(await host!.rpc('management.credential', connect)), original);
    assert.deepEqual(await host!.rpc('management.credential.resume', { ...connect, key: 'TEST-changed-key' }),
      { ok: false, code: 'conflict' });
    assert.equal(requests.length, 2);
    assert.deepEqual(await children(), []);
    assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {
      ...foreign, 'TEST-local': { type: 'api', key: selectedKey } });
    steps.push('native_key_one_verification_original_receipt_after_lost_ack');
    steps.push('native_401_saved_unverified_then_cold_explicit_corrected_key_succeeds');
    await stop();
    await start();
    assert.deepEqual(value(await host!.rpc('management.credential.resume', connect)), original);
    const after = selected(await directory());
    assert.equal(after.source, 'api');
    assert.equal(after.configured, true);
    assert.equal(after.connected, true);
    assert.equal(requests.length, 2, 'cold inventory/readback cannot verify the model again');
    await observeNative();
    // Use the stored key in an explicit later Check, with no key in the request.
    const probe = { ...pending, commandId: 'TEST-saved-key-check', modelId: 'TEST-local/TEST-model' };
    const lookup = { ...target, commandId: probe.commandId };
    value<ProviderModelProbeSnapshot>(await host!.rpc('management.probe.start', probe));
    let snapshot: ProviderModelProbeSnapshot;
    const deadline = Date.now() + 45000;
    do {
      await tick();
      snapshot = value(await host!.rpc('management.probe.read', lookup));
    } while (snapshot.phase === 'running' && Date.now() < deadline);
    assert.equal(snapshot.phase, 'completed');
    assert.equal(snapshot.ok, true);
    assert.equal(requests.length, 3);
    steps.push('cold_directory_and_explicit_check_reuse_saved_selected_key');
    // A fresh explicit intent may follow completion, even for the same key.
    // A timed-out verification retains that new intent across restart.
    const unverified = { ...connect, commandId: 'TEST-unverified-connect' };
    const retained = value<ProviderCredentialReceipt>(await host!.rpc('management.credential', unverified));
    assert.equal(retained.phase, 'held');
    assert.equal(retained.reason, undefined, 'timeout never becomes confirmed credential rejection');
    assert.equal(requests.length, 4);
    assert.deepEqual(await children(), []);
    await stop();
    await start();
    assert.deepEqual(value(await host!.rpc('management.credential.pending', pending)),
      { generation: 'v2', receipt: retained });
    assert.deepEqual(value(await host!.rpc('management.credential.resume', unverified)), retained);
    for (const changed of [{ ...unverified, key: 'TEST-changed-key' },
      { ...unverified, commandId: 'TEST-unsafe-new-intent' }])
      assert.deepEqual(await host!.rpc('management.credential', changed), { ok: false, code: 'conflict' });
    assert.deepEqual(await children(), []);
    assert.equal(requests.length, 4);
    const unverifiedCatalog = selected(await directory());
    assert.equal(unverifiedCatalog.configured, true);
    assert.equal(unverifiedCatalog.connected, false, 'an old success cannot hide a newer unverified intent');
    await observeNative();
    assert.equal(requests.length, 4);
    steps.push('cold_unverified_original_intent_blocks_changed_key_and_new_id_without_replay');
    await stop();
    const namespaces = (await readdir(join(root, 'data'))).filter(name => name.startsWith('agent-teams-v2-key-'));
    assert.equal(namespaces.length, 3);
    const nativeKeys: string[] = [];
    for (const namespace of namespaces) {
      const database = new DatabaseSync(join(root, 'data', namespace, 'catalog.sqlite'), { readOnly: true });
      try {
        const rows = database.prepare('SELECT integration_id, value FROM credential').all();
        assert.equal(rows.length, 1, 'one native key effect per original credential intent');
        assert.equal(rows[0]!.integration_id, 'TEST-local', 'ambient migration never imports foreign keys');
        const credential = JSON.parse(String(rows[0]!.value)) as Record<string, unknown>;
        assert.equal(credential.type, 'key');
        assert.ok(credential.key === selectedKey || credential.key === rejectedKey);
        nativeKeys.push(credential.key as string);
        nativeCredentialCount += rows.length;
      } finally { database.close(); }
    }
    assert.deepEqual(nativeKeys.sort(), [rejectedKey, selectedKey, selectedKey].sort());
    for (const name of await readdir(join(root, 'store/management-commands'))) {
      const body = await readFile(join(root, 'store/management-commands', name), 'utf8');
      for (const key of [selectedKey, rejectedKey, foreignKey]) assert.equal(body.includes(key), false);
    }
    steps.push('selected_native_db_only_foreign_auth_preserved_secret_free_receipts');
    assert.ok(hosts.every(row => row.exitCode === 0 && row.signalCode === null && row.stdoutValid));
    assert.deepEqual(failures, []);
    await assertNativeV1Build(repo, sourceHead, build);
    passed = true;
  } catch (error) { originalFailure = error; }
  finally {
    if (host) try { await host.close(); hosts.push(host.facts()); } catch (error) { cleanupErrors.push(error); }
    model.closeAllConnections();
    await new Promise<void>(done => model.close(() => done()));
    for (const pid of nativePids) try {
      assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
    } catch (error) { cleanupErrors.push(error); }
    if (failures.length) originalFailure ??= Error('TEST native key oracle refused request');
    cleanup = cleanupErrors.length === 0;
    if (cleanup) try { await rm(root, { recursive: true, force: true }); }
    catch (error) { cleanup = false; cleanupErrors.push(error); }
    try {
      await writeFile(receiptPath, JSON.stringify({ kind: 'TEST_NATIVE_V2_CREDENTIAL', sourceHead,
        status: passed && cleanup && !originalFailure ? 'PASS' : 'INCOMPLETE', cleanup, version: '2.1.4',
        digests, steps, requests, nativeCredentialCount, nativeProcessCount: nativePids.size,
        hosts: hosts.map(({ exitCode, signalCode, stdoutValid }) => ({ exitCode, signalCode, stdoutValid })),
        vendorAuthQualified: false, desktopQualified: false, releaseQualified: false }, null, 2) + '\n', { mode: 0o600 });
    } catch (error) { cleanupErrors.push(error); }
  }
  if (originalFailure && cleanupErrors.length) throw new AggregateError([originalFailure, ...cleanupErrors], 'TEST credential and cleanup failed');
  if (originalFailure) throw originalFailure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'TEST credential cleanup failed');
});
