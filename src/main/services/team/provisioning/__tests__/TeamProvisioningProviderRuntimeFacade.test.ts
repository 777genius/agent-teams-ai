import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningProviderRuntimeCompatibility,
  createTeamProvisioningProviderRuntimeFacade,
  type TeamProvisioningProviderRuntimeFacadeDeps,
} from '../TeamProvisioningProviderRuntimeFacade';

import type { TeamProvisioningEnvRuntimePorts } from '../TeamProvisioningEnvRuntimePorts';
import type { TeamProvisioningProbeChild } from '../TeamProvisioningProviderDiagnostics';
import type {
  TeamProvisioningProviderDiagnosticsRuntime,
  TeamProvisioningProviderDiagnosticsRuntimeInput,
} from '../TeamProvisioningProviderDiagnosticsPorts';
import type { TeamProviderId } from '@shared/types';

function createDiagnosticsRuntime(
  overrides: Partial<TeamProvisioningProviderDiagnosticsRuntime> = {}
): TeamProvisioningProviderDiagnosticsRuntime {
  return {
    getBasePorts: vi.fn(() => ({}) as never),
    getPorts: vi.fn(() => ({}) as never),
    probeClaudeRuntime: vi.fn(async () => ({ warning: 'probe warning' })),
    probeProviderRuntimeControlPlane: vi.fn(async () => ({ warning: 'control warning' })),
    runProviderOneShotDiagnostic: vi.fn(async () => ({ warning: 'diagnostic warning' })),
    validateAgentTeamsMcpRuntime: vi.fn(async () => undefined),
    spawnProbe: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
    ...overrides,
  };
}

function createDiagnosticsInput(): TeamProvisioningProviderDiagnosticsRuntimeInput {
  return {
    transientProbeProcesses: new Set<TeamProvisioningProbeChild>(),
    providerConnectionService: {
      getConfiguredCodexCustomProviderModel: vi.fn(() => null),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    isAuthFailureWarning: vi.fn(() => false),
    normalizeApiRetryErrorMessage: vi.fn((text: string) => text),
  };
}

function createEnvRuntimePorts(): TeamProvisioningEnvRuntimePorts {
  return {
    getProvisioningEnvBuilderPorts: vi.fn(() => ({}) as never),
    buildProvisioningEnv: vi.fn(async () => ({
      env: { PATH: '/bin' },
      authSource: 'none' as const,
      geminiRuntimeAuth: null,
    })),
    buildCrossProviderMemberArgs: vi.fn(async () => ({
      args: ['--provider', 'codex'],
      providerArgsByProvider: new Map<TeamProviderId, string[]>([
        ['codex', ['--provider', 'codex']],
      ]),
      envPatch: { CODEX_HOME: '/repo/codex-home' },
      usesAnthropicApiKeyHelper: false,
    })),
    resolveControlApiBaseUrl: vi.fn(async () => 'http://127.0.0.1:4567'),
  };
}

function createFacadeDeps(
  overrides: Partial<TeamProvisioningProviderRuntimeFacadeDeps> = {}
): TeamProvisioningProviderRuntimeFacadeDeps {
  return {
    diagnosticsRuntimeInput: createDiagnosticsInput(),
    envRuntimePorts: createEnvRuntimePorts(),
    ...overrides,
  };
}

describe('TeamProvisioningProviderRuntimeFacade', () => {
  it('creates a fresh diagnostics runtime for each diagnostics operation', async () => {
    const runtimes: TeamProvisioningProviderDiagnosticsRuntime[] = [];
    const diagnosticsRuntimeInput = createDiagnosticsInput();
    const createDiagnosticsRuntimeMock = vi.fn(
      (input: TeamProvisioningProviderDiagnosticsRuntimeInput) => {
        expect(input).toBe(diagnosticsRuntimeInput);
        const runtime = createDiagnosticsRuntime();
        runtimes.push(runtime);
        return runtime;
      }
    );
    const facade = createTeamProvisioningProviderRuntimeFacade(
      createFacadeDeps({
        diagnosticsRuntimeInput,
        createDiagnosticsRuntime: createDiagnosticsRuntimeMock,
      })
    );
    const env = { PATH: '/bin' };
    const options = { isCancelled: vi.fn(() => false) };

    await facade.probeClaudeRuntime('/bin/claude', '/repo', env);
    await facade.runProviderOneShotDiagnostic('/bin/claude', '/repo', env, 'codex', [
      '--provider',
      'codex',
    ]);
    await facade.validateAgentTeamsMcpRuntime(
      '/bin/claude',
      '/repo',
      env,
      '/repo/mcp.json',
      options
    );
    await facade.spawnProbe('/bin/claude', ['--version'], '/repo', env, 1000);

    expect(createDiagnosticsRuntimeMock).toHaveBeenCalledTimes(4);
    expect(runtimes).toHaveLength(4);
    expect(runtimes[0].probeClaudeRuntime).toHaveBeenCalledWith(
      '/bin/claude',
      '/repo',
      env,
      'anthropic',
      []
    );
    expect(runtimes[1].runProviderOneShotDiagnostic).toHaveBeenCalledWith(
      '/bin/claude',
      '/repo',
      env,
      'codex',
      ['--provider', 'codex']
    );
    expect(runtimes[2].validateAgentTeamsMcpRuntime).toHaveBeenCalledWith(
      '/bin/claude',
      '/repo',
      env,
      '/repo/mcp.json',
      options
    );
    expect(runtimes[3].spawnProbe).toHaveBeenCalledWith(
      '/bin/claude',
      ['--version'],
      '/repo',
      env,
      1000,
      undefined
    );
  });

  it('delegates env operations to runtime ports', async () => {
    const envRuntimePorts = createEnvRuntimePorts();
    const facade = createTeamProvisioningProviderRuntimeFacade(
      createFacadeDeps({ envRuntimePorts })
    );
    const teamRuntimeAuth = { teamName: 'Team', authMaterialId: 'auth-1' };

    await expect(
      facade.buildProvisioningEnv('codex', 'openai', { teamRuntimeAuth })
    ).resolves.toMatchObject({
      env: { PATH: '/bin' },
      authSource: 'none' as const,
    });
    await expect(
      facade.buildCrossProviderMemberArgs(
        'codex',
        [{ name: 'Claude', providerId: 'anthropic', role: 'reviewer' }],
        { teamRuntimeAuth }
      )
    ).resolves.toMatchObject({
      args: ['--provider', 'codex'],
      envPatch: { CODEX_HOME: '/repo/codex-home' },
    });
    await expect(facade.resolveControlApiBaseUrl()).resolves.toBe('http://127.0.0.1:4567');

    expect(envRuntimePorts.buildProvisioningEnv).toHaveBeenCalledWith('codex', 'openai', {
      teamRuntimeAuth,
    });
    expect(envRuntimePorts.buildCrossProviderMemberArgs).toHaveBeenCalledWith(
      'codex',
      [{ name: 'Claude', providerId: 'anthropic', role: 'reviewer' }],
      { teamRuntimeAuth }
    );
    expect(envRuntimePorts.resolveControlApiBaseUrl).toHaveBeenCalledOnce();
  });

  it('binds compatibility delegates for provisioning ports', async () => {
    const envRuntimePorts = createEnvRuntimePorts();
    const diagnosticsRuntime = createDiagnosticsRuntime();
    const facade = createTeamProvisioningProviderRuntimeFacade(
      createFacadeDeps({
        envRuntimePorts,
        createDiagnosticsRuntime: vi.fn(() => diagnosticsRuntime),
      })
    );
    const { buildProvisioningEnv, buildCrossProviderMemberArgs, validateAgentTeamsMcpRuntime } =
      createTeamProvisioningProviderRuntimeCompatibility(facade);
    const env = { PATH: '/bin' };

    await expect(buildProvisioningEnv('codex', 'openai')).resolves.toMatchObject({
      env: { PATH: '/bin' },
    });
    await expect(
      buildCrossProviderMemberArgs('codex', [
        { name: 'Claude', providerId: 'anthropic', role: 'reviewer' },
      ])
    ).resolves.toMatchObject({
      args: ['--provider', 'codex'],
    });
    await expect(
      validateAgentTeamsMcpRuntime('/bin/claude', '/repo', env, '/repo/mcp.json')
    ).resolves.toBeUndefined();

    expect(envRuntimePorts.buildProvisioningEnv).toHaveBeenCalledWith('codex', 'openai', undefined);
    expect(envRuntimePorts.buildCrossProviderMemberArgs).toHaveBeenCalledWith(
      'codex',
      [{ name: 'Claude', providerId: 'anthropic', role: 'reviewer' }],
      undefined
    );
    expect(diagnosticsRuntime.validateAgentTeamsMcpRuntime).toHaveBeenCalledWith(
      '/bin/claude',
      '/repo',
      env,
      '/repo/mcp.json',
      {}
    );
  });
});
