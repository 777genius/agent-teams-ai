import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { CapturedProcess } from '../dist/adapters/providers/CapturedProcess.js';
import { CodexLoginConversation } from '../dist/adapters/providers/CodexLoginConversation.js';
import { fileHash, startHost, tick } from './fixtures/native-host.ts';

import type { TestContext } from 'node:test';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type {
  ProviderOAuthAuthorization,
  ProviderOAuthSnapshot,
} from '../src/management/contracts.ts';

const value = <T>(reply: Record<string, unknown>): T => {
  assert.equal(reply.ok, true);
  return reply.value as T;
};
type Wire = { method: string; params?: Record<string, unknown> };
const identity = {
  operationId: 'TEST-owned-login',
  profileId: 'TEST-profile',
  configRevision: 'TEST-config',
};
const absent = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
};

/** Actual Host/D/child wire with TEST credentials. This is not vendor auth or original Desktop UI proof. */
async function fixture(t: TestContext, scenario: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-codex-login-host-')));
  for (const name of ['home', 'codex', 'workspace', 'store', 'tmp', 'bin'])
    await mkdir(join(root, name), { mode: 0o700 });
  const node = await realpath(process.execPath);
  const executable = join(root, 'bin/TEST-codex.ts');
  await writeFile(
    executable,
    `#!${node}\n` +
      (await readFile(join(import.meta.dirname, 'fixtures/codex-metadata-peer.ts'), 'utf8')),
    { mode: 0o700 }
  );
  const entry = resolve(import.meta.dirname, '../dist/cli.js');
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-revision',
      profileId: 'TEST-host',
      protocolVersion: 1,
      buildId: 'TEST-codex-login',
      storageRoot: join(root, 'store'),
      nodeSha256: await fileHash(node),
      hostEntrySha256: await fileHash(entry),
    },
    teams: [],
    management: [
      {
        provider: 'codex',
        protocolRevision: '0.162.0',
        profileId: identity.profileId,
        configRevision: identity.configRevision,
        accountBinding: 'TEST-account',
        cwd: join(root, 'workspace'),
        timeoutMs: 1000,
        executable: { path: executable, sha256: await fileHash(executable) },
        environment: {
          HOME: join(root, 'home'),
          CODEX_HOME: join(root, 'codex'),
          TEST_LOGIN: scenario,
        },
      },
    ],
  };
  const profilePath = join(root, 'profile.json');
  const managementProfile = profile.management?.[0];
  assert.ok(managementProfile?.provider === 'codex');
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const profileHash = await fileHash(profilePath);
  const progress: ProviderOAuthSnapshot[] = [];
  const start = () =>
    startHost({
      node,
      entry,
      root,
      profile: profilePath,
      profileHash,
      onNotification(method, raw) {
        assert.equal(method, 'management.oauth.progress');
        assert.ok(progress.length < 128);
        const text = JSON.stringify(raw);
        for (const forbidden of [
          'authorizationUrl',
          'userCode',
          'TEST-PRIVATE-CODE',
          'TEST-private-state',
          'TEST-native-login',
        ])
          assert.equal(text.includes(forbidden), false);
        progress.push(raw as ProviderOAuthSnapshot);
      },
    });
  let host = start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.rpc('host.handshake', { protocolVersion: 1 });
  const rpc = (method: string, params: unknown) => host.rpc('management.' + method, params);
  const snapshot = async () => value<ProviderOAuthSnapshot>(await rpc('oauth.read', identity));
  const wait = async (phase: ProviderOAuthSnapshot['phase']) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const state = await snapshot();
      if (state.phase === phase) return state;
      assert.ok(Date.now() < deadline, `Expected ${phase}, observed ${state.phase}`);
      assert.ok(
        !['completed', 'held', 'cancelled'].includes(state.phase),
        `Unexpected ${state.phase}`
      );
      await tick();
    }
  };
  const lines = async <T>(path: string): Promise<T[]> => {
    try {
      return (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  return {
    root,
    rpc,
    snapshot,
    wait,
    progress,
    managementProfile,
    wire: () => lines<Wire>(join(root, 'home/TEST-wire.ndjson')),
    processes: () => lines<{ pid: number }>(join(root, 'home/TEST-login-processes.ndjson')),
    async restart() {
      await host.close();
      host = start();
      await host.rpc('host.handshake', { protocolVersion: 1 });
    },
  };
}

test(
  'Codex account readback cannot complete before original custody confirmation',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, 'early');
    const physical = Promise.withResolvers<void>();
    const confirmation = Promise.withResolvers<boolean>();
    let confirmations = 0;
    const conversation = new CodexLoginConversation(
      f.managementProfile,
      'chatgpt',
      () => true,
      (selected, current) => {
        const custody = new CapturedProcess(selected, current);
        return {
          launch: custody.launch,
          seal: () => custody.seal(),
          isRunning: () => custody.isRunning(),
          async confirmStopped() {
            confirmations++;
            assert.equal(await custody.confirmStopped(), true);
            physical.resolve();
            return confirmation.promise; // Fault injection at the existing custody acknowledgment port only.
          },
        };
      }
    );
    try {
      await conversation.authorize(undefined, new AbortController().signal);
      let settled = false;
      const completing = conversation
        .complete(undefined, new AbortController().signal)
        .then((ok) => {
          settled = true;
          return ok;
        });
      await physical.promise;
      assert.equal(settled, false, 'matching completion/account are not cleanup confirmation');
      confirmation.resolve(false);
      assert.equal(await completing, false, 'unconfirmed custody cannot report a completed login');
      assert.equal(await conversation.close(), false);
      assert.equal(confirmations, 1, 'abort/close re-entry observes the original cleanup');
    } finally {
      confirmation.resolve(true);
      await conversation.close();
    }
  }
);

for (const scenario of [
  'early',
  'device',
  'cancel',
  'cancel-before-login',
  'overflow',
  'wrong-account',
  'reply-lost',
]) {
  test(
    `captured Codex login across actual Host/D/TEST process: ${scenario}`,
    { timeout: 20_000 },
    async (t) => {
      const f = await fixture(t, ['device', 'cancel'].includes(scenario) ? 'pending' : scenario);
      const start = {
        ...identity,
        providerId: 'codex',
        methodIndex: scenario === 'device' ? 1 : 0,
      };
      if (scenario === 'cancel')
        await writeFile(join(f.root, 'codex/TEST-login-account.json'), 'true', { mode: 0o600 });
      value(await f.rpc('oauth.start', start));
      value(await f.rpc('oauth.start', start));
      if (scenario === 'device' || scenario === 'cancel') {
        await f.wait('waiting-for-browser');
        const authorization = value<ProviderOAuthAuthorization>(
          await f.rpc('oauth.authorization', identity)
        );
        assert.equal(
          authorization.userCode,
          scenario === 'device' ? 'TEST-PRIVATE-CODE' : undefined
        );
        assert.deepEqual(
          value(await f.rpc('oauth.authorization', identity)),
          authorization,
          'reopening reads the original presentation'
        );
        assert.equal(
          (await f.snapshot()).phase,
          'waiting-for-browser',
          'foreign/null completion does not settle this login'
        );
        for (const kind of ['credential.refresh', 'credential.forget'])
          assert.deepEqual(
            await f.rpc('credential', {
              commandId: 'TEST-race-' + kind,
              profileId: identity.profileId,
              configRevision: identity.configRevision,
              providerId: 'codex',
              kind,
            }),
            { ok: false, code: 'busy' }
          );
        if (scenario === 'device')
          await writeFile(join(f.root, 'home/TEST-complete-login'), 'TEST-release', {
            mode: 0o600,
          });
      }
      const cancelled = scenario === 'cancel' || scenario === 'cancel-before-login';
      if (cancelled) value(await f.rpc('oauth.cancel', identity));
      const phase = cancelled
        ? 'cancelled'
        : ['early', 'device'].includes(scenario)
          ? 'completed'
          : 'held';
      await f.wait(phase);
      const wire = await f.wire();
      assert.equal(
        wire.filter((row) => row.method === 'account/login/start').length,
        scenario === 'cancel-before-login' ? 0 : 1
      );
      assert.equal(
        wire.filter((row) => row.method === 'account/login/cancel').length,
        scenario === 'cancel' ? 1 : 0
      );
      assert.equal(
        wire.filter((row) => row.method === 'account/logout').length,
        0,
        'cancel and failure never log out'
      );
      assert.equal(
        wire.filter((row) => row.method === 'account/read').length,
        ['early', 'device', 'wrong-account'].includes(scenario) ? 1 : 0
      );
      assert.ok(
        (await f.processes()).every((row) => absent(row.pid)),
        'receipt waits for original child cleanup'
      );
      if (scenario === 'cancel')
        assert.equal(await readFile(join(f.root, 'codex/TEST-login-account.json'), 'utf8'), 'true');
      for (const name of await readdir(join(f.root, 'store/management-commands'))) {
        if (!name.endsWith('.json')) continue;
        const saved = await readFile(join(f.root, 'store/management-commands', name), 'utf8');
        for (const forbidden of [
          'authorizationUrl',
          'userCode',
          'TEST-PRIVATE-CODE',
          'TEST-private-state',
          'TEST-native-login',
        ])
          assert.equal(saved.includes(forbidden), false, 'durable state contains routing only');
      }
      const launches = (await f.processes()).length;
      await f.restart();
      assert.equal(value<ProviderOAuthSnapshot>(await f.rpc('oauth.start', start)).phase, phase);
      assert.equal(
        (await f.processes()).length,
        launches,
        'cold receipt lookup never starts a replacement login'
      );
      assert.equal(
        value(await f.rpc('oauth.authorization', identity)),
        null,
        'cold state has no persisted login URL/code'
      );
    }
  );
}
