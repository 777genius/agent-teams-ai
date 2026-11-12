import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { createOpenCodeV2EmbeddedServer } from '../dist/adapters/providers/OpenCodeV2EmbeddedServer.js';

const directory = process.env.OPENCODE_V2_EMBEDDED_TEST_GRAPH;
const bun = process.env.OPENCODE_V2_EMBEDDED_TEST_BUN;

test(
  'pinned embedded engine starts privately, reports actual custody and closes its owned process group',
  {
    skip: !directory || !bun || process.platform !== 'linux' || process.arch !== 'x64',
    timeout: 180_000,
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-stage1-embedded-v2-'));
    const folder = (name: string) => path.join(root, name);
    for (const part of ['workspace', 'home', 'config', 'data', 'state', 'cache', 'temp'])
      await mkdir(folder(part));
    await writeFile(
      path.join(folder('workspace'), '.env'),
      'OPENCODE_SERVER_PASSWORD=TEST-ambient-secret\n'
    );
    await writeFile(
      path.join(folder('workspace'), 'bunfig.toml'),
      'preload = ["./TEST-untrusted-preload.ts"]\n'
    );
    await writeFile(
      path.join(folder('workspace'), 'TEST-untrusted-preload.ts'),
      'throw new Error("ambient preload executed");\n'
    );
    await writeFile(
      path.join(folder('home'), '.bunfig.toml'),
      `preload = [${JSON.stringify(path.join(folder('workspace'), 'TEST-untrusted-preload.ts'))}]\n`
    );
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    assert.ok(address && typeof address === 'object');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve()))
    );
    const server = createOpenCodeV2EmbeddedServer({
      profile: {
        provider: 'opencode',
        cwd: folder('workspace'),
        executable: {
          path: bun!,
          sha256: '6d5bb405b1d037a2a466b92757de7e47e4369930fa94bd42f8ff44ba49de6c57',
        },
        environment: {
          PATH: '/usr/bin:/bin',
          HOME: folder('home'),
          XDG_CONFIG_HOME: folder('config'),
          XDG_DATA_HOME: folder('data'),
          XDG_STATE_HOME: folder('state'),
          XDG_CACHE_HOME: folder('cache'),
          TMPDIR: folder('temp'),
          NO_COLOR: '1',
          OPENCODE_SERVER_PASSWORD: 'TEST-forbidden-env-password',
        },
      },
      embedded: {
        directory: directory!,
        manifestSha256: '840d7cc145155e0ad97a407af87eb347da1a9cbf034d19c632897e1a5efbff9b',
        version: '2.1.4',
        platform: 'linux',
        arch: 'x64',
      },
      configDirectory: folder('config'),
      databasePath: path.join(folder('data'), 'engine.sqlite'),
      config: { permission: { external_directory: 'deny' } },
      canAllocate: () => true,
      endpoint,
    });
    let cleanup = false;
    try {
      const ready = await server.start();
      assert.equal(ready.endpoint, endpoint);
      assert.deepEqual(await server.start(), ready, 'startup is not repeated');
      const unauthorized = await fetch(`${ready.endpoint}/api/session`);
      assert.equal(unauthorized.status, 401);
      const authenticated = await fetch(`${ready.endpoint}/api/session`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${server.readPassword()}`).toString('base64')}`,
        },
      });
      assert.equal(authenticated.status, 200);
      const sessions = (await authenticated.json()) as { data: unknown[] };
      assert.deepEqual(sessions.data, []);
      const info = await fetch(`${ready.endpoint}/api/info`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${server.readPassword()}`).toString('base64')}`,
        },
      });
      assert.equal(info.status, 200);
      const metadata = (await info.json()) as { version: string; pid: number };
      assert.equal(metadata.version, '2.1.4');
      assert.equal(metadata.pid, ready.pid);
      const custody = await server.readNativeCustody(new AbortController().signal);
      assert.equal(custody?.executablePath, bun);
      assert.equal(custody?.pid, ready.pid);
      assert.equal(custody?.startIdentity, ready.startIdentity);
      assert.equal(custody?.version, '2.1.4');
      const environment = await readFile(`/proc/${ready.pid}/environ`, 'utf8');
      assert.equal(environment.includes(server.readPassword()), false);
      assert.equal(environment.includes('TEST-forbidden-env-password'), false);
      assert.equal(environment.includes('TEST-ambient-secret'), false);
      assert.equal((await stat(path.join(folder('data'), 'engine.sqlite'))).isFile(), true);
      cleanup = await server.stopOwned();
      assert.equal(cleanup, true);
      assert.equal(await server.confirmStopped(), true);
      assert.equal(await server.readNativeCustody(new AbortController().signal), undefined);
      assert.throws(() => process.kill(-ready.pid, 0), { code: 'ESRCH' });
    } finally {
      cleanup = await server.confirmStopped();
      if (cleanup) await rm(root, { recursive: true, force: true });
      assert.equal(cleanup, true, 'physical child cleanup must be confirmed');
    }
  }
);
