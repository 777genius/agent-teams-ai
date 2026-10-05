import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { textProof } from '../../ci/release/contract.ts';
import {
  proveWindowsDownload,
  proveWindowsProvider,
  windowsOtaMirror,
} from './windows-ota-mirror.mts';

import type { Release } from '../../ci/release/contract.ts';
import type { WindowsInputSet } from './windows-plan-inputs.mts';

// Actual loopback HTTP byte/range contract only; no installer or native evidence.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-ota-transport-'));
  const source: Release = {
    id: 1,
    tag_name: 'v2.17.1',
    target_commitish: '1'.repeat(40),
    created_at: '2026-10-05T10:00:00Z',
    draft: false,
    prerelease: false,
    name: 'TEST transport source',
    body: 'Synthetic transport fixture only',
    assets: [],
  };
  const target: Release = { ...source, id: 2, tag_name: 'v2.17.3', draft: true };
  const inputs: WindowsInputSet = {
    source,
    target,
    verified: [],
    feed: 'version: 2.17.3\n',
    inputDigest: '2'.repeat(64),
    targetVersion: '2.17.3',
    legacyFixture: false,
  };
  const name = 'Agent.Teams.AI.Setup.2.17.3.exe';
  const priorMap = 'Agent.Teams.AI.Setup.2.17.1.exe.blockmap';
  const bytes = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256));
  for (const [filename, tag, data] of [
    [name, target.tag_name, bytes],
    [`${name}.blockmap`, target.tag_name, Buffer.from('TEST new blockmap')],
    [priorMap, source.tag_name, Buffer.from('TEST old blockmap')],
  ] as const) {
    await writeFile(path.join(root, filename), data);
    inputs.verified.push({ ...textProof(filename, data), tag, arch: 'x64' });
  }
  const mirror = await windowsOtaMirror(inputs, root);
  const prefix = '/github/777genius/agent-teams-ai/releases';
  const installer = `${prefix}/download/${target.tag_name}/${name}`;
  async function get(
    url: string,
    session = 'electron-updater',
    headers: Record<string, string> = {}
  ) {
    const response = await fetch(`${mirror.origin}${url}?TEST_session=${session}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const data = Buffer.from(await response.arrayBuffer());
    return { response, data };
  }
  return {
    mirror,
    bytes,
    name,
    priorMap,
    prefix,
    installer,
    get,
    close: async () => {
      await mirror.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

await test('real ranges preserve bytes and differential proof rejects fallback or truncation', async () => {
  const f = await fixture();
  try {
    await f.get(`${f.installer}.blockmap`);
    await f.get(`${f.prefix}/download/v2.17.1/${f.priorMap}`);
    const range = await f.get(f.installer, 'electron-updater', { Range: 'bytes=17-91' });
    assert.equal(range.response.status, 206);
    assert.equal(range.response.headers.get('content-range'), 'bytes 17-91/1024');
    assert.deepEqual(range.data, f.bytes.subarray(17, 92));
    const target = { name: f.name, size: f.bytes.length };
    const proof = proveWindowsDownload(f.mirror.requests, 'cold', target, f.priorMap, '');
    assert.equal(proof.transferred, 75);
    for (const replacement of [{ completed: false }, { transferred: 74 }, { status: 200 }]) {
      const tampered = f.mirror.requests.map((entry) =>
        entry.path === f.installer ? { ...entry, ...replacement } : entry
      );
      assert.throws(() => proveWindowsDownload(tampered, 'cold', target, f.priorMap, ''));
    }
    assert.throws(() => proveWindowsDownload(f.mirror.requests, 'warm', target, f.priorMap, ''));
    assert.throws(() =>
      proveWindowsDownload(
        f.mirror.requests,
        'cold',
        target,
        f.priorMap,
        'Cannot download differentially, fallback to full download'
      )
    );
    const invalid = await f.get(f.installer, 'electron-updater', { Range: 'bytes=0-1,4-5' });
    assert.equal(invalid.response.status, 416);
  } finally {
    await f.close();
  }
});

await test('full fallback requires the complete actual response and fallback log marker', async () => {
  const f = await fixture();
  try {
    await f.get(`${f.installer}.blockmap`);
    const complete = await f.get(f.installer);
    assert.equal(complete.response.status, 200);
    assert.deepEqual(complete.data, f.bytes);
    const target = { name: f.name, size: f.bytes.length };
    const logs = 'Cannot download differentially, fallback to full download';
    const proof = proveWindowsDownload(f.mirror.requests, 'full', target, f.priorMap, logs);
    assert.equal(proof.transferred, 1024);
    assert.throws(() => proveWindowsDownload(f.mirror.requests, 'full', target, f.priorMap, ''));
    assert.throws(() => proveWindowsDownload(f.mirror.requests, 'cold', target, f.priorMap, ''));
  } finally {
    await f.close();
  }
});

await test('provider proof needs completed actual requests from both session partitions', async () => {
  const f = await fixture();
  try {
    for (const url of [
      `${f.prefix}.atom`,
      `${f.prefix}/latest`,
      `${f.prefix}/download/v2.17.3/latest.yml`,
    ])
      await f.get(url);
    const head = await fetch(`${f.mirror.origin}${f.installer}?TEST_session=default`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    await f.get('/api/repos/777genius/agent-teams-ai/releases/tags/v2.17.3', 'default');
    proveWindowsProvider(f.mirror.requests, '2.17.3', f.name);
    assert.throws(() => proveWindowsProvider(f.mirror.requests, '2.17.2', f.name));
    const wrongSession = f.mirror.requests.map((entry) => ({
      ...entry,
      session: 'electron-updater',
    }));
    assert.throws(() => proveWindowsProvider(wrongSession, '2.17.3', f.name));
    assert.throws(() =>
      proveWindowsProvider(
        f.mirror.requests.map((entry) => ({ ...entry, completed: false })),
        '2.17.3',
        f.name
      )
    );
  } finally {
    await f.close();
  }
});

await test('proxy rejects foreign network-path and absolute-form authority without forwarding', async () => {
  const f = await fixture();
  let foreignRequests = 0;
  const foreign = createServer((_incoming, outgoing) => {
    foreignRequests++;
    outgoing.end('TEST foreign bytes');
  });
  await new Promise<void>((resolve, reject) => {
    foreign.once('error', reject);
    foreign.listen(0, '127.0.0.1', resolve);
  });
  const address = foreign.address();
  assert(address && typeof address !== 'string');
  try {
    for (const raw of [
      `//127.0.0.1:${address.port}${f.installer}`,
      `http://127.0.0.1:${address.port}${f.installer}`,
      '/unapproved-route',
    ]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const child = request(
          f.mirror.origin,
          { path: raw, signal: AbortSignal.timeout(5000) },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
            response.once('error', reject);
          }
        );
        child.once('error', reject);
        child.end();
      });
      assert.equal(status, 404);
      assert.equal(foreignRequests, 0, 'Foreign TEST server must receive no request');
    }
  } finally {
    foreign.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      foreign.close((error) => (error ? reject(error) : resolve()))
    );
    await f.close();
  }
});
