import { describe, expect, it, vi } from 'vitest';

import { TeamLaunchValidationError } from '../TeamLaunchValidationError';
import {
  assertCodexChatGptLaunchModelSupported,
  createCodexChatGptModelSupportProbe,
  shouldProbeCodexChatGptModelSupport,
} from '../TeamProvisioningCodexChatGptModelGate';
import { createTeamProvisioningLaunchIdentityBoundary } from '../TeamProvisioningLaunchIdentityBoundaryFactory';

const REPRO_SIGNATURE =
  "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account.";

describe('createCodexChatGptModelSupportProbe', () => {
  const probeInput = {
    claudePath: '/bin/claude',
    cwd: '/repo',
    env: { PATH: '/bin' },
    providerArgs: ['--provider-arg'],
    modelId: 'gpt-5.2',
  };

  it('classifies a rejected probe carrying the repro signature as unsupported', async () => {
    const execCli = vi
      .fn()
      .mockRejectedValue(
        new Error(`Command failed: 400 invalid_request_error: ${REPRO_SIGNATURE}`)
      );
    const probe = createCodexChatGptModelSupportProbe({ execCli });

    await expect(probe(probeInput)).resolves.toEqual({
      outcome: 'unsupported',
      message: `Command failed: 400 invalid_request_error: ${REPRO_SIGNATURE}`,
    });
    expect(execCli).toHaveBeenCalledWith(
      '/bin/claude',
      [
        '--provider-arg',
        '-p',
        'Output only the single word PONG.',
        '--output-format',
        'text',
        '--model',
        'gpt-5.2',
        '--max-turns',
        '1',
        '--no-session-persistence',
      ],
      expect.objectContaining({ cwd: '/repo', env: { PATH: '/bin' } })
    );
  });

  it('classifies the signature printed to probe output as unsupported', async () => {
    const execCli = vi.fn().mockResolvedValue({ stdout: '', stderr: REPRO_SIGNATURE });
    const probe = createCodexChatGptModelSupportProbe({ execCli });

    await expect(probe(probeInput)).resolves.toEqual({
      outcome: 'unsupported',
      message: REPRO_SIGNATURE,
    });
  });

  it('reports a PONG response as supported', async () => {
    const execCli = vi.fn().mockResolvedValue({ stdout: 'PONG\n', stderr: '' });
    const probe = createCodexChatGptModelSupportProbe({ execCli });

    await expect(probe(probeInput)).resolves.toEqual({ outcome: 'supported' });
  });

  it('treats unrelated failures and odd output as inconclusive', async () => {
    const failing = createCodexChatGptModelSupportProbe({
      execCli: vi.fn().mockRejectedValue(new Error('Timeout running: codex probe')),
    });
    await expect(failing(probeInput)).resolves.toEqual({ outcome: 'inconclusive' });

    const odd = createCodexChatGptModelSupportProbe({
      execCli: vi.fn().mockResolvedValue({ stdout: 'unexpected banner', stderr: '' }),
    });
    await expect(odd(probeInput)).resolves.toEqual({ outcome: 'inconclusive' });
  });
});

describe('shouldProbeCodexChatGptModelSupport', () => {
  const chatGptStatus = { providerId: 'codex' as const, authMethod: 'chatgpt' };

  it('probes only explicit codex selections under ChatGPT auth', () => {
    expect(
      shouldProbeCodexChatGptModelSupport({
        providerId: 'codex',
        model: ' gpt-5.2 ',
        providerStatus: chatGptStatus,
      })
    ).toBe('gpt-5.2');
    expect(
      shouldProbeCodexChatGptModelSupport({
        providerId: 'codex',
        model: 'default',
        providerStatus: chatGptStatus,
      })
    ).toBeNull();
    expect(
      shouldProbeCodexChatGptModelSupport({
        providerId: 'anthropic',
        model: 'gpt-5.2',
        providerStatus: chatGptStatus,
      })
    ).toBeNull();
    expect(
      shouldProbeCodexChatGptModelSupport({
        providerId: 'codex',
        model: 'gpt-5.2',
        providerStatus: { providerId: 'codex', authMethod: 'api_key' },
      })
    ).toBeNull();
  });
});

describe('assertCodexChatGptLaunchModelSupported', () => {
  const gatedStatus = {
    providerId: 'codex' as const,
    authMethod: 'chatgpt',
    modelAvailability: [
      { modelId: 'gpt-5.2', status: 'unavailable' as const, reason: REPRO_SIGNATURE },
    ],
  };

  it('throws a launch validation error for a ChatGPT-gated selection', () => {
    const run = (): void =>
      assertCodexChatGptLaunchModelSupported({
        actorLabel: 'Member Reviewer',
        explicitModel: 'gpt-5.2',
        providerStatus: gatedStatus,
      });
    expect(run).toThrow('not supported when using Codex with a ChatGPT account');
    // The typed error keeps the HTTP launch surface on its 422 validation contract.
    expect(run).toThrow(TeamLaunchValidationError);
  });

  it('passes default selections, other models, and API-key auth', () => {
    expect(() =>
      assertCodexChatGptLaunchModelSupported({
        actorLabel: 'Member Reviewer',
        explicitModel: undefined,
        providerStatus: gatedStatus,
      })
    ).not.toThrow();
    expect(() =>
      assertCodexChatGptLaunchModelSupported({
        actorLabel: 'Member Reviewer',
        explicitModel: 'gpt-5.6-sol',
        providerStatus: gatedStatus,
      })
    ).not.toThrow();
    expect(() =>
      assertCodexChatGptLaunchModelSupported({
        actorLabel: 'Member Reviewer',
        explicitModel: 'gpt-5.2',
        providerStatus: { ...gatedStatus, authMethod: 'api_key' },
      })
    ).not.toThrow();
  });
});

describe('launch identity boundary ChatGPT model gate (live repro)', () => {
  function createBoundaryWithRuntime(params: { probeFailure: string | null }) {
    const execCli = vi.fn(async (_binaryPath: string | null, args: string[]) => {
      if (args.includes('model') && args.includes('list')) {
        return {
          stdout: JSON.stringify({
            providers: {
              codex: { defaultModel: 'gpt-5.6-sol', models: ['gpt-5.6-sol', 'gpt-5.2'] },
            },
          }),
          stderr: '',
        };
      }
      if (args.includes('runtime') && args.includes('status')) {
        return {
          stdout: JSON.stringify({
            providers: {
              codex: {
                authenticated: true,
                authMethod: 'chatgpt',
                runtimeCapabilities: { modelCatalog: { dynamic: false } },
              },
            },
          }),
          stderr: '',
        };
      }
      if (args.includes('-p')) {
        const probedModel = args[args.indexOf('--model') + 1];
        if (params.probeFailure && probedModel === 'gpt-5.2') {
          throw new Error(params.probeFailure);
        }
        return { stdout: 'PONG', stderr: '' };
      }
      throw new Error(`Unexpected CLI invocation: ${args.join(' ')}`);
    });

    const boundary = createTeamProvisioningLaunchIdentityBoundary({
      execCli,
      providerConnectionService: { getCodexModelCatalog: async () => null },
      getAnthropicFastModeDefault: () => false,
      getProviderLabel: () => 'Codex',
      logger: { warn: () => undefined },
    });
    return { boundary, execCli };
  }

  it('blocks a launch whose member model fails the ChatGPT support probe', async () => {
    const { boundary } = createBoundaryWithRuntime({
      probeFailure: `400 invalid_request_error: ${REPRO_SIGNATURE}`,
    });

    const launch = boundary.resolveAndValidateLaunchIdentity({
      claudePath: '/bin/claude',
      cwd: '/repo',
      env: { PATH: '/bin' },
      request: { providerId: 'codex', model: 'gpt-5.6-sol' },
      effectiveMembers: [{ name: 'Reviewer', providerId: 'codex', model: 'gpt-5.2' }],
    });

    await expect(launch).rejects.toThrow('not supported when using Codex with a ChatGPT account');
  });

  it('launches normally when the selected models pass the probe', async () => {
    const { boundary, execCli } = createBoundaryWithRuntime({ probeFailure: null });

    await expect(
      boundary.resolveAndValidateLaunchIdentity({
        claudePath: '/bin/claude',
        cwd: '/repo',
        env: { PATH: '/bin' },
        request: { providerId: 'codex', model: 'gpt-5.6-sol' },
        effectiveMembers: [
          { name: 'Reviewer', providerId: 'codex', model: 'gpt-5.6-sol' },
          { name: 'Builder', providerId: 'codex', model: 'gpt-5.6-sol' },
        ],
      })
    ).resolves.toMatchObject({ providerId: 'codex', resolvedLaunchModel: 'gpt-5.6-sol' });

    // Lead and both members share one deduplicated probe for the same model.
    const probeCalls = execCli.mock.calls.filter(([, args]) => args.includes('-p'));
    expect(probeCalls).toHaveLength(1);
  });
});
