// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execCliMock = vi.fn();
const buildProviderAwareCliEnvMock = vi.fn();

vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: Parameters<typeof execCliMock>) => execCliMock(...args),
}));

vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: (...args: Parameters<typeof buildProviderAwareCliEnvMock>) =>
    buildProviderAwareCliEnvMock(...args),
  getProviderStatusStoredCredentialAllowlist: (providerId?: string) =>
    providerId === 'anthropic'
      ? ['ANTHROPIC_AUTH_TOKEN']
      : providerId === 'codex'
        ? ['OPENAI_API_KEY']
        : undefined,
}));

import {
  CliProviderModelAvailabilityService,
  type ProviderModelAvailabilityContext,
} from '@main/services/runtime/CliProviderModelAvailabilityService';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { CliProviderStatus } from '@shared/types';

function createContext(
  models: string[],
  modelCatalog: CliProviderStatus['modelCatalog'] = null
): ProviderModelAvailabilityContext {
  return {
    binaryPath: '/usr/local/bin/claude',
    installedVersion: '2.3.4',
    provider: {
      providerId: 'codex',
      models,
      supported: true,
      authenticated: true,
      authMethod: 'oauth_token',
      selectedBackendId: 'chatgpt',
      resolvedBackendId: 'chatgpt',
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: createDefaultCliExtensionCapabilities(),
      },
      backend: {
        kind: 'openai',
        label: 'OpenAI',
        endpointLabel: 'chatgpt.com/backend-api/codex/responses',
      },
      modelCatalog,
    },
  };
}

function catalogModel(
  id: string,
  overrides: Partial<NonNullable<CliProviderStatus['modelCatalog']>['models'][number]> = {}
): NonNullable<CliProviderStatus['modelCatalog']>['models'][number] {
  return {
    id,
    launchModel: id,
    displayName: id,
    hidden: false,
    supportedReasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: false,
    upgrade: false,
    source: 'app-server',
    ...overrides,
  };
}

function createCodexCatalog(
  models: NonNullable<CliProviderStatus['modelCatalog']>['models']
): NonNullable<CliProviderStatus['modelCatalog']> {
  return {
    schemaVersion: 1,
    providerId: 'codex',
    source: 'app-server',
    status: 'ready',
    fetchedAt: '2026-09-19T00:00:00.000Z',
    staleAt: '2026-09-19T00:10:00.000Z',
    defaultModelId: models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null,
    defaultLaunchModel:
      models.find((model) => model.isDefault)?.launchModel ?? models[0]?.launchModel ?? null,
    models,
    diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
  };
}

describe('CliProviderModelAvailabilityService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses probe cache for the same provider signature', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {},
    });
    execCliMock.mockResolvedValue({ stdout: 'PONG', stderr: '' });

    const service = new CliProviderModelAvailabilityService();
    const context = createContext(['gpt-5.4', 'gpt-5.3-codex']);

    expect(service.getSnapshot(context).modelVerificationState).toBe('verifying');
    expect(service.getSnapshot(context).modelVerificationState).toBe('verifying');

    await vi.waitFor(() => {
      expect(execCliMock).toHaveBeenCalledTimes(2);
    });

    expect(service.getSnapshot(context).modelAvailability).toEqual([
      expect.objectContaining({ modelId: 'gpt-5.4', status: 'available' }),
      expect.objectContaining({ modelId: 'gpt-5.3-codex', status: 'available' }),
    ]);
    expect(execCliMock).toHaveBeenCalledTimes(2);
  });

  it('marks visible unsupported models as unavailable with the runtime reason', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {},
    });
    execCliMock.mockRejectedValue(
      new Error("The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.")
    );

    const onUpdate = vi.fn();
    const service = new CliProviderModelAvailabilityService(onUpdate);
    service.getSnapshot(createContext(['gpt-5.4']));

    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        'codex',
        expect.any(String),
        expect.objectContaining({
          modelAvailability: [
            expect.objectContaining({
              modelId: 'gpt-5.4',
              status: 'unavailable',
              reason: 'Not available on this Codex native runtime',
            }),
          ],
        })
      );
    });
  });

  it('marks timeout-like probe failures as unknown instead of unavailable', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {},
    });
    execCliMock.mockRejectedValue(new Error('Command timed out after 45000ms'));

    const onUpdate = vi.fn();
    const service = new CliProviderModelAvailabilityService(onUpdate);
    service.getSnapshot(createContext(['gpt-5.4']));

    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        'codex',
        expect.any(String),
        expect.objectContaining({
          modelAvailability: [
            expect.objectContaining({
              modelId: 'gpt-5.4',
              status: 'unknown',
              reason: 'Model verification timed out',
            }),
          ],
        })
      );
    });
  });

  it('invalidates the cache when the provider signature changes', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {},
    });
    execCliMock.mockResolvedValue({ stdout: 'PONG', stderr: '' });

    const service = new CliProviderModelAvailabilityService();
    service.getSnapshot(createContext(['gpt-5.4']));

    await vi.waitFor(() => {
      expect(execCliMock).toHaveBeenCalledTimes(1);
    });

    service.getSnapshot(createContext(['gpt-5.4', 'gpt-5.2']));

    await vi.waitFor(() => {
      expect(execCliMock).toHaveBeenCalledTimes(3);
    });
  });

  it('passes provider launch args before codex model probe flags', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
      connectionIssues: {},
    });
    execCliMock.mockResolvedValue({ stdout: 'PONG', stderr: '' });

    const service = new CliProviderModelAvailabilityService();
    service.getSnapshot(createContext(['gpt-5.4']));

    await vi.waitFor(() => {
      expect(execCliMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        [
          '--settings',
          '{"codex":{"forced_login_method":"chatgpt"}}',
          '-p',
          'Output only the single word PONG.',
          '--output-format',
          'text',
          '--model',
          'gpt-5.4',
          '--max-turns',
          '1',
          '--no-session-persistence',
        ],
        expect.objectContaining({
          env: { HOME: '/Users/tester' },
        })
      );
    });
  });

  it('uses Codex exec model probe args for the direct Codex binary', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      providerArgs: ['-c', 'forced_login_method="chatgpt"'],
      connectionIssues: {},
    });
    execCliMock.mockResolvedValue({
      stdout: '{"type":"agent_message","message":"PONG"}',
      stderr: '',
    });

    const service = new CliProviderModelAvailabilityService();
    service.getSnapshot({
      ...createContext(['gpt-5.4']),
      binaryPath: '/usr/local/bin/codex',
    });

    await vi.waitFor(() => {
      expect(execCliMock).toHaveBeenCalledWith(
        '/usr/local/bin/codex',
        [
          '-c',
          'forced_login_method="chatgpt"',
          'exec',
          '--ignore-user-config',
          '--json',
          '--skip-git-repo-check',
          '--ephemeral',
          '--model',
          'gpt-5.4',
          'Output only the single word PONG.',
        ],
        expect.objectContaining({
          env: { HOME: '/Users/tester' },
        })
      );
    });
  });

  it('allows stored Codex API-key access for model probes', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {},
    });
    execCliMock.mockResolvedValue({ stdout: 'PONG', stderr: '' });

    const service = new CliProviderModelAvailabilityService();
    service.getSnapshot(createContext(['gpt-5.4']));

    await vi.waitFor(() => {
      expect(buildProviderAwareCliEnvMock).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'codex',
          allowStoredApiKeyDecryption: false,
          allowedStoredApiKeyEnvVarNames: ['OPENAI_API_KEY'],
        })
      );
    });
  });

  it('treats local extra-catalog models as available without a vendor probe', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {},
    });
    execCliMock.mockResolvedValue({ stdout: 'PONG', stderr: '' });

    const service = new CliProviderModelAvailabilityService();
    const context = createContext(
      ['composer-2.5-fast-cursor', 'gpt-5.4'],
      createCodexCatalog([
        catalogModel('gpt-5.4', { displayName: 'GPT-5.4', isDefault: true }),
        catalogModel('composer-2.5-fast-cursor', {
          displayName: 'Composer 2.5 Fast · Cursor',
          metadata: { configuredFromLocalCatalog: true },
        }),
      ])
    );
    service.getSnapshot(context);

    await vi.waitFor(() => {
      expect(
        service.getSnapshot(context).modelAvailability.find((item) => item.modelId === 'gpt-5.4')
          ?.status
      ).not.toBe('checking');
    });

    expect(service.getSnapshot(context).modelAvailability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'composer-2.5-fast-cursor',
          status: 'available',
        }),
        expect.objectContaining({ modelId: 'gpt-5.4' }),
      ])
    );
    expect(execCliMock).toHaveBeenCalledTimes(1);
    expect(execCliMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--model', 'gpt-5.4']));
  });

  it('does not keep a vendor-probe miss after extra-catalog tags arrive', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {},
    });
    execCliMock.mockImplementation(async (_binary: string, args: string[]) => {
      if (args.includes('local-proxy-qwen3')) {
        throw new Error('The requested model is not available for your account.');
      }
      return { stdout: 'PONG', stderr: '' };
    });

    const service = new CliProviderModelAvailabilityService();
    const models = ['local-proxy-qwen3', 'gpt-5.4'];
    service.getSnapshot(createContext(models));

    await vi.waitFor(() => {
      expect(
        service
          .getSnapshot(createContext(models))
          .modelAvailability.find((item) => item.modelId === 'local-proxy-qwen3')?.status
      ).toBe('unavailable');
    });

    const tagged = createContext(
      models,
      createCodexCatalog([
        catalogModel('gpt-5.4', { isDefault: true }),
        catalogModel('local-proxy-qwen3', {
          metadata: { configuredFromLocalCatalog: true },
        }),
      ])
    );
    expect(
      service.getSnapshot(tagged).modelAvailability.find((item) => item.modelId === 'local-proxy-qwen3')
    ).toMatchObject({ status: 'available' });
  });

  it('marks a catalog of only extra models verified without probing', () => {
    const service = new CliProviderModelAvailabilityService();
    const snapshot = service.getSnapshot(
      createContext(
        ['local-proxy-qwen3'],
        createCodexCatalog([
          catalogModel('local-proxy-qwen3', {
            isDefault: true,
            metadata: { configuredFromLocalCatalog: true },
          }),
        ])
      )
    );

    expect(snapshot.modelVerificationState).toBe('verified');
    expect(snapshot.modelAvailability).toEqual([
      expect.objectContaining({ modelId: 'local-proxy-qwen3', status: 'available' }),
    ]);
    expect(execCliMock).not.toHaveBeenCalled();
  });
});
