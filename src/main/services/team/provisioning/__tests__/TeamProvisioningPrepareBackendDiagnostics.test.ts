import { describe, expect, it, vi } from 'vitest';

import { runExactBackendOneShotDiagnostics } from '../TeamProvisioningPrepareBackendDiagnostics';

import type { TeamProvisioningModelCheckRequest } from '@shared/types';

const CHECK: TeamProvisioningModelCheckRequest = {
  providerId: 'codex',
  providerBackendId: 'codex-native',
  model: 'gpt-5.6-sol',
  effort: 'high',
};

function runWithFake(
  runProviderOneShotDiagnostic: Parameters<
    typeof runExactBackendOneShotDiagnostics
  >[0]['runProviderOneShotDiagnostic']
) {
  return runExactBackendOneShotDiagnostics({
    providerId: 'codex',
    providerLabel: 'Codex',
    providerCount: 1,
    backendIds: ['codex-native'],
    modelChecks: [CHECK],
    modelVerificationMode: 'deep',
    authSource: 'codex_runtime',
    claudePath: '/fake/claude',
    cwd: '/fake/project',
    buildProvisioningEnv: vi.fn().mockResolvedValue({
      env: { PATH: '/fake' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--provider', 'codex'],
    }),
    runProviderOneShotDiagnostic,
  });
}

describe('runExactBackendOneShotDiagnostics native liveness evidence', () => {
  it('records only model-targeted liveness after a successful probe', async () => {
    const execute = vi.fn(async (...args: unknown[]) => ({
      targetedLiveness: args[5] as TeamProvisioningModelCheckRequest,
    }));

    const result = await runWithFake(execute);

    expect(result).toEqual({
      warnings: [],
      blockingMessages: [],
      targetedLivenessChecks: [CHECK],
    });
    expect(execute).toHaveBeenCalledWith(
      '/fake/claude',
      '/fake/project',
      { PATH: '/fake' },
      'codex',
      ['--provider', 'codex'],
      CHECK
    );
  });

  it('rejects a generic/default probe with no exact observation', async () => {
    const result = await runWithFake(vi.fn().mockResolvedValue({}));

    expect(result.targetedLivenessChecks).toEqual([]);
    expect(result.blockingMessages).toEqual([
      'Model-targeted liveness for gpt-5.6-sol returned only a generic/default probe result.',
    ]);
  });

  it('rejects a timed-out exact execution', async () => {
    const result = await runWithFake(
      vi.fn().mockResolvedValue({ warning: 'Exact execution timed out.' })
    );

    expect(result.targetedLivenessChecks).toEqual([]);
    expect(result.blockingMessages).toEqual(['Exact execution timed out.']);
  });

  it.each([
    ['provider', { ...CHECK, providerId: 'anthropic' as const }],
    ['backend', { ...CHECK, providerBackendId: 'adapter' as const }],
    ['model', { ...CHECK, model: 'gpt-default' }],
    ['effort', { ...CHECK, effort: 'low' as const }],
  ])('rejects mismatched targeted %s', async (_field, targetedLiveness) => {
    const result = await runWithFake(vi.fn().mockResolvedValue({ targetedLiveness }));

    expect(result.targetedLivenessChecks).toEqual([]);
    expect(result.blockingMessages[0]).toContain(
      'did not match the selected provider/backend/model/effort tuple'
    );
  });
});
