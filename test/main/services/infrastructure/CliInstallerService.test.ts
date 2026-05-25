import { beforeEach, describe, expect, it, vi } from 'vitest';

const { realpathMock, resolveInteractiveShellEnvBestEffortMock } = vi.hoisted(() => ({
  realpathMock: vi.fn(async (value: string) => value),
  resolveInteractiveShellEnvBestEffortMock: vi.fn(
    async (options?: { fallbackEnv?: NodeJS.ProcessEnv }) => options?.fallbackEnv ?? process.env
  ),
}));

// Mock dependencies before importing service
vi.mock('@main/utils/childProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/childProcess')>();
  return {
    ...actual,
    execCli: vi.fn().mockRejectedValue(new Error('execCli not configured')),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      end: vi.fn((cb: () => void) => cb()),
      destroy: vi.fn(),
      on: vi.fn(),
    })),
    promises: {
      ...actual.promises,
      chmod: vi.fn(),
      realpath: realpathMock,
      unlink: vi.fn(),
    },
  };
});

vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  return {
    ...actual,
    default: {
      ...actual,
      get: vi.fn(),
    },
  };
});

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    default: {
      ...actual,
      get: vi.fn(),
    },
  };
});

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: vi.fn(),
    clearCache: vi.fn(),
  },
}));

vi.mock('@main/services/team/cliFlavor', () => ({
  getConfiguredCliFlavor: vi.fn(() => 'claude'),
  getCliFlavorUiOptions: vi.fn(() => ({
    displayName: 'Claude CLI',
    supportsSelfUpdate: true,
    showVersionDetails: true,
    showBinaryPath: true,
  })),
}));

vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: vi.fn(async () => ({
    env: { HOME: '/Users/tester' },
    connectionIssues: {},
  })),
}));

vi.mock('@main/utils/cliAuthDiagLog', () => ({
  appendCliAuthDiag: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@main/utils/shellEnv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/shellEnv')>();
  return {
    ...actual,
    resolveInteractiveShellEnvBestEffort: resolveInteractiveShellEnvBestEffortMock,
  };
});

import {
  CliInstallerService,
  isVersionOlder,
  normalizeVersion,
} from '@main/services/infrastructure/CliInstallerService';
import { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { getCliFlavorUiOptions, getConfiguredCliFlavor } from '@main/services/team/cliFlavor';
import { execCli } from '@main/utils/childProcess';
import { appendCliAuthDiag } from '@main/utils/cliAuthDiagLog';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

/**
 * Helper: allow expected console.error/warn calls in tests where service logs errors.
 * The test setup asserts no unexpected console.error/warn, so we re-spy to capture them.
 */
function allowConsoleLogs(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

function createTestProviderStatus(
  providerId: CliProviderId,
  authenticated: boolean,
  authMethod: string | null
): CliProviderStatus {
  return {
    providerId,
    displayName: providerId,
    supported: true,
    authenticated,
    authMethod,
    verificationState: authenticated ? 'verified' : 'unknown',
    modelVerificationState: 'idle',
    modelCatalogRefreshState: 'idle',
    statusMessage: null,
    detailMessage: null,
    models: [],
    modelAvailability: [],
    runtimeCapabilities: null,
    subscriptionRateLimits: null,
    canLoginFromUi: providerId !== 'opencode',
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: undefined as never,
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    connection: null,
    modelCatalog: null,
  };
}

describe('CliInstallerService', () => {
  let service: CliInstallerService;

  beforeEach(() => {
    vi.clearAllMocks();
    realpathMock.mockReset();
    realpathMock.mockImplementation(async (value: string) => value);
    resolveInteractiveShellEnvBestEffortMock.mockImplementation(
      async (options?: { fallbackEnv?: NodeJS.ProcessEnv }) => options?.fallbackEnv ?? process.env
    );
    vi.mocked(getConfiguredCliFlavor).mockReturnValue('claude');
    vi.mocked(getCliFlavorUiOptions).mockReturnValue({
      displayName: 'Claude CLI',
      supportsSelfUpdate: true,
      showVersionDetails: true,
      showBinaryPath: true,
    });
    service = new CliInstallerService();
  });

  describe('getStatus', () => {
    it('returns not installed when binary is not found', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue(null);

      const status = await service.getStatus();

      expect(status.installed).toBe(false);
      expect(status.installedVersion).toBeNull();
      expect(status.binaryPath).toBeNull();
      expect(status.updateAvailable).toBe(false);
      expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 1_500,
          fallbackEnv: process.env,
          background: false,
        })
      );
    });

    it('does not block getStatus on diagnostic file writes', async () => {
      allowConsoleLogs();
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'Claude CLI',
        supportsSelfUpdate: false,
        showVersionDetails: true,
        showBinaryPath: true,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue(null);

      let resolveDiag!: (value: string | null) => void;
      vi.mocked(appendCliAuthDiag).mockReturnValueOnce(
        new Promise<string | null>((resolve) => {
          resolveDiag = resolve;
        })
      );

      const status = await service.getStatus();

      expect(status.installed).toBe(false);
      await Promise.resolve();
      expect(appendCliAuthDiag).toHaveBeenCalledTimes(1);

      resolveDiag(null);
      await Promise.resolve();
    });

    it('includes frontend-visible providers in unavailable multimodel bootstrap status', async () => {
      allowConsoleLogs();
      vi.mocked(getConfiguredCliFlavor).mockReturnValue('agent_teams_orchestrator');
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue(null);

      const status = await service.getStatus();
      const openCodeStatus = status.providers.find(
        (provider) => provider.providerId === 'opencode'
      );

      expect(status.providers.map((provider) => provider.providerId)).toEqual([
        'anthropic',
        'codex',
        'opencode',
        'kilocode',
      ]);
      expect(openCodeStatus).toMatchObject({
        displayName: 'OpenCode (200+ models)',
        supported: false,
        statusMessage: 'Runtime not found.',
        canLoginFromUi: false,
      });
    });

    it('does not expose hidden Gemini in frontend multimodel authentication snapshots', async () => {
      allowConsoleLogs();
      vi.mocked(getConfiguredCliFlavor).mockReturnValue('agent_teams_orchestrator');
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
      vi.mocked(execCli).mockResolvedValueOnce({ stdout: '2.3.4', stderr: '' });

      const providers = [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          modelVerificationState: 'idle',
          statusMessage: null,
          models: [],
          modelAvailability: [],
          canLoginFromUi: true,
          capabilities: { teamLaunch: true, oneShot: true, extensions: undefined as never },
          backend: null,
        },
        {
          providerId: 'codex',
          displayName: 'Codex',
          supported: true,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          modelVerificationState: 'idle',
          statusMessage: null,
          models: [],
          modelAvailability: [],
          canLoginFromUi: true,
          capabilities: { teamLaunch: true, oneShot: true, extensions: undefined as never },
          backend: null,
        },
        {
          providerId: 'gemini',
          displayName: 'Gemini',
          supported: true,
          authenticated: true,
          authMethod: 'gemini_api_key',
          verificationState: 'verified',
          modelVerificationState: 'idle',
          statusMessage: null,
          models: ['gemini-2.5-pro'],
          modelAvailability: [],
          canLoginFromUi: true,
          capabilities: { teamLaunch: true, oneShot: true, extensions: undefined as never },
          backend: { kind: 'api', label: 'Gemini API' },
        },
        {
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: true,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          modelVerificationState: 'idle',
          statusMessage: null,
          models: [],
          modelAvailability: [],
          canLoginFromUi: false,
          capabilities: { teamLaunch: true, oneShot: false, extensions: undefined as never },
          backend: null,
        },
      ];
      vi.spyOn(ClaudeMultimodelBridgeService.prototype, 'getProviderStatuses').mockImplementation(
        async (_binaryPath, onUpdate) => {
          onUpdate?.(providers as never);
          return providers as never;
        }
      );

      const status = await service.getStatus();

      expect(status.providers.map((provider) => provider.providerId)).toEqual([
        'anthropic',
        'codex',
        'opencode',
        'kilocode',
      ]);
      expect(status.authLoggedIn).toBe(false);
      expect(status.authMethod).toBeNull();
      expect(
        service
          .getLatestStatusSnapshot()
          ?.providers.some((provider) => provider.providerId === 'gemini')
      ).toBe(false);
      expect(service.getLatestStatusSnapshot()?.authLoggedIn).toBe(false);
    });

    it('defers multimodel provider status probes during lightweight startup status checks', async () => {
      allowConsoleLogs();
      vi.mocked(getConfiguredCliFlavor).mockReturnValue('agent_teams_orchestrator');
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/agent_teams_orchestrator');
      vi.mocked(execCli).mockResolvedValueOnce({ stdout: '0.0.46', stderr: '' });
      const getProviderStatusesSpy = vi
        .spyOn(ClaudeMultimodelBridgeService.prototype, 'getProviderStatuses')
        .mockResolvedValue([
          createTestProviderStatus('anthropic', true, 'oauth_token'),
          createTestProviderStatus('codex', true, 'chatgpt'),
          createTestProviderStatus('opencode', true, 'opencode_managed'),
        ]);
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);

      const status = await service.getStatus({ providerStatusMode: 'defer' });
      const statusEvents = mockWindow.webContents.send.mock.calls
        .filter((call: unknown[]) => call[0] === 'cliInstaller:progress')
        .map((call: unknown[]) => call[1] as { type?: string; status?: { providers?: unknown[] } })
        .filter((event) => event.type === 'status');

      expect(status.installed).toBe(true);
      expect(resolveInteractiveShellEnvBestEffortMock).not.toHaveBeenCalled();
      expect(status.authStatusChecking).toBe(false);
      expect(status.authLoggedIn).toBe(false);
      expect(status.providers).toHaveLength(4);
      expect(
        status.providers.every(
          (provider) => provider.statusMessage === 'Provider status will refresh when needed.'
        )
      ).toBe(true);
      expect(statusEvents.length).toBeGreaterThan(0);
      expect(
        statusEvents.every((event) =>
          event.status?.providers?.every(
            (provider) =>
              typeof provider === 'object' &&
              provider !== null &&
              'statusMessage' in provider &&
              'models' in provider &&
              (provider as { statusMessage?: string }).statusMessage ===
                'Provider status will refresh when needed.' &&
              Array.isArray((provider as { models?: unknown[] }).models) &&
              (provider as { models?: unknown[] }).models?.length === 0
          )
        )
      ).toBe(true);
      expect(getProviderStatusesSpy).not.toHaveBeenCalled();
      expect(execCli).toHaveBeenCalledTimes(1);
      expect(execCli).toHaveBeenCalledWith(
        '/mock/agent_teams_orchestrator',
        ['--version'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    it('does not mark the CLI installed when the version probe cannot confirm the binary', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      const status = await service.getStatus();

      expect(status.installed).toBe(false);
      expect(status.binaryPath).toBe('/usr/local/bin/claude');
      expect(status.installedVersion).toBeNull();
    });

    it('retries the version probe once before marking the runtime unhealthy', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
      vi.mocked(execCli)
        .mockRejectedValueOnce(new Error('Command failed: /usr/local/bin/claude --version'))
        .mockResolvedValueOnce({ stdout: '2.3.4', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"loggedIn":true,"authMethod":"oauth_token"}',
          stderr: '',
        });

      const status = await service.getStatus();

      expect(status.installed).toBe(true);
      expect(status.installedVersion).toBe('2.3.4');
      expect(execCli).toHaveBeenNthCalledWith(
        1,
        '/usr/local/bin/claude',
        ['--version'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
      expect(execCli).toHaveBeenNthCalledWith(
        2,
        '/usr/local/bin/claude',
        ['--version'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    it('reuses the last healthy runtime snapshot when a later version probe fails transiently', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.3.4', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"loggedIn":true,"authMethod":"oauth_token"}',
          stderr: '',
        })
        .mockRejectedValueOnce(new Error('Command failed: /usr/local/bin/claude --version'))
        .mockRejectedValueOnce(new Error('Command failed: /usr/local/bin/claude --version'));

      const firstStatus = await service.getStatus();
      const secondStatus = await service.getStatus();

      expect(firstStatus.installed).toBe(true);
      expect(firstStatus.installedVersion).toBe('2.3.4');
      expect(secondStatus.installed).toBe(true);
      expect(secondStatus.installedVersion).toBe('2.3.4');
      expect(secondStatus.launchError).toBeNull();
    });

    it('handles spawn EINVAL when binary path contains non-ASCII by falling back', async () => {
      allowConsoleLogs();
      const fakePath = 'C:\\Users\\Алексей\\AppData\\Roaming\\npm\\claude.cmd';
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue(fakePath);

      // execCli handles the EINVAL → shell fallback internally;
      // here we just verify the service delegates to execCli correctly.
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.3.4', stderr: '' }) // --version
        .mockResolvedValueOnce({ stdout: '{}', stderr: '' }); // auth status

      const status = await service.getStatus();
      expect(status.installed).toBe(true);
      expect(status.installedVersion).toBe('2.3.4');
      expect(execCli).toHaveBeenCalledWith(
        fakePath,
        ['--version'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    it('treats auth as logged in when JSON is embedded after stdout noise', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.3.4', stderr: '' })
        .mockResolvedValueOnce({
          stdout: 'notice: something\n{"loggedIn":true,"authMethod":"oauth_token"}\n',
          stderr: '',
        });

      const status = await service.getStatus();
      expect(status.authLoggedIn).toBe(true);
      expect(status.authMethod).toBe('oauth_token');
    });

    it('falls back to the installed launcher path when --version reports unknown', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/Users/tester/.local/bin/claude');
      vi.spyOn(service as never, 'inferInstalledCliVersionFromPath').mockResolvedValue('2.1.101');
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: 'unknown', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"loggedIn":true,"authMethod":"oauth_token"}',
          stderr: '',
        });

      const status = await service.getStatus();

      expect(status.installed).toBe(true);
      expect(status.installedVersion).toBe('2.1.101');
      expect(status.authLoggedIn).toBe(true);
    });

    it('publishes probe-enriched runtime model status snapshots only for explicit verification requests', async () => {
      allowConsoleLogs();
      vi.mocked(getConfiguredCliFlavor).mockReturnValue('agent_teams_orchestrator');
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      vi.spyOn(ClaudeMultimodelBridgeService.prototype, 'getProviderStatuses').mockImplementation(
        async (_binaryPath, onUpdate) => {
          const providers = [
            {
              providerId: 'anthropic',
              displayName: 'Anthropic',
              supported: true,
              authenticated: true,
              authMethod: 'oauth_token',
              verificationState: 'verified',
              modelVerificationState: 'idle',
              statusMessage: null,
              models: [],
              modelAvailability: [],
              canLoginFromUi: true,
              capabilities: { teamLaunch: true, oneShot: true },
              backend: null,
            },
            {
              providerId: 'codex',
              displayName: 'Codex',
              supported: true,
              authenticated: true,
              authMethod: 'oauth_token',
              verificationState: 'verified',
              modelVerificationState: 'idle',
              statusMessage: null,
              models: ['gpt-5.4', 'gpt-5.4-mini'],
              modelAvailability: [],
              canLoginFromUi: true,
              capabilities: { teamLaunch: true, oneShot: true },
              backend: {
                kind: 'openai',
                label: 'OpenAI',
                endpointLabel: 'chatgpt.com/backend-api/codex/responses',
              },
            },
            {
              providerId: 'gemini',
              displayName: 'Gemini',
              supported: false,
              authenticated: false,
              authMethod: null,
              verificationState: 'unknown',
              modelVerificationState: 'idle',
              statusMessage: null,
              models: [],
              modelAvailability: [],
              canLoginFromUi: true,
              capabilities: { teamLaunch: false, oneShot: false },
              backend: null,
            },
          ];
          onUpdate?.(providers as never);
          return providers as never;
        }
      );

      vi.mocked(execCli).mockImplementation(async (_binaryPath, args) => {
        const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
        if (normalizedArgs === '--version') {
          return { stdout: '2.3.4', stderr: '' };
        }
        if (normalizedArgs.includes('--model gpt-5.4-mini')) {
          throw new Error("The 'gpt-5.4-mini' model is not supported in this Codex runtime.");
        }
        if (normalizedArgs.includes('--model gpt-5.4')) {
          return { stdout: 'PONG', stderr: '' };
        }
        throw new Error(`Unexpected execCli call: ${normalizedArgs}`);
      });

      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);

      const status = await service.getStatus();
      expect(
        status.providers.find((provider) => provider.providerId === 'codex')?.modelAvailability
      ).toEqual([]);

      const verifiedProvider = await service.verifyProviderModels('codex');
      expect(verifiedProvider?.modelAvailability).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ modelId: 'gpt-5.4', status: 'checking' }),
          expect.objectContaining({ modelId: 'gpt-5.4-mini', status: 'checking' }),
        ])
      );
      expect(verifiedProvider?.modelAvailability).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ modelId: 'gpt-5.2-codex' })])
      );

      await vi.waitFor(() => {
        const latestCodexProvider = service
          .getLatestStatusSnapshot()
          ?.providers.find((provider) => provider.providerId === 'codex');

        expect(latestCodexProvider?.modelAvailability).toEqual([
          expect.objectContaining({ modelId: 'gpt-5.4', status: 'available' }),
          expect.objectContaining({
            modelId: 'gpt-5.4-mini',
            status: 'unavailable',
          }),
        ]);
      });

      expect(execCli).not.toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        expect.arrayContaining(['--model', 'gpt-5.2-codex']),
        expect.anything()
      );

      const statusEvents = mockWindow.webContents.send.mock.calls
        .filter((call: unknown[]) => call[0] === 'cliInstaller:progress')
        .map((call: unknown[]) => call[1] as { type?: string; status?: { providers?: unknown[] } })
        .filter((event) => event.type === 'status');

      expect(statusEvents.length).toBeGreaterThan(1);
      expect(
        statusEvents.some((event) =>
          event.status?.providers?.some(
            (provider) =>
              typeof provider === 'object' &&
              provider !== null &&
              'providerId' in provider &&
              'modelAvailability' in provider &&
              (provider as { providerId?: string }).providerId === 'codex' &&
              Array.isArray((provider as { modelAvailability?: unknown[] }).modelAvailability) &&
              (
                provider as { modelAvailability: Array<{ modelId?: string; status?: string }> }
              ).modelAvailability.some(
                (item) => item.modelId === 'gpt-5.4' && item.status === 'available'
              )
          )
        )
      ).toBe(true);
      expect(
        statusEvents.some((event) =>
          event.status?.providers?.some(
            (provider) =>
              typeof provider === 'object' &&
              provider !== null &&
              'providerId' in provider &&
              'modelAvailability' in provider &&
              (provider as { providerId?: string }).providerId === 'codex' &&
              Array.isArray((provider as { modelAvailability?: unknown[] }).modelAvailability) &&
              (
                provider as { modelAvailability: Array<{ modelId?: string }> }
              ).modelAvailability.some((item) => item.modelId === 'gpt-5.2-codex')
          )
        )
      ).toBe(false);
    });

    it('keeps OpenCode provider verification catalog-only for explicit verify requests', async () => {
      allowConsoleLogs();
      vi.mocked(getConfiguredCliFlavor).mockReturnValue('agent_teams_orchestrator');
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      vi.spyOn(ClaudeMultimodelBridgeService.prototype, 'getProviderStatuses').mockResolvedValue([
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'oauth_token',
          verificationState: 'verified',
          modelVerificationState: 'idle',
          statusMessage: null,
          detailMessage: null,
          models: [],
          modelAvailability: [],
          canLoginFromUi: true,
          capabilities: { teamLaunch: true, oneShot: true, extensions: undefined as never },
          selectedBackendId: null,
          resolvedBackendId: null,
          availableBackends: [],
          externalRuntimeDiagnostics: [],
          backend: null,
          connection: null,
        },
        {
          providerId: 'codex',
          displayName: 'Codex',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          modelVerificationState: 'idle',
          statusMessage: null,
          detailMessage: null,
          models: [],
          modelAvailability: [],
          canLoginFromUi: true,
          capabilities: { teamLaunch: false, oneShot: false, extensions: undefined as never },
          selectedBackendId: null,
          resolvedBackendId: null,
          availableBackends: [],
          externalRuntimeDiagnostics: [],
          backend: null,
          connection: null,
        },
        {
          providerId: 'gemini',
          displayName: 'Gemini',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          modelVerificationState: 'idle',
          statusMessage: null,
          detailMessage: null,
          models: [],
          modelAvailability: [],
          canLoginFromUi: true,
          capabilities: { teamLaunch: false, oneShot: false, extensions: undefined as never },
          selectedBackendId: null,
          resolvedBackendId: null,
          availableBackends: [],
          externalRuntimeDiagnostics: [],
          backend: null,
          connection: null,
        },
        {
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          modelVerificationState: 'idle',
          statusMessage: null,
          detailMessage: null,
          models: ['openai/gpt-5.4-mini', 'opencode/big-pickle'],
          modelAvailability: [],
          canLoginFromUi: false,
          capabilities: { teamLaunch: false, oneShot: false, extensions: undefined as never },
          selectedBackendId: null,
          resolvedBackendId: null,
          availableBackends: [],
          externalRuntimeDiagnostics: [],
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          connection: null,
        },
      ] as never);

      vi.spyOn(ClaudeMultimodelBridgeService.prototype, 'verifyProviderStatus').mockResolvedValue({
        providerId: 'opencode',
        displayName: 'OpenCode',
        supported: true,
        authenticated: true,
        authMethod: 'opencode_managed',
        verificationState: 'verified',
        modelVerificationState: 'idle',
        statusMessage: null,
        detailMessage: null,
        models: ['openai/gpt-5.4-mini', 'opencode/big-pickle'],
        modelAvailability: [],
        canLoginFromUi: false,
        capabilities: { teamLaunch: false, oneShot: false, extensions: undefined as never },
        selectedBackendId: null,
        resolvedBackendId: null,
        availableBackends: [],
        externalRuntimeDiagnostics: [],
        backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
        connection: null,
      } as never);

      const verifyOpenCodeModelsSpy = vi
        .spyOn(ClaudeMultimodelBridgeService.prototype, 'verifyOpenCodeModels')
        .mockResolvedValue({
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          modelVerificationState: 'verified',
          statusMessage: null,
          detailMessage: null,
          models: ['openai/gpt-5.4-mini', 'opencode/big-pickle'],
          modelAvailability: [
            {
              modelId: 'openai/gpt-5.4-mini',
              status: 'unavailable',
              reason: 'Token refresh failed: 401',
            },
            {
              modelId: 'opencode/big-pickle',
              status: 'available',
              reason: null,
            },
          ],
          canLoginFromUi: false,
          capabilities: { teamLaunch: false, oneShot: false, extensions: undefined as never },
          selectedBackendId: null,
          resolvedBackendId: null,
          availableBackends: [],
          externalRuntimeDiagnostics: [],
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          connection: null,
        } as never);

      vi.mocked(execCli).mockImplementation(async (_binaryPath, args) => {
        const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
        if (normalizedArgs === '--version') {
          return { stdout: '2.3.4', stderr: '' };
        }
        throw new Error(`Unexpected execCli call: ${normalizedArgs}`);
      });

      const status = await service.getStatus();
      expect(
        status.providers.find((provider) => provider.providerId === 'opencode')?.modelAvailability
      ).toEqual([]);

      const verifiedProvider = await service.verifyProviderModels('opencode');

      expect(verifyOpenCodeModelsSpy).not.toHaveBeenCalled();
      expect(verifiedProvider?.modelVerificationState).toBe('idle');
      expect(verifiedProvider?.modelAvailability).toEqual([]);
    });

    it('does not shrink cached OpenCode models when a provider refresh returns summary-only models', async () => {
      allowConsoleLogs();
      vi.mocked(getConfiguredCliFlavor).mockReturnValue('agent_teams_orchestrator');
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
      vi.mocked(execCli).mockImplementation(async (_binaryPath, args) => {
        const normalizedArgs = Array.isArray(args) ? args.join(' ') : '';
        if (normalizedArgs === '--version') {
          return { stdout: '2.3.4', stderr: '' };
        }
        throw new Error(`Unexpected execCli call: ${normalizedArgs}`);
      });

      vi.spyOn(ClaudeMultimodelBridgeService.prototype, 'getProviderStatuses').mockResolvedValue([
        {
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          modelVerificationState: 'idle',
          statusMessage: null,
          detailMessage: null,
          models: [
            'opencode/big-pickle',
            'openai/gpt-5.4',
            'openrouter/openai/gpt-oss-20b:free',
          ],
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-20T00:00:00.000Z',
            staleAt: '2026-05-20T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'opencode/big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                badgeLabel: 'Free',
              },
              {
                id: 'openai/gpt-5.4',
                launchModel: 'openai/gpt-5.4',
                displayName: 'openai/gpt-5.4',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
          modelCatalogRefreshState: 'ready',
          modelAvailability: [],
          runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
          canLoginFromUi: false,
          capabilities: { teamLaunch: true, oneShot: false, extensions: undefined as never },
          selectedBackendId: null,
          resolvedBackendId: null,
          availableBackends: [],
          externalRuntimeDiagnostics: [],
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          connection: null,
        },
      ] as never);

      vi.spyOn(ClaudeMultimodelBridgeService.prototype, 'getProviderStatus').mockResolvedValue({
        providerId: 'opencode',
        displayName: 'OpenCode',
        supported: true,
        authenticated: true,
        authMethod: 'opencode_managed',
        verificationState: 'verified',
        modelVerificationState: 'idle',
        statusMessage: null,
        detailMessage: null,
        models: ['opencode/big-pickle'],
        modelCatalog: null,
        modelCatalogRefreshState: 'loading',
        modelAvailability: [],
        runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
        canLoginFromUi: false,
        capabilities: { teamLaunch: true, oneShot: false, extensions: undefined as never },
        selectedBackendId: null,
        resolvedBackendId: null,
        availableBackends: [],
        externalRuntimeDiagnostics: [],
        backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
        connection: null,
      } as never);

      await service.getStatus();
      await service.getProviderStatus('opencode');

      const latestSnapshot = (
        service as unknown as {
          latestStatusSnapshot?: Awaited<ReturnType<CliInstallerService['getStatus']>>;
        }
      ).latestStatusSnapshot;
      const opencode = latestSnapshot?.providers.find(
        (provider) => provider.providerId === 'opencode'
      );
      expect(opencode?.models).toEqual([
        'opencode/big-pickle',
        'openai/gpt-5.4',
        'openrouter/openai/gpt-oss-20b:free',
      ]);
      expect(opencode?.modelCatalog?.models.map((model) => model.id)).toEqual([
        'opencode/big-pickle',
        'openai/gpt-5.4',
      ]);
      expect(opencode?.modelCatalogRefreshState).toBe('ready');
    });
  });

  describe('install mutex', () => {
    it('prevents concurrent installations', async () => {
      allowConsoleLogs();

      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);

      // Start first install (will fail on fetch — that's fine for mutex test)
      const promise1 = service.install();
      // Start second install immediately — should get "already in progress"
      const promise2 = service.install();

      await Promise.allSettled([promise1, promise2]);

      // Second call should send "already in progress" error
      const progressCalls = mockWindow.webContents.send.mock.calls;
      const errorCalls = progressCalls.filter(
        (call: unknown[]) =>
          (call[0] as string) === 'cliInstaller:progress' &&
          (call[1] as { type: string; error?: string }).type === 'error' &&
          (call[1] as { type: string; error?: string }).error?.includes('already in progress')
      );
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('resets mutex after install completes (even on failure)', async () => {
      allowConsoleLogs();

      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);

      // First install will fail (no network mock)
      await service.install();

      // After failure, mutex should be released — second install should start checking
      mockWindow.webContents.send.mockClear();
      await service.install();

      const checkingCalls = mockWindow.webContents.send.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string) === 'cliInstaller:progress' &&
          (call[1] as { type: string }).type === 'checking'
      );
      expect(checkingCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('setMainWindow', () => {
    it('accepts null to clear window reference', () => {
      service.setMainWindow(null);
      expect(true).toBe(true);
    });

    it('accepts a BrowserWindow instance', () => {
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);
      expect(true).toBe(true);
    });
  });

  describe('normalizeVersion', () => {
    it('extracts semver from "claude --version" output', () => {
      expect(normalizeVersion('2.1.34 (Claude Code)\n')).toBe('2.1.34');
      expect(normalizeVersion('2.1.59 (Claude Code)')).toBe('2.1.59');
    });

    it('handles plain version strings', () => {
      expect(normalizeVersion('2.1.59')).toBe('2.1.59');
      expect(normalizeVersion('  2.1.59  ')).toBe('2.1.59');
    });

    it('strips v prefix', () => {
      expect(normalizeVersion('v2.1.59')).toBe('2.1.59');
      expect(normalizeVersion('v2.1.59\n')).toBe('2.1.59');
    });

    it('returns trimmed input when no semver found', () => {
      expect(normalizeVersion('unknown')).toBe('unknown');
      expect(normalizeVersion('  beta  ')).toBe('beta');
    });
  });

  describe('isVersionOlder', () => {
    it('returns true when installed is older', () => {
      expect(isVersionOlder('2.1.34', '2.1.59')).toBe(true);
      expect(isVersionOlder('1.0.0', '2.0.0')).toBe(true);
      expect(isVersionOlder('2.0.0', '2.1.0')).toBe(true);
      expect(isVersionOlder('2.1.0', '2.1.1')).toBe(true);
    });

    it('returns false when versions are equal', () => {
      expect(isVersionOlder('2.1.59', '2.1.59')).toBe(false);
      expect(isVersionOlder('1.0.0', '1.0.0')).toBe(false);
    });

    it('returns false when installed is newer', () => {
      expect(isVersionOlder('2.1.59', '2.1.34')).toBe(false);
      expect(isVersionOlder('3.0.0', '2.9.99')).toBe(false);
      expect(isVersionOlder('2.2.0', '2.1.59')).toBe(false);
    });

    it('handles numeric comparison correctly (not lexicographic)', () => {
      // "2.10.0" > "2.9.0" numerically (but "10" < "9" lexicographically)
      expect(isVersionOlder('2.9.0', '2.10.0')).toBe(true);
      expect(isVersionOlder('2.10.0', '2.9.0')).toBe(false);
    });

    it('handles different segment counts', () => {
      expect(isVersionOlder('2.1', '2.1.1')).toBe(true);
      expect(isVersionOlder('2.1.1', '2.1')).toBe(false);
      expect(isVersionOlder('2.1', '2.1.0')).toBe(false); // 2.1 == 2.1.0
    });
  });

  describe('getStatus timeout', () => {
    it('returns partial result when gatherStatus hangs', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      // ClaudeBinaryResolver.resolve() never settles — simulates thread pool exhaustion
      vi.mocked(ClaudeBinaryResolver.resolve).mockReturnValue(new Promise(() => {}));

      const statusPromise = service.getStatus();

      // Advance past GET_STATUS_TIMEOUT_MS (30s)
      await vi.advanceTimersByTimeAsync(31_000);

      const status = await statusPromise;

      // Should return the default (partial) result — not hang forever
      expect(status.installed).toBe(false);
      expect(status.installedVersion).toBeNull();
      expect(status.binaryPath).toBeNull();

      vi.useRealTimers();
    });

    it('returns full result when gatherStatus completes before timeout', async () => {
      allowConsoleLogs();

      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.5.0 (Claude Code)', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"loggedIn":true,"authMethod":"api_key"}',
          stderr: '',
        });

      const status = await service.getStatus();

      expect(status.installed).toBe(true);
      expect(status.installedVersion).toBe('2.5.0');
      expect(status.authLoggedIn).toBe(true);
      expect(status.authMethod).toBe('api_key');
    });

    it('returns multimodel metadata before provider status hydration finishes', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      vi.mocked(getConfiguredCliFlavor).mockReturnValue('agent_teams_orchestrator');
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/agent_teams_orchestrator');
      vi.mocked(execCli).mockResolvedValueOnce({ stdout: '0.0.45', stderr: '' });

      let resolveProviders!: (providers: CliProviderStatus[]) => void;
      const providerStatuses = new Promise<CliProviderStatus[]>((resolve) => {
        resolveProviders = resolve;
      });
      const providerStatusesSpy = vi.spyOn(
        ClaudeMultimodelBridgeService.prototype,
        'getProviderStatuses'
      ).mockReturnValue(providerStatuses);

      const statusPromise = service.getStatus();
      await vi.advanceTimersByTimeAsync(1_600);

      const status = await statusPromise;
      expect(status.installed).toBe(true);
      expect(status.installedVersion).toBe('0.0.45');
      expect(status.authStatusChecking).toBe(true);
      expect(status.providers.every((provider) => provider.statusMessage === 'Checking...')).toBe(
        true
      );

      resolveProviders([
        createTestProviderStatus('anthropic', true, 'oauth_token'),
        createTestProviderStatus('codex', false, null),
        createTestProviderStatus('opencode', false, null),
      ]);
      await vi.waitFor(() => {
        const latest = service.getLatestStatusSnapshot();
        expect(latest?.authStatusChecking).toBe(false);
        expect(latest?.authLoggedIn).toBe(true);
        expect(latest?.authMethod).toBe('oauth_token');
      });
      expect(status.authStatusChecking).toBe(true);
      expect(status.authLoggedIn).toBe(false);
      expect(status.providers.every((provider) => provider.statusMessage === 'Checking...')).toBe(
        true
      );

      providerStatusesSpy.mockRestore();
      vi.useRealTimers();
    });

    it('does not publish stale background provider hydration after status invalidation', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      vi.mocked(getConfiguredCliFlavor).mockReturnValue('agent_teams_orchestrator');
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/agent_teams_orchestrator');
      vi.mocked(execCli).mockResolvedValueOnce({ stdout: '0.0.45', stderr: '' });

      let resolveProviders!: (providers: CliProviderStatus[]) => void;
      const providerStatuses = new Promise<CliProviderStatus[]>((resolve) => {
        resolveProviders = resolve;
      });
      const providerStatusesSpy = vi.spyOn(
        ClaudeMultimodelBridgeService.prototype,
        'getProviderStatuses'
      ).mockReturnValue(providerStatuses);

      const statusPromise = service.getStatus();
      await vi.advanceTimersByTimeAsync(1_600);
      await statusPromise;

      service.invalidateStatusCache();
      expect(service.getLatestStatusSnapshot()).toBeNull();

      resolveProviders([
        createTestProviderStatus('anthropic', true, 'oauth_token'),
        createTestProviderStatus('codex', false, null),
        createTestProviderStatus('opencode', false, null),
      ]);
      await Promise.resolve();
      await Promise.resolve();

      expect(service.getLatestStatusSnapshot()).toBeNull();

      providerStatusesSpy.mockRestore();
      vi.useRealTimers();
    });

    it('does not let stale explicit provider refresh mutate a newer status snapshot', async () => {
      allowConsoleLogs();

      vi.mocked(getConfiguredCliFlavor).mockReturnValue('agent_teams_orchestrator');
      vi.mocked(getCliFlavorUiOptions).mockReturnValue({
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: false,
      });
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/mock/agent_teams_orchestrator');
      vi.mocked(execCli).mockResolvedValue({ stdout: '0.0.45', stderr: '' });

      const providerStatusesSpy = vi
        .spyOn(ClaudeMultimodelBridgeService.prototype, 'getProviderStatuses')
        .mockResolvedValueOnce([
          createTestProviderStatus('anthropic', false, null),
          {
            ...createTestProviderStatus('codex', false, null),
            statusMessage: 'initial codex state',
          },
          createTestProviderStatus('opencode', false, null),
        ])
        .mockResolvedValueOnce([
          createTestProviderStatus('anthropic', false, null),
          {
            ...createTestProviderStatus('codex', true, 'chatgpt'),
            statusMessage: 'fresh codex state',
          },
          createTestProviderStatus('opencode', false, null),
        ]);

      let resolveStaleProvider!: (provider: CliProviderStatus) => void;
      const staleProvider = new Promise<CliProviderStatus>((resolve) => {
        resolveStaleProvider = resolve;
      });
      const providerStatusSpy = vi
        .spyOn(ClaudeMultimodelBridgeService.prototype, 'getProviderStatus')
        .mockReturnValue(staleProvider);

      await service.getStatus();
      const staleRefresh = service.getProviderStatus('codex');
      await vi.waitFor(() => {
        expect(providerStatusSpy).toHaveBeenCalledTimes(1);
      });

      service.invalidateStatusCache();
      await service.getStatus();

      resolveStaleProvider({
        ...createTestProviderStatus('codex', false, null),
        verificationState: 'error',
        statusMessage: 'stale codex state',
      });
      await staleRefresh;

      const latestCodex = service
        .getLatestStatusSnapshot()
        ?.providers.find((provider) => provider.providerId === 'codex');
      expect(latestCodex?.statusMessage).toBe('fresh codex state');
      expect(latestCodex?.authenticated).toBe(true);

      providerStatusesSpy.mockRestore();
      providerStatusSpy.mockRestore();
    });
  });

  describe('auth parallelism', () => {
    let httpsGet: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      // Reset execCli mock queue (clearAllMocks doesn't clear mockResolvedValueOnce queue)
      vi.mocked(execCli).mockReset();
      vi.mocked(execCli).mockRejectedValue(new Error('execCli not configured'));

      // Get reference to the mocked https.get for per-test control
      const httpsModule = await import('https');
      httpsGet = vi.mocked(httpsModule.default.get);
    });

    afterEach(() => {
      // Reset https.get so it doesn't leak into subsequent test groups
      httpsGet.mockReset();
      vi.useRealTimers();
    });

    it('auth is not blocked by slow GCS fetch', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      // --version resolves immediately, auth resolves immediately
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.5.0 (Claude Code)', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"loggedIn":true,"authMethod":"api_key"}',
          stderr: '',
        });

      // GCS never responds — simulates slow/hanging network.
      // Returns proper req-like object so httpsGetFollowRedirects doesn't crash,
      // but never fires the response callback.
      httpsGet.mockImplementation(() => ({
        setTimeout: vi.fn(),
        on: vi.fn(),
        destroy: vi.fn(),
      }));

      const statusPromise = service.getStatus();

      // Advance past GET_STATUS_TIMEOUT_MS (30s) — GCS still hanging,
      // but auth already wrote its result to `r` directly
      await vi.advanceTimersByTimeAsync(31_000);

      const status = await statusPromise;

      // Auth succeeded even though GCS is hanging
      expect(status.authLoggedIn).toBe(true);
      expect(status.authMethod).toBe('api_key');
      expect(status.installed).toBe(true);
      expect(status.installedVersion).toBe('2.5.0');
    });

    it('auth retry works when first attempt fails', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      // --version ok, auth attempt 1 fails, auth attempt 2 succeeds
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.5.0', stderr: '' })
        .mockRejectedValueOnce(new Error('ENOENT stale lock'))
        .mockResolvedValueOnce({
          stdout: '{"loggedIn":true,"authMethod":"oauth"}',
          stderr: '',
        });

      const statusPromise = service.getStatus();

      // Advance past retry delay (1.5s) + auth timeout + outer timeout
      await vi.advanceTimersByTimeAsync(31_000);

      const status = await statusPromise;

      expect(status.authLoggedIn).toBe(true);
      expect(status.authMethod).toBe('oauth');
    });

    it('auth times out independently when both attempts hang', async () => {
      allowConsoleLogs();
      vi.useFakeTimers();

      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');

      // --version ok, auth hangs forever (never resolves)
      vi.mocked(execCli)
        .mockResolvedValueOnce({ stdout: '2.5.0', stderr: '' })
        .mockReturnValue(new Promise(() => {}));

      const statusPromise = service.getStatus();

      // Advance past AUTH_TOTAL_TIMEOUT_MS (15s) and GET_STATUS_TIMEOUT_MS (30s)
      await vi.advanceTimersByTimeAsync(31_000);

      const status = await statusPromise;

      // Auth timed out independently → stays false
      expect(status.authLoggedIn).toBe(false);
      expect(status.authMethod).toBeNull();
      // Version was populated before auth started
      expect(status.installedVersion).toBe('2.5.0');
    });
  });

  describe('sendProgress with destroyed window', () => {
    it('does not throw when window is destroyed', async () => {
      allowConsoleLogs();

      const mockWindow = {
        isDestroyed: () => true,
        webContents: { send: vi.fn(), isDestroyed: () => true },
      };
      service.setMainWindow(mockWindow as unknown as import('electron').BrowserWindow);

      // install() triggers sendProgress — should not throw even with destroyed window
      await service.install();

      // send should NOT have been called because window is destroyed
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });
  });
});
