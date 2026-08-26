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

function createContext(models: string[]): ProviderModelAvailabilityContext {
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
    },
  };
}

function buildProbeResponse(args: readonly string[], nonceOverride?: string): string {
  const prompt = args.find((arg) => arg.includes('Set nonce to ')) ?? '';
  const nonce = nonceOverride ?? /Set nonce to ([a-f0-9]+)\./.exec(prompt)?.[1] ?? 'missing';
  return JSON.stringify({
    schema: 'agent-teams-provider-probe-response-v1',
    nonce,
  });
}

function mockSuccessfulProbeResponse(): void {
  execCliMock.mockImplementation(async (_binaryPath, args: string[]) => ({
    stdout: buildProbeResponse(args),
    stderr: '',
  }));
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
    mockSuccessfulProbeResponse();

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
    mockSuccessfulProbeResponse();

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
    mockSuccessfulProbeResponse();

    const service = new CliProviderModelAvailabilityService();
    service.getSnapshot(createContext(['gpt-5.4']));

    await vi.waitFor(() => {
      expect(execCliMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        [
          '--settings',
          '{"codex":{"forced_login_method":"chatgpt"}}',
          '-p',
          expect.stringContaining('agent-teams-provider-probe-response-v1'),
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
    mockSuccessfulProbeResponse();

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
          expect.stringContaining('agent-teams-provider-probe-response-v1'),
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
    mockSuccessfulProbeResponse();

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

  it('binds direct model availability validation to a fresh caller nonce', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { HOME: '/Users/tester' },
      connectionIssues: {},
    });
    execCliMock.mockImplementation(async (_binaryPath, args: string[]) => ({
      stdout: buildProbeResponse(args, 'forged-response-nonce'),
      stderr: '',
    }));

    const onUpdate = vi.fn();
    const service = new CliProviderModelAvailabilityService(onUpdate);
    service.getSnapshot(createContext(['gpt-5.4']));

    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        'codex',
        expect.any(String),
        expect.objectContaining({
          modelAvailability: [
            expect.objectContaining({ modelId: 'gpt-5.4', status: 'unknown' }),
          ],
        })
      );
    });
    const prompt = execCliMock.mock.calls[0][1].find((arg: string) => arg.includes('Set nonce to '));
    expect(prompt).toMatch(/Set nonce to [a-f0-9]{64}\./);
    expect(prompt).not.toContain('forged-response-nonce');
  });
});
