import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { CodexManagementHost } from '../dist/adapters/providers/CodexManagementHost.js';
import { fileHash } from './fixtures/native-host.ts';
import type { CodexManagementProfile } from '../dist/management/profile.js';
import type { CapturedProcessPort } from '../dist/adapters/providers/CapturedProcess.js';

for (const scenario of ['stale', 'wrong-home', 'quota']) {
  const wrongNamespace = scenario === 'wrong-home',
    quota = scenario === 'quota';
  test(`finite Codex metadata ${quota ? 'reads actual zero quota after physical closure' : wrongNamespace ? 'rejects a different native home before account reads' : 'waits for cleanup and rechecks namespace authority before publishing'}`, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-codex-metadata-custody-')));
    for (const name of ['home', 'codex', 'workspace'])
      await mkdir(join(root, name), { mode: 0o700 });
    const profile: CodexManagementProfile = {
      provider: 'codex',
      protocolRevision: '0.162.0',
      profileId: 'TEST-profile',
      configRevision: 'TEST-config',
      accountBinding: 'TEST-none',
      cwd: join(root, 'workspace'),
      timeoutMs: 5000,
      environment: {
        HOME: join(root, 'home'),
        CODEX_HOME: join(root, 'codex'),
        ...(wrongNamespace ? { TEST_WRONG_NAMESPACE: '1' } : {}),
        ...(quota ? { TEST_CHATGPT: '1' } : {}),
      },
      executable: {
        path: await realpath(process.execPath),
        sha256: await fileHash(process.execPath),
      },
    };
    if (scenario === 'stale') {
      const unsupported = Object.assign({}, profile, { configProfile: 'TEST-named' });
      assert.throws(() => new CodexManagementHost(unsupported, () => true, () => {
        assert.fail('unsupported named native profile must reject before process allocation');
      }), { code: 'invalid' });
    }
    let current = true,
      child: ReturnType<typeof spawn> | undefined;
    let release!: () => void, closing!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const stopped = new Promise<void>((done) => {
      closing = done;
    });
    const host = new CodexManagementHost(
      profile,
      () => current,
      (selected, canAllocate): CapturedProcessPort => ({
        launch(request) {
          assert.equal(canAllocate(), true);
          assert.equal(request.command, profile.executable.path);
          assert.deepEqual(request.args, ['app-server', '--listen', 'stdio://']);
          child = spawn(
            selected.executable.path,
            [resolve(import.meta.dirname, 'fixtures/codex-metadata-peer.ts')],
            {
              env: selected.environment,
              cwd: selected.cwd,
              stdio: ['pipe', 'pipe', 'pipe'],
            }
          );
          return child as ReturnType<CapturedProcessPort['launch']>;
        },
        seal() {},
        isRunning: () => child?.exitCode === null,
        async confirmStopped() {
          assert.ok(child);
          if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
          closing();
          await gate;
          return true;
        },
      })
    );
    t.after(async () => {
      release();
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    });
    let settled = false;
    const pending = host.read(true, quota).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      }
    );
    void pending.catch(() => {});
    await stopped;
    assert.equal(settled, false, 'no result escapes while physical closure is unconfirmed');
    if (scenario === 'stale') current = false;
    release();
    if (quota) {
      const value = await pending;
      assert.equal(value.rateLimits?.state, 'ready');
      assert.equal(value.rateLimits?.snapshot?.primary?.usedPercent, 0);
    } else
      await assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof Error && error.message === 'Provider management command held'
      );
    const wire = (await readFile(join(root, 'home/TEST-wire.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    assert.deepEqual(
      wire.map((row) => row.method),
      wrongNamespace
        ? ['initialize', 'initialized']
        : [
            'initialize',
            'initialized',
            'account/read',
            ...(quota ? ['account/rateLimits/read'] : []),
            'config/read',
            'model/list',
          ]
    );
    if (!wrongNamespace)
      assert.deepEqual(wire.find((row) => row.method === 'account/read')?.params, {
        refreshToken: false,
      });
  });
}
