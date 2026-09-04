import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamProvisioningPrepareFacade } from '@main/services/team/provisioning/TeamProvisioningPrepareFacade';
import { TeamProvisioningProviderRuntimeFacade } from '@main/services/team/provisioning/TeamProvisioningProviderRuntimeFacade';
import { spawnCli } from '@main/utils/childProcess';
import { runProviderPrepareDiagnostics } from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/utils/childProcess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/childProcess')>()),
  spawnCli: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('PONG'));
      child.emit('close', 0);
    });
    return child;
  }),
  killProcessTree: vi.fn(),
  execCli: vi.fn().mockRejectedValue(new Error('Unexpected process execution in fake-port test')),
}));

describe('renderer to provider diagnostic transport', () => {
  it('keeps selected Luna through compatibility, deep prepare, facades, runtime factory and spawn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'codex-diagnostic-transport-test-'));
    const env = { PATH: '/fake-bin' };
    const environment = {
      env,
      authSource: 'none' as const,
      geminiRuntimeAuth: null,
      providerArgs: [],
    };
    const runtime = new TeamProvisioningProviderRuntimeFacade({
      diagnosticsRuntimeInput: {
        transientProbeProcesses: new Set(),
        providerConnectionService: { getConfiguredCodexCustomProviderModel: () => 'gpt-5.6-sol' },
        logger: { info: vi.fn(), warn: vi.fn() },
        isAuthFailureWarning: () => false,
        normalizeApiRetryErrorMessage: (text) => text,
      },
      envRuntimePorts: {
        getProvisioningEnvBuilderPorts: vi.fn(),
        buildProvisioningEnv: async () => environment,
        buildCrossProviderMemberArgs: vi.fn(),
        resolveControlApiBaseUrl: async () => '',
      },
    });
    const facade = new TeamProvisioningPrepareFacade({
      getOpenCodeRuntimeAdapter: () => null,
      buildProvisioningEnv: async () => environment,
      runProviderOneShotDiagnostic: (...args) => runtime.runProviderOneShotDiagnostic(...args),
      readRuntimeProviderLaunchFacts: async () => ({
        defaultModel: 'gpt-5.6-sol',
        modelIds: new Set(['gpt-5.6-luna']),
        modelListParsed: true,
        runtimeCapabilities: null,
        modelCatalog: null,
        providerStatus: { providerId: 'codex', authMethod: 'api_key' },
      }),
      resolveClaudeBinaryPath: async () => '/fake/cli',
      probeClaudeRuntime: async () => ({}),
      ensureMemberWorktree: vi.fn(),
      planRuntimeLanesOrThrow: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    });
    try {
      const result = await runProviderPrepareDiagnostics({
        cwd,
        providerId: 'codex',
        selectedModelIds: ['gpt-5.6-luna'],
        selectedModelChecks: [{ providerId: 'codex', model: 'gpt-5.6-luna', effort: 'low' }],
        prepareProvisioning: (
          path,
          providerId,
          providerIds,
          modelIds,
          limitContext,
          modelVerificationMode,
          modelChecks
        ) =>
          facade.prepareForProvisioning(path, {
            providerId,
            providerIds,
            modelIds,
            limitContext,
            modelVerificationMode,
            modelChecks,
          }),
      });
      expect(result.status).toBe('ready');
      expect(spawnCli).toHaveBeenCalledOnce();
      const args = vi.mocked(spawnCli).mock.calls[0]![1]!;
      expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.6-luna');
      expect(args).not.toContain('gpt-5.6-sol');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
