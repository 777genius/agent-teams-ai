import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createOpenCodeV2OwnedSessionClient } from '@agent-teams/provider-implementations/opencode';

import { captureOpenCodeV2SessionCredential } from '../dist/adapters/providers/OpenCodeV2SessionCredential.js';
import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { OpenCodeV2CredentialScope } from '../dist/adapters/providers/OpenCodeV2CredentialScope.js';
import { AcceptedOpenCodeV2FileKey, createOpenCodeV2FileMaterialization,
  openCodeV2SelectedSourceReference, selectedFilePaths,
} from '../dist/adapters/providers/OpenCodeV2SelectedFileKey.js';
import { OpenCodeV2ManagementHost } from '../dist/adapters/providers/OpenCodeV2ManagementHost.js';
import { openCodeManagementProfileSchema } from '../dist/management/profile.js';
import type { OpenCodeManagementProfile } from '../dist/management/profile.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-credential-scope-')));
  const home = join(root, 'home'), data = join(root, 'data'), store = join(data, 'opencode');
  for (const path of [home, data, store]) mkdirSync(path, { mode: 0o700 });
  const file = join(store, 'auth.json');
  const selected = { environment: { HOME: home, XDG_DATA_HOME: data }, accountBinding: 'TEST-account' };
  let current = true;
  return {
    root, home, data, store, file, profile: selected,
    scope: () => new OpenCodeV2CredentialScope(selected, 'TEST-provider', () => current),
    write: (value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }),
    revoke: () => { current = false; },
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}

test('V2 key publication survives a fresh scope, preserves foreign credentials and only rolls back its own entry', async t => {
  const f = fixture(); t.after(f.cleanup);
  const foreign = { type: 'oauth', access: 'TEST-foreign-token', refresh: 'TEST-foreign-refresh', expires: 123 };
  f.write({ 'TEST-other': foreign });
  const scope = f.scope(), pending = scope.prepare('TEST-private-key'), after = pending.publish();
  assert.equal(pending.before.isCurrent(), false);
  assert.equal(after.readKey(), 'TEST-private-key');
  assert.equal(f.scope().capture().readKey(), 'TEST-private-key');
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    'TEST-other': foreign, 'TEST-provider': { type: 'api', key: 'TEST-private-key' },
  });
  assert.equal(JSON.stringify(after).includes('TEST-private-key'), false);
  assert.throws(() => pending.publish(), { code: 'held' });
  scope.rollbackPublished('TEST-private-key', after, pending.before);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { 'TEST-other': foreign });
  assert.equal(f.scope().capture().present, false);
  const rejected = scope.prepare('TEST-rejected-key').publish();
  assert.throws(() => scope.prepare('TEST-corrected-key'), { code: 'held' });
  assert.throws(() => scope.prepare('TEST-corrected-key', after.digest), { code: 'held' });
  const corrected = scope.prepare('TEST-corrected-key', rejected.digest).publish();
  assert.equal(corrected.readKey(), 'TEST-corrected-key');
  assert.equal(rejected.isCurrent(), false);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    'TEST-other': foreign, 'TEST-provider': { type: 'api', key: 'TEST-corrected-key' },
  });

  const originalAuth = readFileSync(f.file);
  // Real pinned protocol clients against a finite TEST peer; no native engine is claimed.
  for (const mode of ['configured', 'absent', 'explicit', 'missing', 'foreign',
    'foreign-scope', 'explicit-foreign', 'explicit-scope', 'config-literal', 'config-env', 'config-file'] as const) {
    const explicit = mode.startsWith('explicit');
    const fromConfig = mode.startsWith('config-');
    const integrationId = explicit ? 'TEST-explicit' : 'TEST-provider';
    const accepted = mode === 'configured' || mode === 'absent' || mode === 'explicit' || fromConfig;
    const effectiveKey = fromConfig ? 'TEST-config-original-key' : 'TEST-corrected-key';
    let configProfile: OpenCodeManagementProfile | undefined, managedKey: string | undefined;
    if (fromConfig) {
      const cwd = join(f.root, mode); mkdirSync(cwd, { mode: 0o700 });
      const leaf = join(cwd, 'opencode.json');
      const owned = join(f.home, '.config/opencode/agent-teams-credentials');
      mkdirSync(owned, { recursive: true, mode: 0o700 });
      managedKey = join(owned, 'TEST-provider-' + createHash('sha256').update(leaf).digest('hex').slice(0, 16) + '.key');
      writeFileSync(managedKey, effectiveKey, { mode: 0o600 });
      writeFileSync(leaf, JSON.stringify({ provider: { 'TEST-provider': {
        npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:12345/v1',
          apiKey: mode === 'config-file' ? '{file:' + managedKey + '}'
            : mode === 'config-env' ? '{env:TEST_CONFIG_KEY}' : effectiveKey },
      } } }), { mode: 0o600 });
      configProfile = { ...f.profile, cwd, environment: { ...f.profile.environment,
        XDG_CONFIG_HOME: join(f.home, '.config'), TEST_CONFIG_KEY: effectiveKey },
        provider: 'opencode', profileId: 'TEST-config-profile', configRevision: 'TEST-config-revision',
        executable: { path: process.execPath, sha256: 'a'.repeat(64) }, endpoint: 'http://127.0.0.1:12345',
        timeoutMs: 5000, nativeGeneration: 'v2', protocolRevision: '2.1.4',
        nativeModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
        embedded: { version: '2.1.4', directory: f.root, manifestSha256: 'b'.repeat(64),
          platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
          arch: process.arch === 'arm64' ? 'arm64' : 'x64', externalDirectory: 'deny' },
      };
      configProfile.embedded!.configurationSource = captureOpenCodeConfigurationSource(configProfile).reference;
    }
    const nativeDirectory = configProfile?.cwd ?? f.root;
    const requests: string[] = [], failures: unknown[] = [];
    let connected = false, coldRead = false;
    const server = createServer((request, response) => {
      void (async () => {
        assert.ok(requests.length < (coldRead ? 18 : 10), 'one finite preparation and original cold read, with no replay');
        const url = new URL(request.url!, 'http://127.0.0.1');
        requests.push(request.method + ' ' + url.pathname);
        assert.deepEqual([...url.searchParams], [['location[directory]', nativeDirectory]]);
        assert.equal(request.headers.authorization,
          'Basic ' + Buffer.from('opencode:TEST-server-password').toString('base64'));
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const value = Buffer.from(chunk);
          bytes += value.length;
          assert.ok(bytes <= 1024, 'TEST request body is bounded');
          chunks.push(value);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (request.method === 'POST') {
          assert.equal(url.pathname, '/api/integration/' + integrationId + '/connect/key');
          assert.equal(accepted, true, 'refused integration cannot receive a key');
          assert.equal(connected, false, 'only one original key connect');
          assert.deepEqual(JSON.parse(body), { key: effectiveKey });
          connected = true;
          response.writeHead(204); response.end(); return;
        }
        assert.equal(request.method, 'GET');
        assert.equal(body, '');
        let data: unknown;
        let directory = nativeDirectory;
        if (url.pathname === '/api/provider') data = mode === 'absent' ? [] : [{
          id: 'TEST-provider', name: 'TEST provider', activation: 'enabled',
          ...(explicit ? { integrationID: integrationId } : {}),
        }];
        else if (url.pathname === '/api/model') data = [];
        else if (url.pathname === '/api/model/default') data = null;
        else if (url.pathname === '/api/integration') {
          assert.equal(explicit, false, 'an explicit native reference never falls back');
          data = mode === 'missing' ? [] : [{
            id: mode === 'foreign' ? 'TEST-other' : 'TEST-provider',
            name: 'TEST integration', methods: [{ type: 'key' }],
          }];
          if (mode === 'foreign-scope') directory = join(f.root, 'TEST-foreign');
        } else {
          assert.equal(url.pathname, '/api/integration/' + integrationId);
          data = {
            id: mode === 'explicit-foreign' ? 'TEST-other' : integrationId,
            name: 'TEST integration', methods: [{ type: 'key' }],
            connections: connected ? [{ type: 'credential', id: 'cred_TEST', method: 'key' }] : [],
          };
          if (mode === 'explicit-scope') directory = join(f.root, 'TEST-foreign');
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ location: { directory }, data }));
      })().catch(error => {
        failures.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    let owner: ReturnType<typeof createOpenCodeV2OwnedSessionClient> | undefined;
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const config = { endpoint: 'http://127.0.0.1:' + address.port, directory: nativeDirectory,
        version: '2.1.4' as const, signal: t.signal, deadline: Date.now() + 5000,
        readPassword: () => 'TEST-server-password' };
      owner = createOpenCodeV2OwnedSessionClient({ ...config, nativeSessionId: 'ses_TEST' });
      const originalConfiguration = configProfile ? captureOpenCodeV2Configuration(configProfile,
        { providerId: 'TEST-provider', modelId: 'TEST-model' }, () => true) : undefined;
      const prepared = captureOpenCodeV2SessionCredential(configProfile ?? f.profile, 'TEST-provider',
        originalConfiguration?.isCurrent ?? (() => true), originalConfiguration?.key);
      const original = prepared.prepare(config, owner);
      assert.equal(prepared.prepare(config, owner), original, 'same original pending Promise');
      if (accepted) {
        assert.deepEqual(await original, { scopeDigest: originalConfiguration?.key?.digest ?? f.scope().capture().digest,
          credentialId: 'cred_TEST' });
        assert.equal(await prepared.prepare(config, owner), await original);
      } else {
        const code = mode === 'foreign-scope' ? 'native_catalog_binding_mismatch'
          : explicit ? 'invalid_native_integration' : 'held';
        await assert.rejects(original, { code });
        assert.equal(prepared.prepare(config, owner), original, 'refusal cannot retry native preparation');
      }
      const catalog = ['GET /api/provider', 'GET /api/model', 'GET /api/model/default'];
      const selection = explicit ? catalog : [...catalog, ...catalog, 'GET /api/integration'];
      const keyRead = 'GET /api/integration/' + integrationId;
      assert.deepEqual(requests, [...selection,
        ...(accepted ? [keyRead, 'POST /api/integration/' + integrationId + '/connect/key', keyRead]
          : explicit ? [keyRead] : [])], mode);
      assert.equal(connected, accepted);
      assert.deepEqual(failures, [], 'TEST peer accepted only the original finite protocol');
      assert.deepEqual(readFileSync(f.file), originalAuth, 'native preparation never rewrites source auth');
      if (configProfile) {
        const witness = await original; assert.ok(witness);
        const selected = { providerId: 'TEST-provider', modelId: 'TEST-model' };
        const coldConfig = captureOpenCodeV2Configuration(configProfile, selected, () => true);
        const restored = { id: 'ses_TEST', directory: nativeDirectory, agent: 'TEST-agent',
          model: { providerID: 'TEST-provider', id: 'TEST-model' },
          permissions: [{ action: '*', resource: '*', effect: 'deny' as const }], credential: witness };
        const cold = captureOpenCodeV2SessionCredential(configProfile, 'TEST-provider', coldConfig.isCurrent, coldConfig.key);
        coldRead = true; // The original ten-request preparation has already passed every assertion above.
        assert.deepEqual(await cold.prepare(config, owner, restored), witness);
        assert.equal(requests.length, 18, 'cold uses only the original finite catalog/integration reads');
        assert.equal(requests.filter(row => row.startsWith('POST ')).length, 1);
        if (mode === 'config-file') {
          writeFileSync(managedKey!, 'TEST-changed-file-key', { mode: 0o600 });
          assert.equal(originalConfiguration!.isCurrent(), false);
          const changed = captureOpenCodeV2Configuration(configProfile, selected, () => true);
          const refused = captureOpenCodeV2SessionCredential(configProfile, 'TEST-provider', changed.isCurrent, changed.key);
          await assert.rejects(refused.prepare(config, owner, restored), { code: 'held' });
          assert.equal(requests.length, 18, 'changed original file cannot reconnect or read a foreign cold credential');
        }
        assert.deepEqual(readFileSync(f.file), originalAuth);
        assert.deepEqual(failures, []);
      }
    } finally {
      try { await owner?.dispose(); }
      finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }

  // Real D source requests, with an explicitly synthetic native issuer. No engine/OS proof is claimed.
  for (const mode of ['valid', 'missing-proof', 'malformed-proof', 'foreign-reference', 'lost-ack', 'cold-id', 'cold-file'] as const) {
    const cwd = join(f.root, 'manual-' + mode); mkdirSync(cwd, { mode: 0o700 });
    const leaf = join(cwd, 'opencode.json'), file = join(cwd, 'original.key'), effectiveKey = 'TEST-native-manual-key';
    writeFileSync(file, effectiveKey, { mode: 0o600 });
    writeFileSync(leaf, JSON.stringify({ provider: { 'TEST-provider': {
      npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:12345/v1', apiKey: '{file:original.key}' },
    } } }), { mode: 0o600 });
    const profile: OpenCodeManagementProfile = { ...f.profile, cwd,
      environment: { ...f.profile.environment, USERPROFILE: f.home, XDG_CONFIG_HOME: join(f.home, '.config') },
      provider: 'opencode', profileId: 'TEST-manual-profile', configRevision: 'TEST-manual-config',
      executable: { path: process.execPath, sha256: 'a'.repeat(64) }, endpoint: 'http://127.0.0.1:12345',
      timeoutMs: 5000, nativeGeneration: 'v2', protocolRevision: '2.1.4',
      nativeModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
      embedded: { version: '2.1.4', directory: f.root, manifestSha256: 'b'.repeat(64),
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        arch: process.arch === 'arm64' ? 'arm64' : 'x64', externalDirectory: 'deny' },
    };
    profile.embedded!.configurationSource = captureOpenCodeConfigurationSource(profile).reference;
    const selection = { providerId: 'TEST-provider', modelId: 'TEST-model' };
    const configuration = captureOpenCodeV2Configuration(profile, selection, () => true), source = configuration.selectedFile;
    assert.ok(source); assert.equal(configuration.key, undefined);
    const requests: string[] = [], failures: unknown[] = [];
    let coldRead = false, connected = false, materializations = 0;
    const issuer = (restoring: boolean) => ({ nonce: 'c'.repeat(64), pid: process.pid, integrationId: selection.providerId,
      reference: openCodeV2SelectedSourceReference(source.descriptor, 'c'.repeat(64), selection.providerId, restoring ? 'restore' : 'fresh') });
    const issue = () => {
      materializations++;
      const materializer = createOpenCodeV2FileMaterialization(source.descriptor, () => {});
      const key = materializer.readFileString(selectedFilePaths(source.descriptor)[0]!).trim();
      assert.equal(materializer.materializedKey(key), coldRead && mode === 'cold-file' ? effectiveKey + '-changed' : effectiveKey);
      return materializer.issue(key, issuer(coldRead));
    };
    assert.equal(materializations, 0, 'captured manual configuration cannot materialize in F before its native request');
    const server = createServer((request, response) => {
      void (async () => {
        assert.ok(requests.length < (coldRead ? 18 : 10), 'same ten initial requests, then original eight cold reads');
        const url = new URL(request.url!, 'http://127.0.0.1');
        requests.push(request.method + ' ' + url.pathname);
        assert.deepEqual([...url.searchParams], [['location[directory]', cwd]]);
        assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('opencode:TEST-server-password').toString('base64'));
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) { const next = Buffer.from(chunk); bytes += next.length;
          assert.ok(bytes <= 1024); chunks.push(next); }
        const body = Buffer.concat(chunks).toString('utf8');
        if (request.method === 'POST') {
          assert.equal(url.pathname, '/api/integration/TEST-provider/connect/key');
          assert.equal(coldRead, false); assert.equal(connected, false);
          const selected = JSON.parse(body);
          assert.deepEqual(Object.keys(selected), ['selectedSource']);
          assert.deepEqual(Object.keys(selected.selectedSource), ['schemaVersion', 'reference', 'deadline']);
          assert.equal(selected.selectedSource.schemaVersion, 1);
          assert.equal(selected.selectedSource.reference, issuer(false).reference);
          assert.ok(selected.selectedSource.deadline > Date.now());
          assert.equal(body.includes(effectiveKey), false);
          const witness = issue(); connected = true;
          if (mode === 'lost-ack') { response.destroy(); return; }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ schemaVersion: 1,
            sourceReference: mode === 'foreign-reference' ? 'e'.repeat(64) : issuer(false).reference,
            ...(mode === 'missing-proof' ? {} : { witness: mode === 'malformed-proof' ? Buffer.from('x').toString('base64url') : witness }),
          })); return;
        }
        assert.equal(request.method, 'GET'); assert.equal(body, '');
        let data: unknown;
        if (url.pathname === '/api/provider') data = [{ id: 'TEST-provider', name: 'TEST provider', activation: 'enabled' }];
        else if (url.pathname === '/api/model') data = [];
        else if (url.pathname === '/api/model/default') data = null;
        else if (url.pathname === '/api/integration') data = [{ id: 'TEST-provider', name: 'TEST integration', methods: [{ type: 'key' }] }];
        else {
          assert.equal(url.pathname, '/api/integration/TEST-provider');
          data = { id: 'TEST-provider', name: 'TEST integration', methods: [{ type: 'key' }],
            connections: connected ? [{ type: 'credential', id: coldRead && mode === 'cold-id' ? 'cred_FOREIGN' : 'cred_TEST', method: 'key' }] : [] };
        }
        const integration = { location: { directory: cwd }, data };
        response.writeHead(200, { 'content-type': 'application/json' });
        if (coldRead && url.pathname === '/api/integration/TEST-provider') {
          assert.equal(request.headers['x-agent-teams-selected-source'], 'v1:' + issuer(true).reference);
          assert.ok(Number(request.headers['x-agent-teams-selected-source-deadline']) > Date.now());
          response.end(JSON.stringify({ schemaVersion: 1, sourceReference: issuer(true).reference, witness: issue(), integration }));
        } else response.end(JSON.stringify(integration));
      })().catch(error => { failures.push(error); if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    let owner: ReturnType<typeof createOpenCodeV2OwnedSessionClient> | undefined;
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const transport = { endpoint: 'http://127.0.0.1:' + address.port, directory: cwd, version: '2.1.4' as const,
        signal: t.signal, deadline: Date.now() + 5000, readPassword: () => 'TEST-server-password' };
      owner = createOpenCodeV2OwnedSessionClient({ ...transport, nativeSessionId: 'ses_TEST' });
      const prepared = captureOpenCodeV2SessionCredential(profile, selection.providerId, configuration.isCurrent, undefined, source);
      type Binding = NonNullable<Parameters<typeof prepared.prepare>[3]>;
      const originalBinding: Binding = id => {
        assert.equal(id, selection.providerId);
        const expected = issuer(false);
        return { reference: expected.reference, acceptProof: proof => {
          assert.equal(proof.sourceReference, expected.reference);
          return AcceptedOpenCodeV2FileKey.accept(source, proof.witness, expected, configuration.isCurrent);
        } };
      };
      const original = prepared.prepare(transport, owner, undefined, originalBinding);
      assert.equal(prepared.prepare(transport, owner, undefined, originalBinding), original);
      const success = mode === 'valid' || mode === 'cold-id' || mode === 'cold-file';
      if (!success) await assert.rejects(original, { code: mode === 'lost-ack' ? 'native_credential_request_failed'
        : mode === 'malformed-proof' ? 'native_source_proof_refused' : 'invalid_native_source_proof', disposition: 'unknown' });
      else {
        const result = await original; assert.ok(result);
        assert.equal(result.credentialId, 'cred_TEST'); assert.equal(result.scopeDigest, prepared.fileProof()?.scopeDigest);
      }
      const selectionCalls = ['GET /api/provider', 'GET /api/model', 'GET /api/model/default',
        'GET /api/provider', 'GET /api/model', 'GET /api/model/default', 'GET /api/integration'];
      const keyRead = 'GET /api/integration/TEST-provider';
      assert.deepEqual(requests, [...selectionCalls, keyRead, 'POST /api/integration/TEST-provider/connect/key', ...(success ? [keyRead] : [])]);
      assert.equal(materializations, 1); assert.equal(connected, true); assert.deepEqual(failures, []);
      assert.equal(prepared.prepare(transport, owner, undefined, originalBinding), original, 'no retry after a lost or rejected proof');
      assert.deepEqual(readFileSync(f.file), originalAuth);
      if (success) {
        const witness = await original; assert.ok(witness);
        if (mode === 'cold-file') writeFileSync(file, effectiveKey + '-changed', { mode: 0o600 });
        const coldConfiguration = captureOpenCodeV2Configuration(profile, selection, () => true), coldSource = coldConfiguration.selectedFile;
        assert.ok(coldSource);
        const cold = captureOpenCodeV2SessionCredential(profile, selection.providerId, coldConfiguration.isCurrent, undefined, coldSource);
        const restored = { id: 'ses_TEST', directory: cwd, agent: 'TEST-agent',
          model: { providerID: 'TEST-provider', id: 'TEST-model' },
          permissions: [{ action: '*', resource: '*', effect: 'deny' as const }], credential: witness };
        coldRead = true; // Only after the original complete preparation passed its ten-request oracle.
        const result = cold.prepare(transport, owner, restored, id => {
          assert.equal(id, selection.providerId); const expected = issuer(true);
          return { reference: expected.reference, acceptProof: proof => AcceptedOpenCodeV2FileKey.accept(
            coldSource, proof.witness, expected, coldConfiguration.isCurrent) };
        });
        if (mode === 'valid') assert.deepEqual(await result, witness);
        else await assert.rejects(result, { code: 'held' });
        assert.deepEqual(requests, [...selectionCalls, keyRead, 'POST /api/integration/TEST-provider/connect/key', keyRead,
          ...selectionCalls, keyRead]);
        assert.equal(requests.length, 18); assert.equal(requests.filter(row => row.startsWith('POST ')).length, 1);
        assert.equal(materializations, 2); assert.deepEqual(failures, []); assert.deepEqual(readFileSync(f.file), originalAuth);
      }
    } finally {
      try { await owner?.dispose(); }
      finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())); }
    }
  }

  // Real Host catalog/key selectors and pinned protocol clients; only original native
  // launch/custody admission is synthetic. This does not qualify an engine or OS owner.
  for (const mode of ['same-id', 'integration-only', 'explicit', 'explicit-foreign', 'missing',
    'unrelated', 'form', 'null', 'empty', 'numeric', 'excluded'] as const) {
    const providerId = mode === 'excluded' ? 'exa' : 'TEST-provider';
    const explicit = mode === 'explicit' || mode === 'explicit-foreign';
    const integrationId = explicit ? 'TEST-explicit' : providerId;
    const malformed = mode === 'null' || mode === 'empty' || mode === 'numeric';
    const accepted = mode === 'same-id' || mode === 'integration-only' || mode === 'explicit';
    const requests: string[] = [], failures: unknown[] = [], selectedIds: string[] = [];
    let connected = false;
    const server = createServer((request, response) => {
      void (async () => {
        assert.ok(requests.length < 19, 'one catalog and one explicit key operation, without replay');
        const url = new URL(request.url!, 'http://127.0.0.1');
        requests.push(request.method + ' ' + url.pathname);
        assert.deepEqual([...url.searchParams], ['/api/info', '/api/permission/saved'].includes(url.pathname)
          ? [] : [['location[directory]', f.root]]);
        assert.equal(request.headers.authorization,
          'Basic ' + Buffer.from('opencode:TEST-server-password').toString('base64'));
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const value = Buffer.from(chunk); bytes += value.length;
          assert.ok(bytes <= 1024, 'TEST request body is bounded');
          chunks.push(value);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (request.method === 'POST') {
          assert.equal(url.pathname, '/api/integration/' + integrationId + '/connect/key');
          assert.equal(accepted, true, 'refused selection or form cannot receive a key');
          assert.equal(connected, false, 'exactly one original key POST');
          assert.deepEqual(JSON.parse(body), { key: 'TEST-corrected-key' });
          connected = true; response.writeHead(204); response.end(); return;
        }
        assert.equal(request.method, 'GET'); assert.equal(body, '');
        let data: unknown;
        if (url.pathname === '/api/info') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ pid: process.pid, version: '2.1.4' })); return;
        }
        if (url.pathname === '/api/plugin' || url.pathname === '/api/permission/saved' ||
            url.pathname === '/api/mcp' || url.pathname === '/api/model') data = [];
        else if (url.pathname === '/api/model/default') data = null;
        else if (url.pathname === '/api/provider') data = mode === 'integration-only' ? [] : [{
          id: providerId, name: 'TEST provider', activation: 'enabled',
          ...(explicit ? { integrationID: integrationId } : malformed
            ? { integrationID: mode === 'null' ? null : mode === 'empty' ? '' : 7 } : {}),
        }];
        else if (url.pathname === '/api/integration') {
          const method = { type: 'key', ...(mode === 'form' ? { form: {} } : {}) };
          data = mode === 'missing' ? [] : mode === 'explicit'
            ? [{ id: providerId, name: 'TEST distractor', methods: [{ type: 'oauth' }] },
              { id: integrationId, name: 'TEST integration', methods: [method] }]
            : [{ id: mode === 'unrelated' ? 'TEST-other' : providerId,
              name: 'TEST integration', methods: [method] }];
        } else {
          assert.equal(url.pathname, '/api/integration/' + integrationId,
            'an explicit native ID never falls back to the same-ID distractor');
          data = { id: mode === 'explicit-foreign' ? providerId : integrationId,
            name: 'TEST integration', methods: [{ type: 'key', ...(mode === 'form' ? { form: {} } : {}) }],
            connections: connected ? [{ type: 'credential', id: 'cred_TEST', method: 'key' }] : [] };
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(url.pathname === '/api/permission/saved'
          ? { data } : { location: { directory: f.root }, data }));
      })().catch(error => {
        failures.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const endpoint = 'http://127.0.0.1:' + address.port;
      const profile = openCodeManagementProfileSchema.parse({
        provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4',
        profileId: 'TEST-management-profile', configRevision: 'TEST-config', accountBinding: 'TEST-account',
        cwd: f.root, executable: { path: join(f.root, 'TEST-bun'), sha256: 'a'.repeat(64) },
        environment: { HOME: f.home, XDG_DATA_HOME: f.data, XDG_CONFIG_HOME: f.root, XDG_CACHE_HOME: f.root },
        endpoint, timeoutMs: 5000, nativeModel: { providerId, modelId: 'TEST-model' },
        embedded: { version: '2.1.4', platform: process.platform, arch: process.arch,
          directory: join(f.root, 'engine'), manifestSha256: 'b'.repeat(64), externalDirectory: 'deny' },
      });
      for (const kind of ['catalog', 'key'] as const) {
        const start = requests.length;
        const host = new OpenCodeV2ManagementHost(profile, () => true, undefined,
          kind === 'key' ? { retainedCommandId: 'TEST-original-key-' + mode } : {});
        type Config = Omit<Parameters<typeof createOpenCodeV2OwnedSessionClient>[0], 'nativeSessionId'>;
        const admitted = host as unknown as {
          assertCurrent(signal: AbortSignal): void;
          nativeClient(signal: AbortSignal, deadline: number): Promise<{
            ready: { pid: number }; config: Config; client: ReturnType<typeof createOpenCodeV2OwnedSessionClient>;
          }>;
        };
        let client: ReturnType<typeof createOpenCodeV2OwnedSessionClient> | undefined;
        let disposals = 0, admissions = 0;
        const replacement = t.mock.method(admitted, 'nativeClient', async (signal: AbortSignal, deadline: number) => {
          admissions++; assert.equal(admissions, 1);
          admitted.assertCurrent(signal);
          const config: Config = { endpoint, directory: f.root, version: '2.1.4', signal, deadline,
            beforeRequest: async requestSignal => { admitted.assertCurrent(requestSignal); },
            readPassword: () => { admitted.assertCurrent(signal); return 'TEST-server-password'; } };
          client = createOpenCodeV2OwnedSessionClient({ ...config, nativeSessionId: 'ses_TEST' });
          const dispose = client.dispose;
          t.mock.method(client, 'dispose', async () => { disposals++; await dispose(); });
          return { ready: { pid: process.pid }, config, client };
        });
        try {
          if (kind === 'catalog') {
            const catalog = host.catalog(providerId, true);
            if (malformed) await assert.rejects(catalog, { code: 'invalid_native_catalog' });
            else {
              const result = await catalog;
              assert.equal(result.providers.length, mode === 'excluded' ? 0 : 1);
              if (mode !== 'excluded') {
                assert.equal(result.providers[0]!.providerId, providerId);
                assert.deepEqual(result.providers[0]!.authMethods, accepted ? ['api'] : []);
                assert.equal(result.providers[0]!.connected, false, 'inventory never proves authentication');
              }
            }
          } else {
            const key = host.keyOperation(providerId, async native => {
              selectedIds.push(native.integrationId);
              assert.equal(native.integrationId, integrationId);
              return native.connectKey('TEST-corrected-key');
            });
            if (accepted) assert.deepEqual(await key, { integrationId, credentialId: 'cred_TEST' });
            else await assert.rejects(key, { code: malformed ? 'invalid_native_catalog'
              : mode === 'explicit-foreign' ? 'invalid_native_integration'
                : mode === 'form' ? 'native_key_existing_or_unsupported' : 'held' });
          }
          const before = ['GET /api/info', 'GET /api/plugin', 'GET /api/permission/saved', 'GET /api/mcp',
            'GET /api/provider', 'GET /api/model', 'GET /api/model/default'];
          const directory = malformed ? before : [...before, 'GET /api/integration'];
          const keyRead = 'GET /api/integration/' + integrationId;
          assert.deepEqual(requests.slice(start), [...directory, ...(kind === 'key' && accepted
            ? [keyRead, 'POST /api/integration/' + integrationId + '/connect/key', keyRead]
            : kind === 'key' && (mode === 'form' || mode === 'explicit-foreign') ? [keyRead] : [])], mode + ':' + kind);
          assert.equal(admissions, 1); assert.equal(disposals, 1, 'the original Host joins its real client');
          assert.deepEqual(failures, [], 'only the original finite protocol was admitted');
          assert.deepEqual(readFileSync(f.file), originalAuth, 'management never rewrites the captured auth source');
        } finally {
          try { assert.equal(await host.close(), true); }
          finally {
            if (client && disposals === 0) await client.dispose();
            replacement.mock.restore();
          }
        }
      }
      assert.deepEqual(selectedIds, accepted || mode === 'form' || mode === 'explicit-foreign' ? [integrationId] : []);
      assert.equal(connected, accepted);
      assert.equal(requests.filter(route => route.startsWith('POST ')).length, accepted ? 1 : 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});

test('V2 refuses existing V1/auth changes and never overwrites a replacement during rollback', t => {
  const f = fixture(); t.after(f.cleanup);
  const scope = f.scope(), pending = scope.prepare('TEST-private-key');
  f.write({ 'TEST-provider': { type: 'api', key: 'TEST-independent-key' } });
  assert.throws(() => pending.publish(), { code: 'held' });
  assert.throws(() => scope.prepare('TEST-private-key'), { code: 'held' });
  f.write({});
  const own = scope.prepare('TEST-private-key'), published = own.publish();
  f.write({ 'TEST-provider': { type: 'oauth', access: 'TEST-independent-token' } });
  assert.equal(published.isCurrent(), false);
  assert.throws(() => scope.rollbackPublished('TEST-private-key', published, own.before), { code: 'held' });
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {
    'TEST-provider': { type: 'oauth', access: 'TEST-independent-token' },
  });
  f.write({});
  const alternative = join(f.home, '.local/share/opencode'); mkdirSync(alternative, { recursive: true, mode: 0o700 });
  writeFileSync(join(alternative, 'auth.json'), JSON.stringify({ 'TEST-provider': { type: 'api', key: 'TEST-private-key' } }), { mode: 0o600 });
  assert.throws(() => scope.prepare('TEST-private-key'), { code: 'held' }, 'same key in an independent V1 source is still occupied');
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {});
});

test('captured directories, symlinks and revoked owner cannot change the credential destination', t => {
  for (const mode of ['directory', 'symlink', 'revoked'] as const) {
    const f = fixture(); t.after(f.cleanup);
    f.write({});
    const scope = f.scope(), pending = scope.prepare('TEST-private-key');
    if (mode === 'directory') {
      renameSync(f.store, f.store + '-original'); mkdirSync(f.store, { mode: 0o700 });
      f.write({});
    }
    if (mode === 'symlink') {
      renameSync(f.file, f.file + '-original'); symlinkSync(f.file + '-original', f.file);
    }
    if (mode === 'revoked') {
      assert.deepEqual(scope.providerIds(), []);
      f.revoke();
      assert.throws(() => scope.providerIds(), { code: 'held' });
    }
    assert.equal(pending.before.isCurrent(), false, mode);
    assert.throws(() => pending.publish(), { code: 'held' }, mode);
    assert.equal(readFileSync(f.file, 'utf8'), '{}');
  }
});


test('an explicit missing native integration never redirects a captured key to a same-ID integration', async t => {
  const f = fixture(); t.after(f.cleanup);
  f.write({ 'TEST-provider': { type: 'api', key: 'TEST-captured-private-key' } });
  const credential = captureOpenCodeV2SessionCredential({
    environment: { HOME: f.home, XDG_DATA_HOME: f.data }, accountBinding: 'TEST-account',
  }, 'TEST-provider', () => true);
  let directoryReads = 0;
  const owner = {
    readCatalog: async () => ({ provider: { id: 'TEST-provider', name: 'TEST-provider',
      activation: 'enabled', integrationId: 'TEST-explicit-missing' }, defaultModel: null, models: [] }),
    readDirectory: async () => { directoryReads++; return {
      providers: [], models: [], defaultModel: null,
      integrations: [{ id: 'TEST-provider', name: 'TEST-provider', plainKey: true }],
    }; },
  } as unknown as Parameters<typeof credential.prepare>[1];
  const requests: { method: string; path: string }[] = [];
  await assert.rejects(credential.prepare({
    endpoint: 'http://127.0.0.1:19332', directory: f.root, version: '2.1.4',
    deadline: Date.now() + 5000, readPassword: () => 'TEST-owned-native-password',
    fetchImpl: async input => {
      assert.ok(input instanceof Request);
      requests.push({ method: input.method, path: new URL(input.url).pathname });
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    },
  }, owner));
  assert.equal(directoryReads, 0, 'an explicit link cannot be replaced by implicit ID matching');
  assert.deepEqual(requests, [{ method: 'GET', path: '/api/integration/TEST-explicit-missing' }]);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')),
    { 'TEST-provider': { type: 'api', key: 'TEST-captured-private-key' } });
});
