import { describe, expect, it, vi } from 'vitest';

import {
  createDefaultTeamProvisioningPrepareCoordinatorPorts,
  createInMemoryProviderProbeCachePort,
  TeamProvisioningPrepareCoordinator,
} from '../TeamProvisioningPrepareCoordinator';
import { createProbeCacheKey } from '../TeamProvisioningProviderPreflight';

import type {
  CachedProbeResult,
  ProbeResult,
  ProviderProbeCachePort,
  TeamProvisioningPrepareCoordinatorPorts,
} from '../TeamProvisioningPrepareCoordinator';
import type { TeamCreateRequest } from '@shared/types';

function createCoordinator(
  overrides: Partial<TeamProvisioningPrepareCoordinatorPorts> = {}
): TeamProvisioningPrepareCoordinator {
  return new TeamProvisioningPrepareCoordinator(
    createDefaultTeamProvisioningPrepareCoordinatorPorts({
      validatePrepareCwd: vi.fn().mockResolvedValue(undefined),
      resolveClaudeBinaryPath: vi.fn().mockResolvedValue('/fake/claude'),
      probeClaudeRuntime: vi.fn().mockResolvedValue({}),
      buildProvisioningEnv: vi.fn().mockResolvedValue({
        env: { PATH: '/bin' },
        authSource: 'none',
        geminiRuntimeAuth: null,
        providerArgs: [],
      }),
      ...overrides,
    })
  );
}

function createProviderProbeCacheFake(
  overrides: Partial<ProviderProbeCachePort> = {}
): ProviderProbeCachePort {
  return {
    get: vi.fn(() => null),
    set: vi.fn(),
    delete: vi.fn(),
    getOrCreateInFlight: vi.fn((_cacheKey: string, create: () => Promise<ProbeResult | null>) =>
      create()
    ),
    ...overrides,
  };
}

describe('TeamProvisioningPrepareCoordinator', () => {
  it('coalesces matching prepare requests and returns cloned results', async () => {
    let releaseProbe: ((value: { warning?: string }) => void) | null = null;
    const probeClaudeRuntime = vi.fn(
      () =>
        new Promise<{ warning?: string }>((resolve) => {
          releaseProbe = resolve;
        })
    );
    const coordinator = createCoordinator({
      probeClaudeRuntime,
      runProviderOneShotDiagnostic: vi.fn().mockResolvedValue({ warning: 'diagnostic note' }),
    });

    const first = coordinator.prepareForProvisioning('/workspace/coalesced-prepare', {
      providerId: 'anthropic',
      modelVerificationMode: 'deep',
    });
    const second = coordinator.prepareForProvisioning('/workspace/coalesced-prepare', {
      providerId: 'anthropic',
      modelVerificationMode: 'deep',
    });

    await vi.waitFor(() => expect(releaseProbe).not.toBeNull());
    const release = releaseProbe as ((value: { warning?: string }) => void) | null;
    if (!release) {
      throw new Error('Expected probe release callback to be registered.');
    }
    release({});
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(probeClaudeRuntime).toHaveBeenCalledOnce();
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).not.toBe(secondResult);

    firstResult.warnings?.push('mutated');
    expect(secondResult.warnings).toEqual(['diagnostic note']);
  });

  it('clears one probe cache entry per requested provider when forceFresh is set', async () => {
    const cachedResult = (cacheKey: string): CachedProbeResult => ({
      cacheKey,
      claudePath: '/fake/claude',
      authSource: 'none',
      cachedAtMs: 1,
    });
    const deleteProbeCache = vi.fn();
    const providerProbeCache = createProviderProbeCacheFake({
      delete: deleteProbeCache,
      get: vi.fn((cacheKey: string) => cachedResult(cacheKey)),
    });
    const coordinator = createCoordinator({ providerProbeCache });

    await coordinator.prepareForProvisioning('/workspace/force-fresh-prepare', {
      forceFresh: true,
      providerIds: ['anthropic', 'codex', 'codex'],
    });

    expect(deleteProbeCache).toHaveBeenCalledWith(
      createProbeCacheKey('/workspace/force-fresh-prepare', 'anthropic')
    );
    expect(deleteProbeCache).toHaveBeenCalledWith(
      createProbeCacheKey('/workspace/force-fresh-prepare', 'codex')
    );
    expect(deleteProbeCache.mock.calls).toEqual([
      [createProbeCacheKey('/workspace/force-fresh-prepare', 'anthropic')],
      [createProbeCacheKey('/workspace/force-fresh-prepare', 'codex')],
    ]);
  });

  it('uses the injected probe cache port for prepare cache hits', async () => {
    const cwd = '/workspace/prepare-cache-hit';
    const cacheKey = createProbeCacheKey(cwd, 'codex');
    const getProbeCache = vi.fn((requestedKey: string): CachedProbeResult | null => {
      if (requestedKey !== cacheKey) {
        return null;
      }
      return {
        cacheKey,
        claudePath: '/fake/claude',
        authSource: 'codex_runtime',
        cachedAtMs: 1,
      };
    });
    const providerProbeCache = createProviderProbeCacheFake({ get: getProbeCache });
    const probeClaudeRuntime = vi.fn().mockResolvedValue({});
    const coordinator = createCoordinator({
      providerProbeCache,
      probeClaudeRuntime,
    });

    await coordinator.prepareForProvisioning(cwd, { providerId: 'codex' });

    expect(getProbeCache).toHaveBeenCalledWith(cacheKey);
    expect(probeClaudeRuntime).not.toHaveBeenCalled();
  });

  it('materializes non-Anthropic teammate defaults once per provider through ports', async () => {
    const resolveProviderDefaultModel = vi.fn().mockResolvedValue(' codex-default ');
    const buildProvisioningEnv = vi.fn();
    const coordinator = createCoordinator({
      buildProvisioningEnv,
      resolveProviderDefaultModel,
    });

    const members: TeamCreateRequest['members'] = [
      { name: 'one', role: 'One', providerId: 'codex' },
      { name: 'two', role: 'Two', providerId: 'codex' },
      { name: 'three', role: 'Three', providerId: 'anthropic' },
    ];

    const result = await coordinator.materializeEffectiveTeamMemberSpecs({
      claudePath: '/fake/claude',
      cwd: '/workspace/materialize',
      members,
      defaults: {},
      primaryProviderId: 'codex',
      primaryEnv: {
        env: { PATH: '/bin' },
        authSource: 'codex_runtime',
        geminiRuntimeAuth: null,
        providerArgs: ['--from-env'],
      },
      providerArgsResolver: ({ providerArgs }) => [...providerArgs, '--resolved'],
    });

    expect(buildProvisioningEnv).not.toHaveBeenCalled();
    expect(resolveProviderDefaultModel).toHaveBeenCalledOnce();
    expect(resolveProviderDefaultModel).toHaveBeenCalledWith(
      '/fake/claude',
      '/workspace/materialize',
      'codex',
      { PATH: '/bin' },
      ['--from-env', '--resolved'],
      false
    );
    expect(result.map((member) => member.model)).toEqual([
      'codex-default',
      'codex-default',
      undefined,
    ]);
  });

  it('resolves missing OpenCode worktree member paths through the worktree port', async () => {
    const ensureMemberWorktree = vi
      .fn()
      .mockResolvedValue({ worktreePath: '/workspace/member-worktree' });
    const coordinator = createCoordinator({ ensureMemberWorktree });

    const result = await coordinator.resolveOpenCodeMemberWorkspacesForRuntime({
      teamName: 'team',
      baseCwd: '/workspace/base',
      members: [{ name: 'dev', role: 'Developer', providerId: 'opencode', isolation: 'worktree' }],
    });

    expect(ensureMemberWorktree).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'dev',
      baseCwd: '/workspace/base',
    });
    expect(result[0]?.cwd).toBe('/workspace/member-worktree');
  });

  it('caches successful probes but does not pin auth failures', async () => {
    const cwd = `/workspace/probe-cache-${Date.now()}`;
    const probeClaudeRuntime = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ warning: 'Run `claude auth login` to continue' })
      .mockResolvedValueOnce({ warning: 'Run `claude auth login` to continue' });
    const coordinator = createCoordinator({
      resolveClaudeBinaryPath: vi.fn().mockResolvedValue('/fake/claude'),
      probeClaudeRuntime,
    });

    coordinator.clearProbeCache(cwd, 'anthropic');
    await coordinator.getCachedOrProbeResult(cwd, 'anthropic');
    await coordinator.getCachedOrProbeResult(cwd, 'anthropic');

    expect(probeClaudeRuntime).toHaveBeenCalledOnce();

    coordinator.clearProbeCache(cwd, 'anthropic');
    await coordinator.getCachedOrProbeResult(cwd, 'anthropic');
    await coordinator.getCachedOrProbeResult(cwd, 'anthropic');

    expect(probeClaudeRuntime).toHaveBeenCalledTimes(3);
  });

  it('keeps provider probe cache timestamps inside the cache port', () => {
    let now = 1_000;
    const cache = createInMemoryProviderProbeCachePort({ ttlMs: 10, now: () => now });

    cache.set('probe-key', {
      claudePath: '/fake/claude',
      authSource: 'none',
    });

    expect(cache.get('probe-key')).toMatchObject({ cachedAtMs: 1_000 });
    now = 1_009;
    expect(cache.get('probe-key')).not.toBeNull();
    now = 1_010;
    expect(cache.get('probe-key')).toBeNull();
  });

  it('isolates default provider probe caches per coordinator instance', async () => {
    const cwd = '/workspace/probe-cache-isolated';
    const probeClaudeRuntime = vi.fn().mockResolvedValue({});
    const buildProvisioningEnv = vi.fn().mockResolvedValue({
      env: { PATH: '/bin' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--codex'],
    });
    const overrides = {
      resolveClaudeBinaryPath: vi.fn().mockResolvedValue('/fake/claude'),
      buildProvisioningEnv,
      probeClaudeRuntime,
    };

    const first = createCoordinator(overrides);
    const second = createCoordinator(overrides);

    await first.getCachedOrProbeResult(cwd, 'codex');
    await first.getCachedOrProbeResult(cwd, 'codex');
    await second.getCachedOrProbeResult(cwd, 'codex');
    await second.getCachedOrProbeResult(cwd, 'codex');

    expect(buildProvisioningEnv).toHaveBeenCalledTimes(2);
    expect(probeClaudeRuntime).toHaveBeenCalledTimes(2);
  });

  it('dedupes in-flight provider probes within a coordinator cache', async () => {
    const cwd = '/workspace/probe-cache-in-flight';
    let releaseProbe: ((value: { warning?: string }) => void) | null = null;
    const probeClaudeRuntime = vi.fn(
      () =>
        new Promise<{ warning?: string }>((resolve) => {
          releaseProbe = resolve;
        })
    );
    const buildProvisioningEnv = vi.fn().mockResolvedValue({
      env: { PATH: '/bin' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--codex'],
    });
    const coordinator = createCoordinator({
      resolveClaudeBinaryPath: vi.fn().mockResolvedValue('/fake/claude'),
      buildProvisioningEnv,
      probeClaudeRuntime,
    });

    const first = coordinator.getCachedOrProbeResult(cwd, 'codex');
    const second = coordinator.getCachedOrProbeResult(cwd, 'codex');

    await vi.waitFor(() => expect(releaseProbe).not.toBeNull());
    expect(buildProvisioningEnv).toHaveBeenCalledOnce();
    expect(probeClaudeRuntime).toHaveBeenCalledOnce();

    const release = releaseProbe as ((value: { warning?: string }) => void) | null;
    if (!release) {
      throw new Error('Expected provider probe release callback to be registered.');
    }
    release({});

    await expect(Promise.all([first, second])).resolves.toEqual([
      { claudePath: '/fake/claude', authSource: 'codex_runtime' },
      { claudePath: '/fake/claude', authSource: 'codex_runtime' },
    ]);
    expect(probeClaudeRuntime).toHaveBeenCalledOnce();
  });
});
