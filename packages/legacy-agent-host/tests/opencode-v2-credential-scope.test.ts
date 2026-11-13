import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createOpenCodeV2OwnedSessionClient } from '@agent-teams/provider-implementations/opencode';

import { OpenCodeV2CredentialScope } from '../dist/adapters/providers/OpenCodeV2CredentialScope.js';
import { captureOpenCodeV2SessionCredential } from '../dist/adapters/providers/OpenCodeV2SessionCredential.js';

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
    'foreign-scope', 'explicit-foreign', 'explicit-scope'] as const) {
    const explicit = mode.startsWith('explicit');
    const integrationId = explicit ? 'TEST-explicit' : 'TEST-provider';
    const accepted = mode === 'configured' || mode === 'absent' || mode === 'explicit';
    const requests: string[] = [], failures: unknown[] = [];
    let connected = false;
    const server = createServer((request, response) => {
      void (async () => {
        assert.ok(requests.length < 10, 'one finite preparation, with no replay');
        const url = new URL(request.url!, 'http://127.0.0.1');
        requests.push(request.method + ' ' + url.pathname);
        assert.deepEqual([...url.searchParams], [['location[directory]', f.root]]);
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
          assert.deepEqual(JSON.parse(body), { key: 'TEST-corrected-key' });
          connected = true;
          response.writeHead(204); response.end(); return;
        }
        assert.equal(request.method, 'GET');
        assert.equal(body, '');
        let data: unknown;
        let directory = f.root;
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
      const config = { endpoint: 'http://127.0.0.1:' + address.port, directory: f.root,
        version: '2.1.4' as const, signal: t.signal, deadline: Date.now() + 5000,
        readPassword: () => 'TEST-server-password' };
      owner = createOpenCodeV2OwnedSessionClient({ ...config, nativeSessionId: 'ses_TEST' });
      const prepared = captureOpenCodeV2SessionCredential(f.profile, 'TEST-provider', () => true);
      const original = prepared.prepare(config, owner);
      assert.equal(prepared.prepare(config, owner), original, 'same original pending Promise');
      if (accepted) {
        assert.deepEqual(await original, { scopeDigest: f.scope().capture().digest, credentialId: 'cred_TEST' });
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
    } finally {
      try { await owner?.dispose(); }
      finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
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
