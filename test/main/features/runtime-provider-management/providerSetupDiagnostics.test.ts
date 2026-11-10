import { describe, expect, it, vi } from 'vitest';

import { normalizeRuntimeErrorDetails } from '../../../../src/features/runtime-provider-management/contracts/errorDiagnostics';
import { withProviderCommandDiagnostics } from '../../../../src/features/runtime-provider-management/main/infrastructure/providerCommandDiagnostics';
import { withProviderSetupDiagnostics } from '../../../../src/features/runtime-provider-management/main/infrastructure/providerSetupDiagnostics';
import { formatRuntimeProviderDiagnosticsCopyText } from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderErrorAlert';

import type { RuntimeProviderManagementProviderResponse } from '../../../../src/features/runtime-provider-management/contracts';

const failure = (): RuntimeProviderManagementProviderResponse => ({
  schemaVersion: 1,
  runtimeId: 'opencode',
  error: {
    code: 'provider-missing',
    message: 'OpenCode provider github-copilot was not found in the live catalog',
    recoverable: true,
  },
});
const context = { operation: 'connect', providerId: 'github-copilot', projectPath: null };

describe('provider setup support report', () => {
  it('copies managed OpenCode version and location independently of orchestrator command evidence', async () => {
    const response = withProviderCommandDiagnostics(
      failure(),
      {
        binaryPath: 'C:\\AgentTeams\\runtime.exe',
        args: ['runtime', 'providers', 'connect'],
        projectPath: null,
      },
      'GET /provider failed: ECONNREFUSED; token=secret-value',
      1
    );
    const result = await withProviderSetupDiagnostics(response, context, async () => ({
      installed: true,
      version: '1.18.29',
      binaryPath: 'C:\\AgentTeams\\runtimes\\opencode.exe',
      source: 'app-managed',
      state: 'ready',
    }));
    const report = formatRuntimeProviderDiagnosticsCopyText(
      result.error!.message,
      result.error!.diagnostics
    );
    for (const text of [
      '1.18.29',
      'opencode.exe',
      'runtime.exe',
      'app-managed',
      'github-copilot',
      'ECONNREFUSED',
      'terminal PATH',
    ]) {
      expect(report).toContain(text);
    }
    expect(report).not.toContain('secret-value');
    expect(result.error!.diagnostics).toMatchObject({ exitCode: 1, openCodeInstalled: true });
    expect(normalizeRuntimeErrorDetails(result.error!.diagnostics)).toMatchObject({
      openCodeVersion: '1.18.29',
      operation: 'connect',
    });
  });

  it('records missing installation without inventing a version or an inner HTTP cause', async () => {
    const result = await withProviderSetupDiagnostics(failure(), context, async () => ({
      installed: false,
      source: 'missing',
      state: 'idle',
    }));
    expect(result.error!.diagnostics).toMatchObject({
      openCodeInstalled: false,
      openCodeVersion: 'unknown',
      openCodeSource: 'missing',
    });
    expect(result.error!.diagnostics?.hints.join(' ')).toContain('no detailed diagnostics');
    expect(result.error!.diagnostics?.httpStatus).toBeUndefined();
  });

  it('keeps upstream evidence and returns the original failure if status lookup fails', async () => {
    const response = failure();
    response.error!.diagnostics = {
      reportId: 'upstream-id',
      summary: 'catalog failed',
      likelyCause: null,
      binaryPath: '/runtime',
      command: 'connect',
      projectPath: null,
      exitCode: 1,
      stderrPreview: null,
      stdoutPreview: null,
      hints: [],
      stage: 'catalog_http',
      httpStatus: 503,
    };
    const result = await withProviderSetupDiagnostics(response, context, async () => {
      throw new Error('token=private-status');
    });
    expect(result.error!.diagnostics).toMatchObject({
      reportId: 'upstream-id',
      stage: 'catalog_http',
      httpStatus: 503,
    });
    expect(result.error!.diagnostics?.hints.join(' ')).toContain('status lookup failed');
    expect(JSON.stringify(result)).not.toContain('private-status');
  });

  it('does not inspect runtime status or change successful responses', async () => {
    const readStatus = vi.fn();
    const response = { schemaVersion: 1 as const, runtimeId: 'opencode' as const };
    expect(
      await withProviderSetupDiagnostics(
        response as RuntimeProviderManagementProviderResponse,
        context,
        readStatus
      )
    ).toBe(response);
    expect(readStatus).not.toHaveBeenCalled();
  });
});
