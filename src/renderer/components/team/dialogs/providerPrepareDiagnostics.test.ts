import { OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE } from '@shared/utils/openCodeWindowsAccessDenied';
import { describe, expect, it, vi } from 'vitest';

import { runProviderPrepareDiagnostics } from './providerPrepareDiagnostics';

import type { TeamProvisioningPrepareResult } from '@shared/types';

describe('runProviderPrepareDiagnostics', () => {
  it('preserves backend-separated exact checks through ordinary diagnostics', async () => {
    const calls: unknown[][] = [];
    const checks = [
      { providerId: 'codex' as const, providerBackendId: 'adapter' as const, model: 'gpt-5', effort: 'high' as const },
      { providerId: 'codex' as const, providerBackendId: 'codex-native' as const, model: 'gpt-5', effort: 'high' as const },
    ];
    await runProviderPrepareDiagnostics({
      cwd: '/workspace/test-project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5'],
      selectedModelChecks: checks,
      prepareProvisioning: async (...args): Promise<TeamProvisioningPrepareResult> => {
        calls.push(args);
        return args[5] === 'compatibility'
          ? { ready: true, message: 'compatible', details: ['Selected model gpt-5 is available for launch.'] }
          : {
              ready: true,
              message: 'verified',
              details: ['Selected model gpt-5 verified for launch.'],
              executionProof: { authorityId: 'proof', generation: 1, completedAt: '2026-08-21T00:00:00.000Z', expiresAt: '2026-08-21T00:01:00.000Z', requestDigest: 'a'.repeat(64) },
            };
      },
    });
    expect(calls.every((call) => call[6] === undefined || JSON.stringify(call[6]) === JSON.stringify(checks))).toBe(true);
    expect(calls.at(-1)?.[6]).toEqual(checks);
  });

  it('requires a custom OpenCode route to pass compatibility and deep verification', async () => {
    const modelId = 'local-lab/team-model';
    type PrepareProvisioning = Parameters<
      typeof runProviderPrepareDiagnostics
    >[0]['prepareProvisioning'];
    const prepareProvisioning = vi.fn<PrepareProvisioning>(
      async (
        _cwd,
        _providerId,
        _providerIds,
        modelIds,
        _limitContext,
        verificationMode
      ): Promise<TeamProvisioningPrepareResult> => ({
        ready: true,
        message: '',
        details: [
          verificationMode === 'compatibility'
            ? `Selected model ${modelId} is compatible. Deep verification pending.`
            : `Selected model ${modelId} verified for launch with Agent Teams tool coordination.`,
        ],
      })
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/workspace/test-project',
      providerId: 'opencode',
      selectedModelIds: [modelId],
      prepareProvisioning,
    });

    expect(prepareProvisioning).toHaveBeenCalledTimes(2);
    expect(prepareProvisioning.mock.calls.map((call) => call[5])).toEqual([
      'compatibility',
      'deep',
    ]);
    expect(prepareProvisioning.mock.calls[1]?.[3]).toEqual([modelId]);
    expect(result.status).toBe('ready');
    expect(result.modelResultsById[modelId]?.status).toBe('ready');
  });

  it('normalizes OpenCode access-denied provider failures', async () => {
    const result = await runProviderPrepareDiagnostics({
      cwd: 'C:\\Program Files\\locked-project',
      providerId: 'opencode',
      selectedModelIds: [],
      prepareProvisioning: async (): Promise<TeamProvisioningPrepareResult> => ({
        ready: false,
        message: 'OpenCode bridge failed: EPERM: operation not permitted, mkdir C:\\Program Files',
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE]);
  });

  it('keeps non-OpenCode access-denied provider failures generic', async () => {
    const detail = 'EACCES: permission denied, open C:\\work\\repo';
    const result = await runProviderPrepareDiagnostics({
      cwd: 'C:\\work\\repo',
      providerId: 'anthropic',
      selectedModelIds: [],
      prepareProvisioning: async (): Promise<TeamProvisioningPrepareResult> => ({
        ready: false,
        message: detail,
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([detail]);
  });

  it('normalizes OpenCode access-denied runtime note details', async () => {
    const result = await runProviderPrepareDiagnostics({
      cwd: 'C:\\Program Files\\locked-project',
      providerId: 'opencode',
      selectedModelIds: [],
      prepareProvisioning: async (): Promise<TeamProvisioningPrepareResult> => ({
        ready: true,
        message: '',
        warnings: ['EACCES: permission denied, open C:\\Program Files\\locked-project'],
      }),
    });

    expect(result.status).toBe('notes');
    expect(result.details).toEqual([OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE]);
    expect(result.warnings).toEqual([OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE]);
  });

  it('treats model-scoped OpenCode access-denied details as provider failures', async () => {
    const result = await runProviderPrepareDiagnostics({
      cwd: 'C:\\Program Files\\locked-project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning: async (): Promise<TeamProvisioningPrepareResult> => ({
        ready: false,
        message: 'Selected model opencode/big-pickle is unavailable.',
        details: [
          'Selected model opencode/big-pickle is unavailable. EPERM: operation not permitted',
        ],
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE]);
    expect(result.modelResultsById).toEqual({});
  });

  it('surfaces an experimental override only for an explicitly overrideable model failure', async () => {
    const modelId = 'ollama/qwen3:4b';
    const result = await runProviderPrepareDiagnostics({
      cwd: '/workspace/test-project',
      providerId: 'opencode',
      selectedModelIds: [modelId],
      prepareProvisioning: async (
        _cwd,
        _providerId,
        _providerIds,
        _modelIds,
        _limitContext,
        verificationMode
      ): Promise<TeamProvisioningPrepareResult> =>
        verificationMode === 'compatibility'
          ? {
              ready: true,
              message: 'Compatible.',
              details: [`Selected model ${modelId} is compatible. Deep verification pending.`],
            }
          : {
              ready: false,
              message: `Selected model ${modelId} is unavailable.`,
              details: [
                `Selected model ${modelId} is unavailable. Agent Teams coordination was not confirmed.`,
              ],
              issues: [
                {
                  providerId: 'opencode',
                  modelId,
                  scope: 'model',
                  severity: 'blocking',
                  code: 'local_coordination_probe_failed',
                  message: 'Agent Teams coordination was not confirmed.',
                  experimentalOverrideAvailable: true,
                },
              ],
            },
    });

    expect(result.status).toBe('failed');
    expect(result.experimentalOverrideAvailable).toBe(true);
    expect(result.modelResultsById[modelId]).toMatchObject({
      status: 'failed',
      experimentalOverrideAvailable: true,
    });
  });
});
