import { beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => vi.fn());
vi.mock('@main/utils/childProcess', () => ({ execCli: exec }));
vi.mock('@main/utils/cliPathMerge', () => ({ buildMergedCliPath: () => '/TEST/bin' }));
vi.mock('@main/utils/runtimePathBinaryResolver', () => ({
  findFirstRuntimePathBinaryCandidate: () => '/TEST/bin/gh',
}));

import {
  createGhTransport,
  parseGhResponse,
} from '../../../src/features/pr-monitor/main/infrastructure/ghTransport';

const transport = createGhTransport({ provider: 'github', owner: 'TEST', repo: 'fixture' });
beforeEach(() => {
  exec.mockReset();
});

describe('GitHub CLI read transport', () => {
  it('retains rate limits and decodes JSON without copying credentials', async () => {
    exec.mockResolvedValue({
      stdout: 'HTTP/2.0 200 OK\r\nETag: abc\r\nX-RateLimit-Remaining: 99\r\n\r\n[]',
    });
    expect(
      await transport({
        path: '/repos/TEST/fixture/pulls?page=1',
        headers: { accept: 'application/vnd.github+json', authorization: 'NEVER-FORWARD' },
      })
    ).toEqual({ status: 200, headers: { etag: 'abc', 'x-ratelimit-remaining': '99' }, body: [] });
    const [binary, args, options] = exec.mock.calls[0]!;
    expect(binary).toBe('/TEST/bin/gh');
    expect(args).toContain('GET');
    expect(JSON.stringify(args)).not.toContain('NEVER-FORWARD');
    expect(options.stdoutMaxBuffer).toBe(4 * 1024 * 1024);
    expect(options.timeout).toBe(20_000);
  });
  it.each([
    '/repos/other/private/pulls',
    '/repos/TEST/fixture/../../other/private',
    '/repos/TEST/fixture/%2e%2e/%2e%2e/other',
    'https://evil.test/repos/TEST/fixture/pulls',
    '/repos/TEST/fixture/pulls\n--method=POST',
  ])('refuses an unowned endpoint %s', async (path) => {
    await expect(transport({ path, headers: {} })).rejects.toThrow('Invalid repository request');
    expect(exec).not.toHaveBeenCalled();
  });
  it('retains HTTP failures emitted on a nonzero CLI exit', async () => {
    exec.mockRejectedValue({
      stdout: 'HTTP/2.0 429 Too Many Requests\nRetry-After: 60\n\n{"message":"limited"}',
      stderr: 'private account diagnostic',
    });
    expect(await transport({ path: '/repos/TEST/fixture/pulls', headers: {} })).toEqual({
      status: 429,
      headers: { 'retry-after': '60' },
      body: { message: 'limited' },
    });
  });
  it('sanitizes auth diagnostics and separates network failure', async () => {
    exec.mockRejectedValueOnce({ stderr: 'please run gh auth login SECRET-ACCOUNT' });
    expect(await transport({ path: '/repos/TEST/fixture/pulls', headers: {} })).toEqual({
      status: 401,
      headers: {},
      body: null,
    });
    exec.mockRejectedValueOnce({ stderr: 'dial tcp SECRET-ENDPOINT: offline' });
    await expect(transport({ path: '/repos/TEST/fixture/pulls', headers: {} })).rejects.toThrow(
      'GitHub could not be reached.'
    );
  });
  it('accepts a not-modified response with no body', () => {
    expect(parseGhResponse('HTTP/2.0 304 Not Modified\nETag: same\n\n')).toEqual({
      status: 304,
      headers: { etag: 'same' },
      body: null,
    });
  });
});
