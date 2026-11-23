import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const { showConnectionConfirmation } = require('../src/internal/runtime.js') as {
  showConnectionConfirmation(
    context: { claudeDir: string; teamName: string },
    flags: {
      agentName: string;
      expectedContext: {
        appInstanceId: string;
        dataRootFingerprint: string;
        connectionGeneration: number;
      };
    }
  ): Promise<{ accepted: boolean }>;
};

const roots: string[] = [];
const flags = {
  agentName: 'Codex',
  expectedContext: {
    appInstanceId: 'sandbox-instance',
    dataRootFingerprint: 'sandbox-root',
    connectionGeneration: 1,
  },
};
function context() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'TEST-confirm-fallback-'));
  roots.push(claudeDir);
  writeFileSync(
    join(claudeDir, 'team-control-api.json'),
    JSON.stringify({ baseUrl: 'http://stale.test' })
  );
  vi.stubEnv('CLAUDE_TEAM_CONTROL_URL', 'http://live.test');
  return { claudeDir, teamName: 'sandbox' };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('falls back after a refused connection without repeating an accepted POST', async () => {
  const failure = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
  });
  const request = vi.fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  vi.stubGlobal('fetch', request);
  await expect(showConnectionConfirmation(context(), flags)).resolves.toEqual({ accepted: true });
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    'http://stale.test/api/app/connection/confirmation',
    'http://live.test/api/app/connection/confirmation',
  ]);
});

it('falls back when the first address has no confirmation route', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  vi.stubGlobal('fetch', request);
  await expect(showConnectionConfirmation(context(), flags)).resolves.toEqual({ accepted: true });
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not replay a rejected or ambiguous POST on another address', async () => {
  const request = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'window not ready' }), { status: 503 })
  );
  vi.stubGlobal('fetch', request);
  await expect(showConnectionConfirmation(context(), flags)).rejects.toMatchObject({
    retryableKind: 'status',
    statusCode: 503,
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it('does not retry a timed-out POST', async () => {
  vi.useFakeTimers();
  const request = vi.fn((_url: string, options: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })
  );
  vi.stubGlobal('fetch', request);
  const result = showConnectionConfirmation(context(), flags);
  const assertion = expect(result).rejects.toMatchObject({ retryableKind: 'timeout' });
  await vi.advanceTimersByTimeAsync(10000);
  await assertion;
  expect(request).toHaveBeenCalledTimes(1);
});
