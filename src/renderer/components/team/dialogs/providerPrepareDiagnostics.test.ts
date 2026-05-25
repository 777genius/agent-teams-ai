import { OPENCODE_WINDOWS_ACCESS_DENIED_MESSAGE } from '@shared/utils/openCodeWindowsAccessDenied';
import { describe, expect, it } from 'vitest';

import { runProviderPrepareDiagnostics } from './providerPrepareDiagnostics';

import type { TeamProvisioningPrepareResult } from '@shared/types';

describe('runProviderPrepareDiagnostics', () => {
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
});
