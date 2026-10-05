import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { repository } from './inputs.mts';

import type { loadInputs, Release } from './inputs.mts';

export interface RequestRecord {
  method: string;
  path: string;
  session: string | null;
  status: number;
}
const xml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export async function startMirror(inputs: Awaited<ReturnType<typeof loadInputs>>) {
  const requests: RequestRecord[] = [];
  const image = inputs.verified.find((item) => item.file === 'target.AppImage');
  assert(image);
  const published = { ...inputs.draft, draft: false };
  const entries = [published, inputs.source]
    .map(
      (release: Release) =>
        `<entry><id>${release.id}</id><title>${xml(release.name ?? release.tag_name)}</title><updated>${xml(release.created_at)}</updated><link href="https://github.com/${repository}/releases/tag/${release.tag_name}"/><content type="text">${xml(release.body ?? '')}</content></entry>`
    )
    .join('');
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
  const routes = new Map<string, { body: string; type: string; headOnly?: boolean; size?: number }>(
    [
      [`/github/${repository}/releases.atom`, { body: atom, type: 'application/atom+xml' }],
      [
        `/github/${repository}/releases/latest`,
        { body: JSON.stringify(published), type: 'application/json' },
      ],
      [
        `/api/repos/${repository}/releases/latest`,
        { body: JSON.stringify(published), type: 'application/json' },
      ],
      [
        `/api/repos/${repository}/releases/tags/${inputs.targetTag}`,
        { body: JSON.stringify(published), type: 'application/json' },
      ],
      [
        `/github/${repository}/releases/download/${inputs.targetTag}/latest-linux.yml`,
        { body: inputs.feed, type: 'application/yaml' },
      ],
      [
        `/github/${repository}/releases/download/${inputs.targetTag}/${image.name}`,
        { body: '', type: 'application/octet-stream', headOnly: true, size: image.size },
      ],
    ]
  );
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = routes.get(url.pathname);
    const method = request.method ?? '';
    const status =
      route && (method === 'HEAD' || (method === 'GET' && !route.headOnly)) ? 200 : 404;
    requests.push({
      method,
      path: url.pathname,
      session: url.searchParams.get('TEST_session'),
      status,
    });
    response.writeHead(status, {
      'Content-Type': route?.type ?? 'text/plain',
      'Content-Length': status === 200 ? (route?.size ?? Buffer.byteLength(route?.body ?? '')) : 0,
      'Cache-Control': 'no-store',
    });
    response.end(method === 'HEAD' || status !== 200 ? undefined : route?.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    paths: [...routes.keys()],
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}
