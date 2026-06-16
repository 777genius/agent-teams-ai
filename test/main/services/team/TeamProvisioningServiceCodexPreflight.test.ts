// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const buildProviderAwareCliEnvMock = vi.fn();
const addTeamNotificationMock = vi.fn().mockResolvedValue(null);

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: vi.fn(),
  resolveInteractiveShellEnvBestEffort: vi.fn(),
}));

vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: (...args: Parameters<typeof buildProviderAwareCliEnvMock>) =>
    buildProviderAwareCliEnvMock(...args),
}));

vi.mock('@main/utils/childProcess', () => ({
  execCli: vi.fn(),
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('@main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: () => ({
      addTeamNotification: addTeamNotificationMock,
    }),
  },
}));

import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';

type CodexProbeHarness = {
  probeClaudeRuntime: (
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: 'codex',
    providerArgs: string[]
  ) => Promise<{ warning?: string }>;
  runProviderOneShotDiagnostic: (
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: 'codex',
    providerArgs: string[]
  ) => Promise<{ warning?: string }>;
};

describe('TeamProvisioningService Codex create-team preflight', () => {
  let tempRoot = '';

  beforeEach(() => {
    vi.clearAllMocks();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-team-codex-preflight-'));
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    vi.mocked(resolveInteractiveShellEnvBestEffort).mockResolvedValue({
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });
    buildProviderAwareCliEnvMock.mockImplementation(
      async ({ env, providerId }: { env: NodeJS.ProcessEnv; providerId?: string }) => {
        expect(providerId).toBe('codex');
        env.CODEX_CLI_PATH = '/Users/tester/.local/bin/codex';
        env.CODEX_HOME = '/Users/tester/.codex-custom';
        env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD = 'chatgpt';
        return {
          env,
          providerArgs: ['-c', 'forced_login_method="chatgpt"'],
          connectionIssues: {},
        };
      }
    );
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  });

  it('uses refreshed Codex provider env for both runtime probe and deep one-shot preflight', async () => {
    const service = new TeamProvisioningService();
    const harness = service as unknown as CodexProbeHarness;
    const probeClaudeRuntime = vi
      .spyOn(
        harness as unknown as { probeClaudeRuntime: CodexProbeHarness['probeClaudeRuntime'] },
        'probeClaudeRuntime'
      )
      .mockResolvedValue({});
    const runProviderOneShotDiagnostic = vi
      .spyOn(
        harness as unknown as {
          runProviderOneShotDiagnostic: CodexProbeHarness['runProviderOneShotDiagnostic'];
        },
        'runProviderOneShotDiagnostic'
      )
      .mockResolvedValue({});

    const result = await service.prepareForProvisioning(tempRoot, {
      forceFresh: true,
      providerId: 'codex',
      modelVerificationMode: 'deep',
    });

    expect(result.ready).toBe(true);
    expect(result.message).toBe('CLI is warmed up and ready to launch');
    expect(result.warnings?.join('\n') ?? '').not.toContain('Codex CLI not found');
    expect(probeClaudeRuntime).toHaveBeenCalledWith(
      '/fake/claude',
      tempRoot,
      expect.objectContaining({
        CODEX_CLI_PATH: '/Users/tester/.local/bin/codex',
        CODEX_HOME: '/Users/tester/.codex-custom',
        CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
      }),
      'codex',
      ['-c', 'forced_login_method="chatgpt"']
    );
    expect(runProviderOneShotDiagnostic).toHaveBeenCalledWith(
      '/fake/claude',
      tempRoot,
      expect.objectContaining({
        CODEX_CLI_PATH: '/Users/tester/.local/bin/codex',
        CODEX_HOME: '/Users/tester/.codex-custom',
        CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
      }),
      'codex',
      ['-c', 'forced_login_method="chatgpt"']
    );
    expect(buildProviderAwareCliEnvMock).toHaveBeenCalledTimes(2);
  });
});
