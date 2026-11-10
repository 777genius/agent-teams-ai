import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { fileHash, startHost, tick, treeHash } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type {
  ProviderOAuthSnapshot,
  ProviderManagementCatalog,
} from '../src/management/contracts.ts';

const value = <T>(result: Record<string, unknown>): T => {
  assert.equal(result.ok, true);
  return result.value as T;
};
test(
  'global-only synthetic OAuth E2E: actual Host/D/HTTP processes, code/auto, physical cancel, reconnect and cold receipt replay',
  { timeout: 120_000 },
  async (t) => {
    assert.equal(process.env.LEGACY_SYNTHETIC_OAUTH_HOST_GO, '1');
    const repo = resolve(import.meta.dirname, '../../..'),
      pkg = join(repo, 'packages/legacy-agent-host');
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    assert.equal(await realpath(process.execPath), node);
    const artifacts = {
      nodeSha256: await fileHash(node),
      sourceSha256: await treeHash(join(pkg, 'src'), '.ts'),
      distSha256: await treeHash(join(pkg, 'dist'), '.js'),
      controllerSourceSha256: await treeHash(join(repo, 'agent-teams-controller/src'), '.js'),
      harnessSha256: await fileHash(import.meta.filename),
      helperSha256: await fileHash(join(import.meta.dirname, 'fixtures/native-host.ts')),
      fixtureSourceSha256: await fileHash(
        join(import.meta.dirname, 'fixtures/management-opencode-process.ts')
      ),
      providerSha256: await fileHash(
        join(
          repo,
          'vendor/provider-migration/opencode-idle-v1/agent-teams-provider-implementations-0.0.0.tgz'
        )
      ),
    };
    assert.equal(artifacts.sourceSha256, process.env.LEGACY_NATIVE_HOST_SOURCE_SHA256);
    assert.equal(artifacts.distSha256, process.env.LEGACY_NATIVE_HOST_DIST_SHA256);
    assert.equal(
      artifacts.providerSha256,
      '64df7bcfed0e7e58d709cf79ab3723677461fd5ab1a76cc96fe96e7cdc85346b'
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-oauth-host-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const name of ['home', 'tmp', 'workspace', 'config', 'data', 'cache', 'bin', 'store'])
      await mkdir(join(root, name), { mode: 0o700 });
    const fixturePath = join(root, 'bin/TEST-opencode.ts');
    await writeFile(
      fixturePath,
      `#!${node}\n` +
        (await readFile(
          join(import.meta.dirname, 'fixtures/management-opencode-process.ts'),
          'utf8'
        )),
      { mode: 0o700 }
    );
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((done) => reservation.close(() => done()));
    const entry = join(pkg, 'dist/cli.js');
    const profile: TeamHostProfile = {
      schemaVersion: 1,
      principalId: 'TEST-human',
      owner: {
        ownerId: 'TEST-owner',
        revision: 'TEST-revision',
        profileId: 'TEST-host',
        protocolVersion: 1,
        buildId: 'TEST-oauth-host',
        storageRoot: join(root, 'store'),
        nodeSha256: artifacts.nodeSha256,
        hostEntrySha256: await fileHash(entry),
      },
      teams: [],
      management: [
        {
          provider: 'opencode',
          profileId: 'TEST-management',
          configRevision: 'TEST-config',
          accountBinding: 'TEST-account',
          cwd: join(root, 'workspace'),
          endpoint: `http://127.0.0.1:${address.port}`,
          timeoutMs: 10000,
          oauthTimeoutMs: 30000,
          executable: { path: fixturePath, sha256: await fileHash(fixturePath) },
          environment: {
            HOME: join(root, 'home'),
            TMPDIR: join(root, 'tmp'),
            PATH: `${dirname(node)}:/usr/bin:/bin`,
            XDG_CONFIG_HOME: join(root, 'config'),
            XDG_DATA_HOME: join(root, 'data'),
            XDG_CACHE_HOME: join(root, 'cache'),
            TEST_MANAGEMENT_FIXTURE_ROOT: root,
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: {} }),
          },
        },
      ],
    };
    const profilePath = join(root, 'profile.json');
    await writeFile(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
    const publicProgress: ProviderOAuthSnapshot[] = [];
    const start = () =>
      startHost({
        node,
        entry,
        root,
        profile: profilePath,
        profileHash,
        onNotification(method, raw) {
          assert.equal(method, 'management.oauth.progress');
          assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
          assert.ok(publicProgress.length < 128);
          assert.ok(
            Object.keys(raw).every((key) =>
              [
                'operationId',
                'profileId',
                'configRevision',
                'providerId',
                'methodIndex',
                'phase',
                'completionMethod',
                'sequence',
                'expiresAt',
                'reason',
              ].includes(key)
            )
          );
          const serialized = JSON.stringify(raw);
          for (const forbidden of [
            'authorizationUrl',
            'TEST-private',
            'TEST-correct-code',
            root,
            'accountBinding',
          ])
            assert.equal(serialized.includes(forbidden), false);
          publicProgress.push(raw as ProviderOAuthSnapshot);
        },
      });
    const profileHash = await fileHash(profilePath);
    let host = start(),
      closed = false,
      passed = false;
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
    let failure: string | undefined,
      cleanupFailed = false;
    const identity = (operationId: string) => ({
      operationId,
      profileId: 'TEST-management',
      configRevision: 'TEST-config',
    });
    const events = async () =>
      (await readFile(join(root, 'native-effects.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string; providerId?: string; pid: number });
    const snapshot = async (operationId: string) =>
      value<ProviderOAuthSnapshot>(await host.rpc('management.oauth.read', identity(operationId)));
    const wait = async (operationId: string, phase: ProviderOAuthSnapshot['phase']) => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const read = await snapshot(operationId);
        if (read.phase === phase) return read;
        assert.ok(
          !['held', 'cancelled'].includes(read.phase),
          'original OAuth flow did not reach an unexpected terminal'
        );
        await tick();
      }
      throw new Error('TEST OAuth phase deadline; original intent retained');
    };
    const absent = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
      }
    };
    const authPath = join(root, 'data/opencode/auth.json');
    const auth = async () =>
      JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
    const codeOne = {
      ...identity('TEST-code-one'),
      providerId: 'TEST-oauth-code',
      methodIndex: 0,
      fields: { 'TEST-client': 'TEST-private-field' },
    };
    const completeOne = {
      ...identity(codeOne.operationId),
      commandId: 'TEST-submit-one',
      code: 'TEST-correct-code',
    };
    const auto = { ...identity('TEST-auto-cancel'), providerId: 'TEST-oauth-auto', methodIndex: 0 };
    const codeTwo = { ...codeOne, operationId: 'TEST-code-two' };
    const completeTwo = {
      ...completeOne,
      operationId: codeTwo.operationId,
      commandId: 'TEST-submit-two',
    };
    try {
      const hello = await host.rpc('host.handshake', { protocolVersion: 1 });
      assert.ok((hello.capabilities as string[]).includes('management.oauth'));
      await assert.rejects(access(join(root, 'store/teams')), { code: 'ENOENT' });
      assert.equal(
        value<ProviderOAuthSnapshot>(await host.rpc('management.oauth.start', codeOne)).phase,
        'authorizing'
      );
      await wait(codeOne.operationId, 'waiting-for-code');
      const privateAuthorization = value<{ authorizationUrl: string; instructions: string }>(
        await host.rpc('management.oauth.authorization', identity(codeOne.operationId))
      );
      assert.equal(
        new URL(privateAuthorization.authorizationUrl).origin,
        `http://127.0.0.1:${address.port}`
      );
      assert.ok(privateAuthorization.authorizationUrl.includes('TEST-private-state'));
      assert.equal(
        value<ProviderOAuthSnapshot>(await host.rpc('management.oauth.complete', completeOne))
          .phase,
        'completing'
      );
      await wait(codeOne.operationId, 'completed');
      assert.equal(
        value<ProviderOAuthSnapshot>(await host.rpc('management.oauth.complete', completeOne))
          .phase,
        'completed'
      );
      assert.ok((await auth())['TEST-oauth-code']);
      assert.equal(
        (await events()).filter(
          (event) => event.event === 'callback-start' && event.providerId === codeOne.providerId
        ).length,
        1
      );
      assert.equal(
        value<ProviderOAuthSnapshot>(await host.rpc('management.oauth.start', auto)).phase,
        'authorizing'
      );
      await wait(auto.operationId, 'waiting-for-browser');
      value(
        await host.rpc('management.oauth.complete', {
          ...identity(auto.operationId),
          commandId: 'TEST-submit-auto',
        })
      );
      const pendingDeadline = Date.now() + 10000;
      while (
        !(await events()).some(
          (event) => event.event === 'callback-start' && event.providerId === auto.providerId
        )
      ) {
        assert.ok(Date.now() < pendingDeadline);
        await tick();
      }
      assert.equal(
        value<ProviderOAuthSnapshot>(
          await host.rpc('management.oauth.cancel', identity(auto.operationId))
        ).phase,
        'cancelled'
      );
      const firstPid = (await events()).find((event) => event.event === 'launch')!.pid;
      assert.ok(
        absent(firstPid),
        'cancel confirms physical retirement of the original HTTP process'
      );
      await writeFile(join(root, 'release-auto'), 'TEST-release-after-cancel', { mode: 0o600 });
      value(await host.rpc('management.oauth.start', codeTwo));
      await wait(codeTwo.operationId, 'waiting-for-code');
      await new Promise<void>((done) => setTimeout(done, 100));
      assert.equal(
        (await auth())['TEST-oauth-auto'],
        undefined,
        'retired callback cannot write to the reconnected account'
      );
      assert.equal((await snapshot(auto.operationId)).phase, 'cancelled');
      value(await host.rpc('management.oauth.complete', completeTwo));
      await wait(codeTwo.operationId, 'completed');
      const launches = (await events()).filter((event) => event.event === 'launch');
      assert.equal(launches.length, 2);
      assert.notEqual(launches[0]!.pid, launches[1]!.pid);
      value(
        await host.rpc('management.credential', {
          commandId: 'TEST-forget-oauth',
          profileId: 'TEST-management',
          configRevision: 'TEST-config',
          providerId: codeOne.providerId,
          kind: 'credential.forget',
        })
      );
      assert.deepEqual(await auth(), {});
      const currentStatus = value<ProviderManagementCatalog>(
        await host.rpc('management.catalog', {
          profileId: 'TEST-management',
          configRevision: 'TEST-config',
        })
      );
      assert.ok(currentStatus.providers.every((provider) => !provider.connected));
      await host.close();
      hosts.push(host.facts());
      closed = true;
      assert.ok(launches.every((event) => absent(event.pid)));
      host = start();
      closed = false;
      await host.rpc('host.handshake', { protocolVersion: 1 });
      for (const [request, completion] of [
        [codeOne, completeOne],
        [codeTwo, completeTwo],
      ] as const) {
        assert.equal(
          value<ProviderOAuthSnapshot>(await host.rpc('management.oauth.start', request)).phase,
          'completed'
        );
        assert.equal(
          value<ProviderOAuthSnapshot>(await host.rpc('management.oauth.complete', completion))
            .phase,
          'completed'
        );
      }
      assert.equal((await snapshot(auto.operationId)).phase, 'cancelled');
      assert.equal(
        (await events()).filter((event) => event.event === 'launch').length,
        2,
        'cold replay does not allocate another native process'
      );
      assert.deepEqual(
        await auth(),
        {},
        'replayed OAuth callbacks cannot resurrect a forgotten credential'
      );
      for (const operationId of [codeOne.operationId, auto.operationId, codeTwo.operationId]) {
        const records = publicProgress.filter((event) => event.operationId === operationId);
        assert.ok(records.length >= 4);
        assert.ok(
          records.every(
            (record, index) => index === 0 || record.sequence > records[index - 1]!.sequence
          )
        );
      }
      const journal = (
        await Promise.all(
          (await readdir(join(root, 'store/management-commands')))
            .filter((name) => name.endsWith('.json'))
            .map((name) => readFile(join(root, 'store/management-commands', name), 'utf8'))
        )
      ).join('\n');
      for (const secret of [
        'TEST-correct-code',
        'TEST-private-state',
        'TEST-private-field',
        'TEST-fixture-access',
        'authorizationUrl',
      ])
        assert.equal(journal.includes(secret), false);
      await host.close();
      hosts.push(host.facts());
      closed = true;
      passed = true;
    } catch (error) {
      failure =
        error instanceof Error
          ? `${error.name}: ${error.message}`.slice(0, 2000)
          : 'Unknown TEST failure';
      throw error;
    } finally {
      if (!closed) {
        try {
          await host.close();
          hosts.push(host.facts());
          closed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      let nativeEffects: unknown = [];
      try {
        nativeEffects = await events();
      } catch {
        /* A pre-allocation refusal has no native effects file. */
      }
      await writeFile(
        join(root, 'receipt.json'),
        JSON.stringify(
          {
            status: passed && !cleanupFailed ? 'PASS' : 'INCOMPLETE',
            root,
            artifacts,
            hosts,
            closed,
            cleanupFailed,
            failure,
            fixtureExecutableSha256: profile.management![0]!.executable.sha256,
            nativeEffects,
            publicProgress,
            scope:
              'GLOBAL-ONLY SYNTHETIC OpenCode-shaped local HTTP process through actual standalone Host and public D, without Team bootstrap/storage. Code/auto, private authorization, safe sequenced progress, physical cancel, reconnect, forget and cold replay. No vendor OAuth, real account, model/session or Desktop UI qualification.',
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      assert.equal(cleanupFailed, false);
    }
  }
);
