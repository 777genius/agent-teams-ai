import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getCrossTeamRecipient } = require('../src/internal/appRouting.js') as {
  getCrossTeamRecipient(context: { claudeDir: string; teamName: string }, toTeam: string): Promise<unknown>;
};
const { requestJson } = require('../src/internal/controlApiClient.js') as {
  requestJson(baseUrl: string, pathname: string, options?: { timeoutMs: number }): Promise<unknown>;
};

describe('app control routing errors', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('does not use offline routing when an app answered 404 before another address failed', async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'TEST-control-routing-'));
    roots.push(claudeDir);
    writeFileSync(join(claudeDir, 'team-control-api.json'), JSON.stringify({ baseUrl: 'http://first' }));
    vi.stubEnv('CLAUDE_TEAM_CONTROL_URL', 'http://second');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'route missing' }), { status: 404 }))
      .mockRejectedValueOnce(new TypeError('network unavailable')));
    await expect(getCrossTeamRecipient({ claudeDir, teamName: 'team' }, 'partner'))
      .rejects.toMatchObject({ retryableKind: 'status', statusCode: 404 });
  });

  it('reports a timeout if response headers arrive but the body stalls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (_url: string, options: { signal: AbortSignal }) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    }));
    const response = requestJson('http://app', '/board', { timeoutMs: 1000 });
    const assertion = expect(response).rejects.toMatchObject({ retryableKind: 'timeout' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('keeps the offline fallback when every published address is unreachable', async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'TEST-control-offline-'));
    roots.push(claudeDir);
    writeFileSync(join(claudeDir, 'team-control-api.json'), JSON.stringify({ baseUrl: 'http://first' }));
    vi.stubEnv('CLAUDE_TEAM_CONTROL_URL', 'http://second');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));
    await expect(getCrossTeamRecipient({ claudeDir, teamName: 'team' }, 'partner')).resolves.toBeNull();
  });
});
