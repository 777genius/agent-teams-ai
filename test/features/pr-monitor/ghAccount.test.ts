import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ exec: vi.fn(), find: vi.fn() }));
vi.mock('@main/utils/childProcess', () => ({ execCli: host.exec }));
vi.mock('@main/utils/cliPathMerge', () => ({ buildMergedCliPath: () => '/TEST/bin' }));
vi.mock('../../../src/features/pr-monitor/main/infrastructure/ghTransport', () => ({
  findGitHubCli: host.find,
}));

import { authenticatedGhAccount } from '../../../src/features/pr-monitor/main/infrastructure/ghAccount';

beforeEach(() => {
  host.exec.mockReset();
  host.find.mockReset().mockReturnValue('/TEST/bin/gh');
});

describe('GitHub CLI active credential identity', () => {
  it('supports gh 2.80 without status JSON and requests only the authenticated login', async () => {
    host.exec.mockImplementation(async (_binary: string, args: string[]) => {
      if (args.includes('--json')) throw new Error('unknown flag: --json');
      return { stdout: '{"login":"First-Account"}\n' };
    });
    const signal = new AbortController().signal;
    expect(await authenticatedGhAccount(signal)).toBe('first-account');
    expect(host.exec).toHaveBeenCalledWith(
      '/TEST/bin/gh',
      ['api', '--hostname', 'github.com', '--method', 'GET', '/user', '--jq', '{login: .login}'],
      expect.objectContaining({
        signal,
        timeout: 20_000,
        stdoutMaxBuffer: 32 * 1024,
        stderrMaxBuffer: 4096,
        env: expect.objectContaining({
          PATH: '/TEST/bin',
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: 'cat',
        }),
      })
    );
  });

  it('rechecks the live credential so callers can fence an account switch', async () => {
    host.exec
      .mockResolvedValueOnce({ stdout: '{"login":"first-account"}' })
      .mockResolvedValueOnce({ stdout: '{"login":"second-account"}' });
    expect(await authenticatedGhAccount()).toBe('first-account');
    expect(await authenticatedGhAccount()).toBe('second-account');
    expect(host.exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    'null',
    '[]',
    '{}',
    '{"login":null}',
    '{"login":12}',
    '{"login":""}',
    '{"login":"user\\nPRIVATE"}',
    '{"login":"https://example.test"}',
    '{"login":"' + 'a'.repeat(40) + '"}',
    'not-json',
  ])('rejects a malformed or missing authenticated identity: %s', async (stdout) => {
    host.exec.mockResolvedValue({ stdout });
    expect(await authenticatedGhAccount()).toBeNull();
  });

  it('does not accept stdout from a failed authenticated request or expose its diagnostics', async () => {
    host.exec.mockRejectedValue({
      stdout: '{"login":"previous-account"}',
      stderr: 'PRIVATE_AUTH_DIAGNOSTIC',
      code: 1,
    });
    expect(await authenticatedGhAccount()).toBeNull();
  });

  it('does not spawn when the CLI is absent or the request is already cancelled', async () => {
    host.find.mockReturnValueOnce(null);
    expect(await authenticatedGhAccount()).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(await authenticatedGhAccount(controller.signal)).toBeNull();
    expect(host.exec).not.toHaveBeenCalled();
  });

  it('discards an identity returned after cancellation', async () => {
    const controller = new AbortController();
    host.exec.mockImplementation(async () => {
      controller.abort();
      return { stdout: '{"login":"previous-account"}' };
    });
    expect(await authenticatedGhAccount(controller.signal)).toBeNull();
  });
});
