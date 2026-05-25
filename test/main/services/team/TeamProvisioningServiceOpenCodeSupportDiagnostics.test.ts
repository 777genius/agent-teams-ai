import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type TeamLaunchRuntimeAdapter,
  TeamRuntimeAdapterRegistry,
} from '../../../../src/main/services/team/runtime';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

let tempRoot: string;

describe('TeamProvisioningService OpenCode support diagnostics', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-provisioning-opencode-support-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('keeps bridge no-output selected-model failures provider-scoped with support diagnostics', async () => {
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
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'unknown_error',
      retryable: false,
      diagnostics: [
        'OpenCode readiness bridge failed: contract_violation: Bridge stdout was empty',
      ],
      warnings: [],
      supportDiagnostics: [supportDiagnostic],
    }));
    const adapter: TeamLaunchRuntimeAdapter = {
      providerId: 'opencode',
      prepare,
      launch: vi.fn(),
      reconcile: vi.fn(),
      stop: vi.fn(),
    };
    const service = new TeamProvisioningService();
    service.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const result = await service.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
      modelIds: ['opencode/qwen3.6-2b'],
      modelVerificationMode: 'deep',
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe('OpenCode runtime check returned no output.');
    expect(result.details).toEqual(['OpenCode runtime check returned no output.']);
    expect(result.supportDiagnostics).toEqual([supportDiagnostic]);
    expect(result.issues).toEqual([
      {
        providerId: 'opencode',
        scope: 'provider',
        severity: 'blocking',
        code: 'unknown_error',
        message: 'OpenCode runtime check returned no output.',
      },
    ]);
  });

  it('uses bridge no-output diagnostics as the model-less prepare failure message', async () => {
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
    const prepare = vi.fn(async () => ({
      ok: false as const,
      providerId: 'opencode' as const,
      reason: 'unknown_error',
      retryable: false,
      diagnostics: [
        'OpenCode readiness bridge failed: contract_violation: Bridge stdout was empty',
      ],
      warnings: [],
      supportDiagnostics: [supportDiagnostic],
    }));
    const adapter: TeamLaunchRuntimeAdapter = {
      providerId: 'opencode',
      prepare,
      launch: vi.fn(),
      reconcile: vi.fn(),
      stop: vi.fn(),
    };
    const service = new TeamProvisioningService();
    service.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const result = await service.prepareForProvisioning(tempRoot, {
      providerId: 'opencode',
      forceFresh: true,
    });

    expect(result.ready).toBe(false);
    expect(result.message).toBe('OpenCode runtime check returned no output.');
    expect(result.details).toEqual(['OpenCode runtime check returned no output.']);
    expect(result.supportDiagnostics).toEqual([supportDiagnostic]);
  });
});
