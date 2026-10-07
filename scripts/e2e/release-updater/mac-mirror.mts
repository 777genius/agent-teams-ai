import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';

import type { Release, StagePlan } from '../../ci/release/contract.ts';

const repository = '777genius/agent-teams-ai';
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export interface MacMirrorRequest {
  method: string;
  path: string;
  session: string | null;
  status: number;
  range?: string;
  completed: boolean;
  bytes: number;
}
// Only transport is redirected. Original GitHubProvider and Squirrel retain their implementations.
export async function macReleaseMirror(
  plan: StagePlan,
  source: Release,
  files: Map<string, { file: string; size: number }>,
  feed: string,
  options: { rejectInstallerGet?: boolean } = {}
) {
  const published = {
    ...source,
    id: plan.input.target.id,
    tag_name: plan.input.target.tag,
    target_commitish: plan.input.target.applicationSha,
    created_at: plan.input.target.createdAt,
    name: plan.input.target.name,
    body: plan.input.target.body,
    draft: false,
    prerelease: false,
  };
  const releases = [published, source];
  const entries = releases
    .map(
      (release) =>
        `<entry><id>${release.id}</id><title>${xml(release.name ?? release.tag_name)}</title><updated>${xml(release.created_at)}</updated><link href="https://github.com/${repository}/releases/tag/${release.tag_name}"/><content type="text">${xml(release.body ?? '')}</content></entry>`
    )
    .join('');
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
  const routes = new Map<string, { body?: string; type: string; file?: string; size?: number }>();
  routes.set(`/github/${repository}/releases.atom`, { body: atom, type: 'application/atom+xml' });
  for (const route of [
    `/github/${repository}/releases/latest`,
    `/api/repos/${repository}/releases/latest`,
    `/api/repos/${repository}/releases/tags/${plan.input.target.tag}`,
  ])
    routes.set(route, { body: JSON.stringify(published), type: 'application/json' });
  routes.set(`/api/repos/${repository}/releases/tags/v2.17.1`, {
    body: JSON.stringify(source),
    type: 'application/json',
  });
  for (const tag of [plan.input.target.tag, source.tag_name]) {
    routes.set(`/github/${repository}/releases/download/${tag}/latest-mac.yml`, {
      body: feed,
      type: 'application/yaml',
    });
    for (const [name, file] of files)
      routes.set(`/github/${repository}/releases/download/${tag}/${name}`, {
        ...file,
        type: 'application/octet-stream',
      });
  }
  const requests: MacMirrorRequest[] = [];
  const failures: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = routes.get(url.pathname);
    const method = request.method ?? '';
    const entry: MacMirrorRequest = {
      method,
      path: url.pathname,
      session: url.searchParams.get('TEST_session'),
      status: 404,
      range: request.headers.range,
      completed: false,
      bytes: 0,
    };
    requests.push(entry);
    if (!route || !['HEAD', 'GET'].includes(method)) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (route.file && method === 'GET' && options.rejectInstallerGet) {
      entry.status = 409;
      response.writeHead(409, { 'Content-Length': 0 });
      response.end();
      return;
    }
    const size = route.size ?? Buffer.byteLength(route.body ?? '');
    let start = 0;
    let end = size - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!route.file || !match) {
        entry.status = 416;
        response.writeHead(416, { 'Content-Range': `bytes */${size}` });
        response.end();
        return;
      }
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        end >= size
      ) {
        entry.status = 416;
        response.writeHead(416);
        response.end();
        return;
      }
    }
    entry.status = request.headers.range ? 206 : 200;
    response.writeHead(entry.status, {
      'Content-Type': route.type,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(entry.status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    response.once('finish', () => {
      entry.completed = true;
    });
    if (method === 'HEAD') {
      response.end();
      return;
    }
    if (!route.file) {
      entry.bytes = size;
      response.end(route.body);
      return;
    }
    const stream = createReadStream(route.file, { start, end, highWaterMark: 262144 });
    response.once('close', () => stream.destroy());
    // A bounded 32 MiB/s stream leaves observable real download progress without touching updater policy.
    void (async () => {
      for await (const chunk of stream) {
        const bytes = chunk as Buffer;
        entry.bytes += bytes.length;
        if (!response.write(bytes))
          await new Promise<void>((resolve) => response.once('drain', resolve));
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      response.end();
    })().catch((error: unknown) => {
      failures.push(String(error));
      response.destroy();
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
    paths: [...routes.keys()],
    requests,
    failures,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
