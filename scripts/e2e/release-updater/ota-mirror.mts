import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { repository } from './inputs.mts';

import type { FileProof } from '../../ci/release/contract.ts';
import type { ServerResponse } from 'node:http';
import type { loadInputs, Release } from './inputs.mts';

interface RequestRecord {
  method: string;
  path: string;
  session: string | null;
  range?: string;
  status: number;
  transferred: number;
  error?: string;
}
interface ImageRange {
  start: number;
  end: number;
  status: 200 | 206;
}
const xml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

function imageRange(range: string | undefined, size: number): ImageRange | null {
  let start = 0;
  let end = size - 1;
  if (!range) return { start, end, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  if (match[1]) {
    start = Number(match[1]);
    if (match[2]) end = Math.min(Number(match[2]), size - 1);
  } else start = Math.max(0, size - Number(match[2]));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return null;
  return { start, end, status: 206 };
}

async function streamImage(
  response: ServerResponse,
  file: string,
  range: ImageRange,
  record: RequestRecord
) {
  const stream = createReadStream(file, {
    start: range.start,
    end: range.end,
    highWaterMark: 256 * 1024,
  });
  response.once('close', () => stream.destroy());
  try {
    for await (const chunk of stream) {
      if (response.destroyed) break;
      assert(Buffer.isBuffer(chunk), 'Installer stream must emit Buffers');
      record.transferred += chunk.length;
      if (!response.write(chunk)) await once(response, 'drain');
      // Network pacing exposes genuine progress without fabricating events.
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    response.end();
  } catch (error) {
    record.error = String(error);
    response.destroy();
  }
}

// Real installer bytes, including single ranges used by the shipped updater.
// Only publication visibility changes in release API snapshots; notes stay real.
export async function startOtaMirror(
  inputs: Awaited<ReturnType<typeof loadInputs>>,
  directory: string,
  feed: string
) {
  const requests: RequestRecord[] = [];
  const image = inputs.verified.find((item) => item.file === 'target.AppImage');
  assert(image, 'Missing verified installer bytes');
  const published = { ...inputs.draft, draft: false };
  const entries = [published, inputs.source]
    .map(
      (release: Release) =>
        `<entry><id>${release.id}</id><title>${xml(release.name ?? release.tag_name)}</title><updated>${xml(release.created_at)}</updated><link href="https://github.com/${repository}/releases/tag/${release.tag_name}"/><content type="text">${xml(release.body ?? '')}</content></entry>`
    )
    .join('');
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
  const prefix = `/github/${repository}/releases`;
  const routes = new Map([
    [`${prefix}.atom`, { body: atom, type: 'application/atom+xml' }],
    [`${prefix}/latest`, { body: JSON.stringify(published), type: 'application/json' }],
    [
      `/api/repos/${repository}/releases/tags/${inputs.targetTag}`,
      { body: JSON.stringify(published), type: 'application/json' },
    ],
    [
      `${prefix}/download/${inputs.targetTag}/latest-linux.yml`,
      { body: feed, type: 'application/yaml' },
    ],
  ]);
  const imagePath = `${prefix}/download/${inputs.targetTag}/${image.name}`;
  const size = image.size;
  const server = createServer((request, response) => {
    const serve = async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? '';
      const record: RequestRecord = {
        method,
        path: url.pathname,
        session: url.searchParams.get('TEST_session'),
        range: request.headers.range,
        status: 404,
        transferred: 0,
      };
      requests.push(record);
      const route = routes.get(url.pathname);
      if (!['GET', 'HEAD'].includes(method) || (!route && url.pathname !== imagePath)) {
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
      const range = imageRange(request.headers.range, size);
      if (!range) {
        record.status = 416;
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      record.status = range.status;
      response.writeHead(record.status, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': range.end - range.start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        ...(range.status === 206
          ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` }
          : {}),
      });
      if (method === 'HEAD') {
        response.end();
        return;
      }
      await streamImage(response, path.join(directory, 'target.AppImage'), range, record);
    };
    void serve().catch((error) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    paths: [...routes.keys(), imagePath],
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function assertProviderRoutes(requests: RequestRecord[], targetTag: string) {
  for (const route of [
    '/github/777genius/agent-teams-ai/releases.atom',
    '/github/777genius/agent-teams-ai/releases/latest',
    `/github/777genius/agent-teams-ai/releases/download/${targetTag}/latest-linux.yml`,
  ])
    assert(
      requests.some(
        (request) =>
          request.path === route &&
          request.method === 'GET' &&
          request.session === 'electron-updater' &&
          request.status === 200
      ),
      `Missing genuine provider GET: ${route}`
    );
}
export function assertDownloadRoutes(
  requests: RequestRecord[],
  targetTag: string,
  targetPin: FileProof
) {
  assertProviderRoutes(requests, targetTag);
  const image = `/github/777genius/agent-teams-ai/releases/download/${targetTag}/${targetPin.name}`;
  assert(
    requests.some(
      (request) =>
        request.path === `/api/repos/777genius/agent-teams-ai/releases/tags/${targetTag}` &&
        request.method === 'GET' &&
        request.session === 'default' &&
        request.status === 200
    ),
    'Missing service release API GET'
  );
  assert(
    requests.some(
      (request) =>
        request.path === image &&
        request.method === 'HEAD' &&
        request.session === 'default' &&
        request.status === 200
    ),
    'Missing service AppImage HEAD'
  );
  assert(
    requests.some(
      (request) =>
        request.path === image &&
        request.method === 'GET' &&
        request.session === 'electron-updater' &&
        request.status === 200 &&
        request.transferred === targetPin.size
    ),
    'Missing complete genuine installer GET'
  );
}
