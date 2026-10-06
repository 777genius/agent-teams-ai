import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { stringify } from 'yaml';

import { hashFile } from './inputs.mts';
import { planWindowsInputs, windowsPredecessorPins } from './windows-plan-inputs.mts';

import type { WindowsInputSet } from './windows-plan-inputs.mts';

export const windowsPins = [
  ...windowsPredecessorPins,
  {
    tag: 'v2.17.2',
    arch: 'x64',
    name: 'Agent.Teams.AI.Setup.2.17.2.exe',
    size: 228626544,
    sha256: '3c5b8a78240baefdb0c2a05377ccdda1c4ae1e4f7cbb412f368d3520b9c76ba5',
  },
  {
    tag: 'v2.17.2',
    arch: 'x64',
    name: 'Agent.Teams.AI.Setup.2.17.2.exe.blockmap',
    size: 235962,
    sha256: '4e9097357cc717b5c0c34f0f7d971df68865ca19b0beff64bc4b07fea71cb191',
  },
  {
    tag: 'v2.17.2',
    arch: 'arm64',
    name: 'Agent.Teams.AI.Setup.2.17.2-arm64.exe',
    size: 218272602,
    sha256: 'a7c1a69c788c85a2a8b43e4f3c18b36e1a32c51e109871978ac26ce51afb4da9',
  },
  {
    tag: 'v2.17.2',
    arch: 'arm64',
    name: 'Agent.Teams.AI.Setup.2.17.2-arm64.exe.blockmap',
    size: 224367,
    sha256: '71eeab1a1e8f20940b14849b424d616f4068b130787b269604e13c8ec3837eba',
  },
] as const;
export type { WindowsInputSet, WindowsProofPin } from './windows-plan-inputs.mts';
type WindowsRelease = WindowsInputSet['source'];
export interface WindowsInputMode {
  plan?: string;
  legacy2172?: boolean;
}
export function readWindowsInputMode(args = process.argv.slice(2)): WindowsInputMode {
  const index = args.indexOf('--plan');
  const legacy2172 = args.includes('--legacy-2172');
  const plan = index < 0 ? undefined : args[index + 1];
  assert(index < 0 || (plan && !plan.startsWith('--')), '--plan file required');
  assert(Boolean(plan) !== legacy2172, 'Explicit --plan or --legacy-2172 required');
  return { plan: plan ? path.resolve(plan) : undefined, legacy2172 };
}
export async function windowsInputs(
  directory: string,
  mode: WindowsInputMode
): Promise<WindowsInputSet> {
  assert(
    Boolean(mode.plan) !== Boolean(mode.legacy2172),
    'Choose an immutable 2.17.4 plan or explicit legacy 2.17.2 infrastructure fixture'
  );
  if (mode.plan)
    return planWindowsInputs(
      directory,
      mode.plan,
      windowsPins.filter((pin) => pin.tag === 'v2.17.1')
    );
  const source = JSON.parse(
    await readFile(path.join(directory, 'source-api.json'), 'utf8')
  ) as WindowsRelease;
  const target = JSON.parse(
    await readFile(path.join(directory, 'draft-api.json'), 'utf8')
  ) as WindowsRelease;
  assert.equal(source.id, 398386033);
  assert.equal(source.tag_name, 'v2.17.1');
  assert.equal(source.target_commitish, '395572f9ff2a261cb28224754883a39d2c3c8827');
  assert.equal(source.draft, false);
  assert.equal(source.prerelease, false);
  assert.equal(target.id, 401358336);
  assert.equal(target.tag_name, 'v2.17.2');
  assert.equal(target.target_commitish, '359417f642abb97429aa6eb1a92f3ce52254e5f4');
  assert.equal(target.draft, true);
  assert.equal(target.prerelease, false);
  const verified = [];
  for (const pin of windowsPins) {
    const actual = await hashFile(path.join(directory, pin.name));
    assert.equal(actual.size, pin.size, pin.name);
    assert.equal(actual.sha256, pin.sha256, pin.name);
    const api = (pin.tag === 'v2.17.1' ? source : target).assets.filter(
      (asset) => asset.name === pin.name
    );
    assert.equal(api.length, 1, pin.name);
    assert.equal(api[0]?.size, pin.size, pin.name);
    assert.equal(api[0]?.digest, `sha256:${pin.sha256}`, `Independent API digest ${pin.name}`);
    verified.push({ ...pin, sha512: actual.sha512 });
  }
  const installers = verified.filter((pin) => pin.tag === 'v2.17.2' && pin.name.endsWith('.exe'));
  const x64 = installers.find((pin) => pin.arch === 'x64');
  assert(x64);
  // Shipped Provider.findFile falls back to the first EXE for an x64 filename
  // without an explicit architecture suffix. Preserve this real contract.
  const feed = stringify({
    version: '2.17.2',
    files: installers.map((pin) => ({ url: pin.name, sha512: pin.sha512, size: pin.size })),
    path: x64.name,
    sha512: x64.sha512,
    releaseDate: target.created_at,
  });
  const inputDigest = createHash('sha256')
    .update(JSON.stringify({ source, target, verified }))
    .digest('hex');
  return {
    source,
    target,
    verified,
    feed,
    inputDigest,
    targetVersion: '2.17.2',
    legacyFixture: true,
  };
}

const xml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export async function windowsMirror(
  inputs: Awaited<ReturnType<typeof windowsInputs>>,
  directory: string
) {
  const published = { ...inputs.target, draft: false };
  const prefix = '/github/777genius/agent-teams-ai/releases';
  const entries = [published, inputs.source]
    .map(
      (release) =>
        `<entry><id>${release.id}</id><title>${xml(release.name ?? release.tag_name)}</title><updated>${xml(release.created_at)}</updated><link href="https://github.com/777genius/agent-teams-ai/releases/tag/${release.tag_name}"/><content type="text">${xml(release.body ?? '')}</content></entry>`
    )
    .join('');
  const routes = new Map([
    [
      `${prefix}.atom`,
      {
        body: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`,
        type: 'application/atom+xml',
      },
    ],
    [`${prefix}/latest`, { body: JSON.stringify(published), type: 'application/json' }],
    [
      `/api/repos/777genius/agent-teams-ai/releases/tags/${inputs.target.tag_name}`,
      { body: JSON.stringify(published), type: 'application/json' },
    ],
    [
      `${prefix}/download/${inputs.target.tag_name}/latest.yml`,
      { body: inputs.feed, type: 'application/yaml' },
    ],
  ]);
  const assets = new Map(
    inputs.verified.map((pin) => [`${prefix}/download/${pin.tag}/${pin.name}`, pin])
  );
  const requests: {
    method: string;
    path: string;
    session: string | null;
    range?: string;
    status: number;
    transferred: number;
  }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? '';
    const record = {
      method,
      path: url.pathname,
      session: url.searchParams.get('TEST_session'),
      range: request.headers.range,
      status: 404,
      transferred: 0,
    };
    requests.push(record);
    const route = routes.get(url.pathname);
    const asset = assets.get(url.pathname);
    if (!['HEAD', 'GET'].includes(method) || (!route && !asset)) {
      response.writeHead(404).end();
      return;
    }
    if (route) {
      record.status = 200;
      response.writeHead(200, {
        'Content-Type': route.type,
        'Content-Length': Buffer.byteLength(route.body),
        'Cache-Control': 'no-store',
      });
      response.end(method === 'HEAD' ? undefined : route.body);
      return;
    }
    assert(asset);
    let start = 0;
    let end = asset.size - 1;
    if (record.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(record.range);
      if (!match) {
        record.status = 416;
        response.writeHead(416).end();
        return;
      }
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= asset.size
    ) {
      record.status = 416;
      response.writeHead(416, { 'Content-Range': `bytes */${asset.size}` }).end();
      return;
    }
    record.status = record.range ? 206 : 200;
    response.writeHead(record.status, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(record.range ? { 'Content-Range': `bytes ${start}-${end}/${asset.size}` } : {}),
    });
    if (method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(path.join(directory, asset.name), { start, end });
    stream.on('data', (chunk: string | Buffer) => {
      assert(Buffer.isBuffer(chunk), 'Official asset stream must emit Buffers');
      record.transferred += chunk.length;
    });
    stream.on('error', (error) => response.destroy(error));
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    paths: [...routes.keys(), ...assets.keys()],
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

if (process.argv.includes('--verify-inputs')) {
  const index = process.argv.indexOf('--verify-inputs');
  const directory = process.argv[index + 1];
  assert(directory);
  const inputs = await windowsInputs(path.resolve(directory), readWindowsInputMode());
  await writeFile(
    path.join(directory, 'windows-input-verification.json'),
    JSON.stringify(
      {
        verified: inputs.verified,
        inputDigest: inputs.inputDigest,
        targetVersion: inputs.targetVersion,
        legacyFixture: inputs.legacyFixture,
        plan: inputs.plan,
      },
      null,
      2
    )
  );
}
