import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { repository } from './inputs.mts';
import { packageCases } from './linux-packages-inputs.mts';

import type { packageInputs, PackageKind } from './linux-packages-inputs.mts';

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
interface ByteRange {
  start: number;
  end: number;
  status: 200 | 206;
}
function byteRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return null;
  return { start, end, status: 206 };
}
async function streamPackage(
  response: import('node:http').ServerResponse,
  file: string,
  range: ByteRange,
  record: { transferred: number; error?: string }
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
      assert(Buffer.isBuffer(chunk));
      record.transferred += chunk.length;
      if (!response.write(chunk)) await once(response, 'drain');
      // Actual byte pacing makes genuine UI progress observable.
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    response.end();
  } catch (error) {
    record.error = String(error);
    response.destroy();
  }
}
export async function packageMirror(
  inputs: Awaited<ReturnType<typeof packageInputs>>,
  directory: string,
  kind: PackageKind
) {
  const requests: {
    method: string;
    path: string;
    session: string | null;
    range?: string;
    status: number;
    transferred: number;
    error?: string;
  }[] = [];
  const published = { ...inputs.target, draft: false };
  const prefix = `/github/${repository}/releases`;
  const entries = [published, inputs.source]
    .map(
      (release) =>
        `<entry><id>${release.id}</id><title>${xml(release.name ?? release.tag_name)}</title><updated>${xml(release.created_at)}</updated><link href="https://github.com/${repository}/releases/tag/${release.tag_name}"/><content type="text">${xml(release.body ?? '')}</content></entry>`
    )
    .join('');
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
  const routes = new Map([
    [`${prefix}.atom`, { body: atom, type: 'application/atom+xml' }],
    [`${prefix}/latest`, { body: JSON.stringify(published), type: 'application/json' }],
    [
      `/api/repos/${repository}/releases/tags/v2.17.2`,
      { body: JSON.stringify(published), type: 'application/json' },
    ],
    [
      `${prefix}/download/v2.17.2/latest-linux.yml`,
      { body: inputs.feed, type: 'application/yaml' },
    ],
  ]);
  const installer = `${prefix}/download/v2.17.2/${packageCases[kind].target}`;
  const appImage = `${prefix}/download/v2.17.2/Agent.Teams.AI-2.17.2.AppImage`;
  const file = inputs.verified.find((item) => item.name === packageCases[kind].target);
  assert(file);
  const image = inputs.verified.find((item) => item.name === 'Agent.Teams.AI-2.17.2.AppImage');
  assert(image);
  const server = createServer((request, response) => {
    const serve = async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? '';
      const record = {
        method,
        path: url.pathname,
        session: url.searchParams.get('TEST_session'),
        range: request.headers.range,
        status: 404,
        transferred: 0,
      } as (typeof requests)[number];
      requests.push(record);
      const route = routes.get(url.pathname);
      if (!['GET', 'HEAD'].includes(method)) {
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
      // UpdaterService validates AppImage availability for every Linux format.
      // Its HEAD is independent of the genuine native updater's package GET.
      if (url.pathname === appImage && method === 'HEAD') {
        record.status = 200;
        response
          .writeHead(200, {
            'Content-Length': image.size,
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store',
          })
          .end();
        return;
      }
      if (url.pathname !== installer) {
        response.writeHead(404).end();
        return;
      }
      const range = byteRange(request.headers.range, file.size);
      if (!range) {
        record.status = 416;
        response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end();
        return;
      }
      record.status = range.status;
      response.writeHead(record.status, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': range.end - range.start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        ...(record.status === 206
          ? { 'Content-Range': `bytes ${range.start}-${range.end}/${file.size}` }
          : {}),
      });
      if (method === 'HEAD') {
        response.end();
        return;
      }
      await streamPackage(response, path.join(directory, file.name), range, record);
    };
    void serve().catch((error) =>
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    paths: [...routes.keys(), installer, appImage],
    requests,
    installer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
