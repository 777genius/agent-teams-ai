import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { digest } from '../../ci/release/contract.ts';
import { downloadAnonymousMacInstaller } from './mac-inputs.mts';
import { checkMacNativeWorkflow } from './mac-old-native.mts';

void test('native Mac context requires its exact approved workflow before native commands', () => {
  for (const workflow of ['updater-mac-old-updater', 'updater-mac-updater'] as const) {
    const reference = `777genius/agent-teams-ai/.github/workflows/${workflow}.yml@refs/tags/TEST-tooling`;
    assert.doesNotThrow(() => checkMacNativeWorkflow(workflow, reference));
    for (const invalid of [
      undefined,
      reference.replace('777genius/', 'foreign/'),
      reference.replace(
        workflow,
        workflow === 'updater-mac-updater' ? 'updater-mac-old-updater' : 'updater-mac-updater'
      ),
      reference.replace('.yml@', '.yml.other@'),
    ])
      assert.throws(() => checkMacNativeWorkflow(workflow, invalid));
  }
  assert.throws(() =>
    checkMacNativeWorkflow(
      'foreign-workflow' as Parameters<typeof checkMacNativeWorkflow>[0],
      '777genius/agent-teams-ai/.github/workflows/foreign-workflow.yml@refs/tags/TEST-tooling'
    )
  );
});

void test('anonymous installer stream preserves bytes without auth across a real redirect', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-mac-installer-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from([0, 1, 127, 128, 255]);
  const requests: {
    url: string | undefined;
    authorization: string | undefined;
    cookie: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    if (request.url === '/redirect')
      response
        .writeHead(302, { Location: '/payload', 'Set-Cookie': 'TEST_cookie=must-not-forward' })
        .end();
    else response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
  const address = server.address();
  assert(address && typeof address !== 'string');
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- Real HTTP transfer only to the test-owned loopback server.
  const url = `http://127.0.0.1:${address.port}/redirect`;
  const destination = path.join(root, 'installer.dmg');
  await downloadAnonymousMacInstaller(url, destination);
  const actual = await readFile(destination);
  assert.deepEqual(actual, payload);
  assert.equal(digest(actual), digest(payload));
  assert.deepEqual(requests, [
    { url: '/redirect', authorization: undefined, cookie: undefined },
    { url: '/payload', authorization: undefined, cookie: undefined },
  ]);
  await assert.rejects(downloadAnonymousMacInstaller(url, destination), { code: 'EEXIST' });
  assert.deepEqual(await readFile(destination), payload);
});

void test('HTTP failure creates no installer and cannot overwrite existing evidence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-mac-installer-http-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer((_request, response) =>
    response.writeHead(403).end('TEST forbidden')
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
  const address = server.address();
  assert(address && typeof address !== 'string');
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- Real HTTP failure only from the test-owned loopback server.
  const url = `http://127.0.0.1:${address.port}/installer`;
  const destination = path.join(root, 'installer.dmg');
  await assert.rejects(downloadAnonymousMacInstaller(url, destination), /HTTP 403/);
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
  await writeFile(destination, 'TEST retained evidence');
  await assert.rejects(downloadAnonymousMacInstaller(url, destination), /HTTP 403/);
  assert.equal(await readFile(destination, 'utf8'), 'TEST retained evidence');
});
