import { createTeamProvisioningDiagnosticsTransport } from '@renderer/composition/team/createTeamProvisioningDiagnosticsTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamLaunchFailureDiagnosticsBundle } from '@shared/types';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

const mocks = vi.hoisted(() => ({
  getLaunchFailureDiagnostics: vi.fn(),
  validateCliArgs: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: mocks,
  },
}));

describe('createTeamProvisioningDiagnosticsTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates diagnostics reads and argument validation without changing results', async () => {
    const diagnostics: TeamLaunchFailureDiagnosticsBundle = {
      teamName: 'sandbox-team',
      runId: 'run-7',
      latestPath: '/sandbox/latest.json',
      files: [],
    };
    const validation: CliArgsValidationResult = {
      valid: false,
      invalidFlags: ['--unknown'],
    };
    mocks.getLaunchFailureDiagnostics.mockResolvedValueOnce(diagnostics);
    mocks.validateCliArgs.mockResolvedValueOnce(validation);
    const transport = createTeamProvisioningDiagnosticsTransport();

    await expect(transport.getLaunchFailureDiagnostics('sandbox-team', 'run-7')).resolves.toBe(
      diagnostics
    );
    await expect(transport.validateCliArgs('--unknown')).resolves.toBe(validation);
    expect(mocks.getLaunchFailureDiagnostics).toHaveBeenCalledWith('sandbox-team', 'run-7');
    expect(mocks.validateCliArgs).toHaveBeenCalledWith('--unknown');
  });

  it('preserves unsupported and failure results for consumer error policies', async () => {
    const diagnosticsFailure = new Error('diagnostics unavailable');
    const validationFailure = new Error('CLI args validation not available in browser mode');
    mocks.getLaunchFailureDiagnostics.mockRejectedValueOnce(diagnosticsFailure);
    mocks.validateCliArgs.mockRejectedValueOnce(validationFailure);
    const transport = createTeamProvisioningDiagnosticsTransport();

    await expect(transport.getLaunchFailureDiagnostics('sandbox-team')).rejects.toBe(
      diagnosticsFailure
    );
    await expect(transport.validateCliArgs('--unknown')).rejects.toBe(validationFailure);
  });
});
