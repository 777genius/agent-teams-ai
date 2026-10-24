import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

import { windowsMirror } from './windows-mirror.mts';

import type { windowsInputs } from './windows-mirror.mts';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface OtaRequest {
  method: string;
  path: string;
  session: string | null;
  range?: string;
  contentRange?: string;
  status: number;
  expected: number;
  transferred: number;
  completed: boolean;
  startedAt: string;
  elapsedMs?: number;
  error?: string;
}

async function streamOfficialBytes(
  response: IncomingMessage,
  outgoing: ServerResponse,
  entry: OtaRequest
) {
  for await (const chunk of response) {
    assert(Buffer.isBuffer(chunk), 'Mirror must preserve official binary bytes');
    if (entry.path.endsWith('.exe'))
      await new Promise((resolve) =>
        setTimeout(resolve, Math.ceil((chunk.length * 1000) / (8 * 1024 * 1024)))
      );
    if (outgoing.destroyed) break;
    if (!outgoing.write(chunk))
      await new Promise<void>((resolve) => {
        const finish = () => {
          outgoing.off('drain', finish);
          outgoing.off('close', finish);
          resolve();
        };
        outgoing.once('drain', finish);
        outgoing.once('close', finish);
      });
    entry.transferred += chunk.length;
  }
  if (!outgoing.destroyed) outgoing.end();
}

export function proveWindowsProvider(
  requests: OtaRequest[],
  targetVersion: string,
  targetName?: string
) {
  for (const ending of [
    '/releases.atom',
    '/releases/latest',
    `/download/v${targetVersion}/latest.yml`,
  ])
    assert(
      requests.some(
        (entry) =>
          entry.session === 'electron-updater' &&
          entry.method === 'GET' &&
          entry.path.endsWith(ending) &&
          entry.status === 200 &&
          entry.completed
      )
    );
  if (targetName) {
    assert(
      requests.some(
        (entry) =>
          entry.session === 'default' &&
          entry.method === 'HEAD' &&
          entry.path.endsWith(`/${targetName}`) &&
          entry.status === 200 &&
          entry.completed
      )
    );
    assert(
      requests.some(
        (entry) =>
          entry.session === 'default' &&
          entry.method === 'GET' &&
          entry.path.endsWith(`/releases/tags/v${targetVersion}`) &&
          entry.status === 200 &&
          entry.completed
      )
    );
  }
}

// The existing immutable mirror owns metadata and exact artifact bytes. A
// loopback streaming proxy paces those same bytes so genuine progress can paint.
export async function windowsOtaMirror(
  inputs: Awaited<ReturnType<typeof windowsInputs>>,
  directory: string
) {
  const upstream = await windowsMirror(inputs, directory);
  const requests: OtaRequest[] = [];
  const server = createServer((incoming, outgoing) => {
    const started = Date.now();
    const raw = incoming.url ?? '/';
    let requested: URL;
    try {
      requested = new URL(raw, upstream.origin);
    } catch {
      outgoing.writeHead(404).end();
      return;
    }
    if (
      !raw.startsWith('/') ||
      raw.startsWith('//') ||
      requested.origin !== upstream.origin ||
      !upstream.paths.includes(requested.pathname)
    ) {
      outgoing.writeHead(404).end();
      return;
    }
    // Forward only approved path/search through the fixed immutable upstream.
    const destination = new URL(upstream.origin);
    destination.pathname = requested.pathname;
    destination.search = requested.search;
    const entry: OtaRequest = {
      method: incoming.method ?? '',
      path: destination.pathname,
      session: destination.searchParams.get('TEST_session'),
      range: incoming.headers.range,
      status: 0,
      expected: 0,
      transferred: 0,
      completed: false,
      startedAt: new Date(started).toISOString(),
    };
    requests.push(entry);
    const request = httpRequest(destination, {
      method: entry.method,
      headers: entry.range ? { Range: entry.range } : {},
    });
    request.on('error', (error) => {
      entry.error = String(error);
      outgoing.destroy(error);
    });
    outgoing.on('finish', () => {
      entry.completed = true;
      entry.elapsedMs = Date.now() - started;
    });
    outgoing.on('close', () => {
      request.destroy();
      entry.elapsedMs ??= Date.now() - started;
    });
    request.on('response', (response) => {
      entry.status = response.statusCode ?? 0;
      entry.expected =
        entry.method === 'HEAD' ? 0 : Number(response.headers['content-length'] ?? 0);
      entry.contentRange = response.headers['content-range'];
      outgoing.writeHead(entry.status, response.headers);
      void streamOfficialBytes(response, outgoing, entry).catch((error: unknown) => {
        entry.error = String(error);
        outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
      });
      outgoing.once('close', () => response.destroy());
    });
    request.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    paths: upstream.paths,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await upstream.close();
    },
  };
}

export function proveWindowsDownload(
  requests: OtaRequest[],
  mode: 'full' | 'cold' | 'warm',
  target: { name: string; size: number },
  priorBlockmap: string,
  logs: string
) {
  const targetRequests = requests.filter(
    (entry) => entry.method === 'GET' && entry.path.endsWith(`/${target.name}`)
  );
  assert(targetRequests.length > 0, 'Original updater must actually fetch installer bytes');
  for (const entry of targetRequests) {
    assert.equal(entry.session, 'electron-updater');
    assert.equal(entry.completed, true, 'Installer response must finish');
    assert.equal(entry.error, undefined);
    assert(entry.expected > 0 && entry.transferred === entry.expected);
  }
  const fallbacks = logs
    .split('\n')
    .filter((line) => line.includes('Cannot download differentially, fallback to full download'));
  const oldMaps = requests.filter(
    (entry) => entry.method === 'GET' && entry.path.endsWith(`/${priorBlockmap}`)
  );
  const newMaps = requests.filter(
    (entry) => entry.method === 'GET' && entry.path.endsWith(`/${target.name}.blockmap`)
  );
  assert(newMaps.some((entry) => entry.status === 200 && entry.completed && entry.transferred > 0));
  if (mode === 'full') {
    assert(fallbacks.length > 0, 'Missing prior installer must exercise genuine full fallback');
    assert.equal(targetRequests.length, 1);
    assert.equal(targetRequests[0]?.status, 200);
    assert.equal(targetRequests[0]?.range, undefined);
    assert.equal(targetRequests[0]?.transferred, target.size);
  } else {
    assert.equal(fallbacks.length, 0, 'Differential gate must reject full fallback');
    assert(
      targetRequests.every((entry) => entry.status === 206 && entry.range && entry.contentRange)
    );
    assert(
      targetRequests.reduce((sum, entry) => sum + entry.transferred, 0) < target.size,
      'Ranges must actually save transferred installer bytes'
    );
    if (mode === 'cold')
      assert(
        oldMaps.some((entry) => entry.status === 200 && entry.completed && entry.transferred > 0)
      );
    else
      assert.equal(
        oldMaps.length,
        0,
        'Warm blockmap must actually come from installed updater cache'
      );
  }
  return {
    mode,
    differentialProved: mode !== 'full',
    transferred: targetRequests.reduce((sum, entry) => sum + entry.transferred, 0),
    targetSize: target.size,
    fallbacks,
    oldBlockmapGets: oldMaps.length,
    targetRanges: targetRequests,
  };
}
