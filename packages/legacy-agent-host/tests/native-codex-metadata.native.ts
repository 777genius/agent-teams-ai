import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { fileHash, startHost, treeHash } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

// Real pinned Codex, standalone Host and packed D. All roots are fresh TEST state; no vendor auth.
const exerciseAuth = process.env.LEGACY_NATIVE_CODEX_AUTH_GO === '1';
test(
  exerciseAuth ? 'captured Host admits native Codex logout/refresh once and recovers receipts without replay' : 'captured Host reads native Codex account/config/models without any conversation or inference',
  { timeout: 60000 },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_CODEX_METADATA_GO, '1');
    const repo = resolve(import.meta.dirname, '../../..'),
      pkg = join(repo, 'packages/legacy-agent-host');
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    assert.equal(await realpath(process.execPath), node);
    const binary = process.env.LEGACY_NATIVE_CODEX_PATH;
    assert.ok(binary);
    const executable = { path: await realpath(binary), sha256: await fileHash(binary) };
    assert.equal(
      executable.sha256,
      '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57'
    );
    const providerArtifact = process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT;
    assert.ok(providerArtifact, 'root selects the exact consumed provider archive');
    const providerArchive = await realpath(resolve(repo, providerArtifact));
    const providerSha256 = await fileHash(providerArchive);
    assert.equal(providerSha256, process.env.LEGACY_NATIVE_PROVIDER_SHA256);
    const providerRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@agent-teams/provider-implementations/codex'))), '..');
    const entries = execFileSync('/usr/bin/tar', ['-tf', providerArchive], { encoding: 'utf8' }).trim().split('\n').filter((entry) => /^package\/dist\/.+\.js$/.test(entry));
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.ok(!entry.includes('..'));
      assert.deepEqual(await readFile(join(providerRoot, entry.slice('package/'.length))), execFileSync('/usr/bin/tar', ['-xOf', providerArchive, entry]), 'installed provider JS matches the selected immutable archive');
    }
    const artifacts = {
      executable,
      nodeSha256: await fileHash(node),
      entrySha256: await fileHash(join(pkg, 'dist/cli.js')),
      sourceSha256: await treeHash(join(pkg, 'src'), '.ts'),
      distSha256: await treeHash(join(pkg, 'dist'), '.js'),
      providerSha256,
      harnessSha256: await fileHash(import.meta.filename),
      helperSha256: await fileHash(join(import.meta.dirname, 'fixtures/native-host.ts')),
    };
    assert.equal(artifacts.sourceSha256, process.env.LEGACY_NATIVE_HOST_SOURCE_SHA256);
    assert.equal(artifacts.distSha256, process.env.LEGACY_NATIVE_HOST_DIST_SHA256);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-codex-metadata-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const name of ['home', 'codex', 'workspace', 'tmp', 'store', 'config', 'data', 'cache'])
      await mkdir(join(root, name), { mode: 0o700 });
    let requests = 0;
    const endpoint = createServer((_request, response) => {
      requests++;
      response.writeHead(503);
      response.end('TEST unexpected inference');
    });
    await new Promise<void>((done) => endpoint.listen(0, '127.0.0.1', done));
    t.after(() => new Promise<void>((done) => endpoint.close(() => done())));
    const address = endpoint.address();
    assert.ok(address && typeof address !== 'string');
    const config = `model = "TEST-model"\nmodel_provider = "TEST_fixture"\ncheck_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n[otel]\nexporter = "none"\nmetrics_exporter = "none"\n[features]\nremote_models = false\napps = false\nplugins = false\nshell_snapshot = false\nskip_host_skill_discovery = true\n[model_providers.TEST_fixture]\nname = "TEST fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`;
    await writeFile(join(root, 'codex/config.toml'), config, { mode: 0o600 });
    const profile: TeamHostProfile = {
      schemaVersion: 1,
      principalId: 'TEST-human',
      owner: {
        ownerId: 'TEST-owner',
        revision: 'TEST-revision',
        storageRoot: join(root, 'store'),
        profileId: 'TEST-profile',
        protocolVersion: 1,
        buildId: 'TEST-codex-metadata',
        nodeSha256: artifacts.nodeSha256,
        hostEntrySha256: artifacts.entrySha256,
      },
      teams: [],
      management: [
        {
          provider: 'codex',
          protocolRevision: '0.162.0',
          profileId: 'TEST-codex',
          accountBinding: 'TEST-no-credentials',
          configRevision: 'TEST-config',
          timeoutMs: 10000,
          cwd: join(root, 'workspace'),
          executable,
          environment: {
            HOME: join(root, 'home'),
            CODEX_HOME: join(root, 'codex'),
            TMPDIR: join(root, 'tmp'),
            XDG_CONFIG_HOME: join(root, 'config'),
            XDG_DATA_HOME: join(root, 'data'),
            XDG_CACHE_HOME: join(root, 'cache'),
            PATH: `${dirname(node)}:/usr/bin:/bin`,
            SHELL: '/bin/sh',
          },
        },
      ],
    };
    if (exerciseAuth) profile.management!.push({ ...profile.management![0]!, profileId: 'TEST-codex-alias' });
    const profilePath = join(root, 'profile.json');
    await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
    const host = startHost({
      node,
      entry: join(pkg, 'dist/cli.js'),
      root,
      profile: profilePath,
      profileHash: await fileHash(profilePath),
    });
    let closed = false;
    t.after(async () => {
      if (!closed) await host.close();
    });
    const handshake = await host.rpc('host.handshake', { protocolVersion: 1 });
    assert.ok(JSON.stringify(handshake).includes('management.codex.metadata'));
    const payload = {
      profileId: 'TEST-codex',
      configRevision: 'TEST-config',
      includeModels: true,
      includeRateLimits: true,
    };
    const result = await host.rpc('management.codex.metadata', payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    const value = record(result.value);
    assert.equal(value.account, null);
    assert.deepEqual(value.rateLimits, { state: 'not-authenticated', snapshot: null });
    assert.equal(typeof value.requiresOpenaiAuth, 'boolean');
    assert.deepEqual(value.configuration, {
      model: 'TEST-model',
      modelProvider: 'TEST_fixture',
      reasoningEffort: null,
    });
    assert.ok(Array.isArray(value.models) && value.models.length > 0);
    const serialized = JSON.stringify(value);
    for (const privateValue of [
      root,
      executable.path,
      'accessToken',
      'refreshToken',
      'api_key',
      'threadId',
      'turnId',
    ])
      assert.equal(serialized.includes(privateValue), false);
    const wrong = await host.rpc('management.codex.metadata', {
      ...payload,
      configRevision: 'foreign',
    });
    assert.deepEqual(wrong, { ok: false, code: 'invalid' });
    const authReceipts: unknown[] = [];
    const authCommands = [
      { profileId: 'TEST-codex', kind: 'credential.refresh', commandId: 'TEST-native-refresh', reuseWindowMs: 30_000 },
      { profileId: 'TEST-codex-alias', kind: 'credential.refresh', commandId: 'TEST-native-alias-refresh', reuseWindowMs: 30_000 },
      { profileId: 'TEST-codex-alias', kind: 'credential.forget', commandId: 'TEST-native-forget' },
      { profileId: 'TEST-codex', kind: 'credential.refresh', commandId: 'TEST-native-after-logout', reuseWindowMs: 30_000 },
    ].map((command) => ({ ...command, configRevision: 'TEST-config', providerId: 'codex' }));
    const commandRecord = async (id: string) => {
      const files = await readdir(join(root, 'store/management-commands'));
      const rows = await Promise.all(files.map(async (file) => record(JSON.parse(await readFile(join(root, 'store/management-commands', file), 'utf8')))));
      const found = rows.find((row) => row.commandId === id);
      assert.ok(found, 'original Host command record exists');
      return found;
    };
    if (exerciseAuth) {
      for (const command of authCommands) {
        const receipt = await host.rpc('management.credential', command);
        assert.equal(receipt.ok, true, JSON.stringify(receipt));
        assert.equal(record(receipt.value).phase, 'completed', JSON.stringify(receipt));
        authReceipts.push(receipt);
        assert.deepEqual(await host.rpc('management.credential', command), receipt);
        assert.deepEqual(await host.rpc('management.credential.lookup', { commandId: command.commandId, profileId: command.profileId, configRevision: command.configRevision }), receipt);
      }
      assert.equal((await readdir(join(root, 'store/management-commands'))).length, 4);
      const first = await commandRecord('TEST-native-refresh');
      const alias = await commandRecord('TEST-native-alias-refresh');
      const logout = await commandRecord('TEST-native-forget');
      const renewed = await commandRecord('TEST-native-after-logout');
      assert.equal(alias.refreshCompletedAtMs, first.refreshCompletedAtMs);
      assert.ok(Number(alias.finishedAtMs) > Number(first.finishedAtMs));
      assert.ok(Number(renewed.refreshCompletedAtMs) > Number(logout.finishedAtMs), 'logout resets the namespace refresh generation');
      const rejected = await host.rpc('management.credential', { profileId: 'TEST-codex', configRevision: 'TEST-config', providerId: 'codex', kind: 'credential.set', key: 'TEST-no-effect', commandId: 'TEST-invalid-set' });
      assert.deepEqual(rejected, { ok: false, code: 'invalid' });
      assert.equal((await readdir(join(root, 'store/management-commands'))).length, 4, 'unsupported mutation creates no claim or native process');
    }
    await host.close();
    closed = true;
    assert.equal(requests, 0, 'metadata never reaches the configured inference endpoint');
    let sessions: string[] = [];
    try {
      sessions = await readdir(join(root, 'codex/sessions'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    assert.deepEqual(sessions, [], 'metadata creates no conversation store');
    assert.equal(await readFile(join(root, 'codex/config.toml'), 'utf8'), config);
    if (exerciseAuth) {
      const reopened = startHost({ node, entry: join(pkg, 'dist/cli.js'), root, profile: profilePath, profileHash: await fileHash(profilePath) });
      try {
        await reopened.rpc('host.handshake', { protocolVersion: 1 });
        for (const [index, command] of authCommands.entries())
          assert.deepEqual(await reopened.rpc('management.credential', command), authReceipts[index]);
        const afterRestart = { ...authCommands[1]!, commandId: 'TEST-native-restart-alias' };
        const reused = await reopened.rpc('management.credential', afterRestart);
        assert.equal(record(reused.value).phase, 'completed');
        assert.equal((await commandRecord(afterRestart.commandId)).refreshCompletedAtMs,
          (await commandRecord('TEST-native-after-logout')).refreshCompletedAtMs);
        authReceipts.push(reused);
      } finally { await reopened.close(); }
    }
    const receipt = {
      schemaVersion: 1,
      status: 'PASS',
      scope: exerciseAuth ? 'Native TEST no-credential refresh/logout, durable replay/restart, not vendor login or Team parity' : 'native Codex finite metadata, not login or Team launch parity',
      authReceipts,
      root,
      artifacts,
      modelCount: (value.models as unknown[]).length,
      inferenceRequests: requests,
      conversationStoreEntries: sessions.length,
      configUnchanged: true,
      host: host.facts(),
      cleanupConfirmed: true,
    };
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  }
);
