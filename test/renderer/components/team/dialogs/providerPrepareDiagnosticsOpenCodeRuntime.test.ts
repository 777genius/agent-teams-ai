import { runProviderPrepareDiagnostics } from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { describe, expect, it, vi } from 'vitest';

import type { TeamProviderId, TeamProvisioningPrepareResult } from '@shared/types';

type PrepareProvisioningFn = (
  cwd?: string,
  providerId?: TeamProviderId,
  providerIds?: TeamProviderId[],
  selectedModels?: string[],
  limitContext?: boolean,
  modelVerificationMode?: 'compatibility' | 'deep'
) => Promise<TeamProvisioningPrepareResult>;

describe('runProviderPrepareDiagnostics OpenCode runtime failures', () => {
  it('normalizes missing OpenCode binary diagnostics for packaged launch preflight', async () => {
    const prepareProvisioning = vi.fn<PrepareProvisioningFn>().mockResolvedValue({
      ready: false,
      message: 'OpenCode CLI not detected on PATH',
      details: ['OpenCode CLI not found'],
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/Users/tester/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      'OpenCode runtime binary is not installed or not reachable by launch preflight.',
    ]);
    expect(result.modelResultsById).toEqual({});
    expect(prepareProvisioning).toHaveBeenCalledWith(
      '/Users/tester/project',
      'opencode',
      ['opencode'],
      ['opencode/big-pickle'],
      undefined,
      'compatibility'
    );
  });

  it('normalizes structured OpenCode provider issue messages that bypass runtime details', async () => {
    const prepareProvisioning = vi.fn<PrepareProvisioningFn>().mockResolvedValue({
      ready: false,
      message: 'not_installed',
      details: ['OpenCode CLI not detected on PATH'],
      issues: [
        {
          providerId: 'opencode',
          scope: 'provider',
          severity: 'blocking',
          code: 'not_installed',
          message: 'OpenCode CLI not detected on PATH',
        },
      ],
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/Users/tester/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      'OpenCode runtime binary is not installed or not reachable by launch preflight.',
    ]);
    expect(result.modelResultsById).toEqual({});
  });

  it('preserves support diagnostics for OpenCode bridge no-output provider failures', async () => {
    const supportDiagnostic = {
      id: 'diag-empty-stdout',
      providerId: 'opencode' as const,
      kind: 'opencode_bridge_no_output',
      severity: 'error' as const,
      title: 'OpenCode runtime check returned no output',
      summary: 'OpenCode readiness bridge exited without returning diagnostic JSON.',
      copyText: 'Agent Teams OpenCode diagnostics\noutputReadError: ENOENT',
      createdAt: '2026-04-21T12:00:00.000Z',
    };
    const prepareProvisioning = vi.fn<PrepareProvisioningFn>().mockResolvedValue({
      ready: false,
      message: 'OpenCode readiness bridge failed: contract_violation: Bridge stdout was empty',
      details: [
        'OpenCode readiness bridge failed: contract_violation: Bridge stdout was empty',
      ],
      issues: [
        {
          providerId: 'opencode',
          scope: 'provider',
          severity: 'blocking',
          code: 'unknown_error',
          message:
            'OpenCode readiness bridge failed: contract_violation: Bridge stdout was empty',
        },
      ],
      supportDiagnostics: [supportDiagnostic],
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/Users/tester/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/qwen3.6-2b'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual(['OpenCode runtime check returned no output.']);
    expect(result.modelResultsById).toEqual({});
    expect(result.supportDiagnostics).toEqual([supportDiagnostic]);
  });
});
