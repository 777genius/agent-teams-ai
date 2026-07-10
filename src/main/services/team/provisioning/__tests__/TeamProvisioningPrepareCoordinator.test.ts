import { describe, expect, it, vi } from 'vitest';

import {
  createDefaultTeamProvisioningPrepareCoordinatorPorts,
  createInMemoryProviderProbeCachePort,
  TeamProvisioningPrepareCoordinator,
} from '../TeamProvisioningPrepareCoordinator';
import { createProbeCacheKey } from '../TeamProvisioningProviderPreflight';

import type {
  CachedProbeResult,
  ProviderProbeCachePort,
  ProviderProbePublication,
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
    invalidate: vi.fn(),
    getOrCreate: vi.fn(
      async (_cacheKey: string, create: () => Promise<ProviderProbePublication>) =>
        (await create()).result
    ),
    ...overrides,
  };
}

function deferredProbe(): {
  promise: Promise<{ warning?: string }>;
  resolve(value: { warning?: string }): void;
  reject(error: Error): void;
} {
  let resolveProbe: ((value: { warning?: string }) => void) | null = null;
  let rejectProbe: ((error: Error) => void) | null = null;
  const promise = new Promise<{ warning?: string }>((resolve, reject) => {
    resolveProbe = resolve;
    rejectProbe = reject;
  });

  return {
    promise,
    resolve(value) {
      if (!resolveProbe) {
        throw new Error('Expected deferred probe resolve callback.');
      }
      resolveProbe(value);
    },
    reject(error) {
      if (!rejectProbe) {
        throw new Error('Expected deferred probe reject callback.');
      }
      rejectProbe(error);
    },
  };
}

function deferredPublication(): {
  promise: Promise<ProviderProbePublication>;
  resolve(value: ProviderProbePublication): void;
  reject(error: Error): void;
} {
  let resolvePublication: ((value: ProviderProbePublication) => void) | null = null;
  let rejectPublication: ((error: Error) => void) | null = null;
  const promise = new Promise<ProviderProbePublication>((resolve, reject) => {
    resolvePublication = resolve;
    rejectPublication = reject;
  });

  return {
    promise,
    resolve(value) {
      if (!resolvePublication) {
        throw new Error('Expected deferred publication resolve callback.');
      }
      resolvePublication(value);
    },
    reject(error) {
      if (!rejectPublication) {
        throw new Error('Expected deferred publication reject callback.');
      }
      rejectPublication(error);
    },
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

  it('normalizes prepare in-flight keys for set-like provider and model options', () => {
    const coordinator = createCoordinator();

    const firstKey = coordinator.createPrepareForProvisioningInFlightKey('/workspace/order-key', {
      providerId: 'codex',
      providerIds: ['anthropic', 'codex'],
      modelIds: [' zed ', 'alpha'],
      modelChecks: [
        { providerId: 'codex', model: 'gpt-5', effort: 'high' },
        { providerId: 'anthropic', model: 'claude-sonnet-4-5', effort: 'low' },
      ],
      limitContext: true,
      modelVerificationMode: 'deep',
    });
    const secondKey = coordinator.createPrepareForProvisioningInFlightKey('/workspace/order-key', {
      providerId: 'anthropic',
      providerIds: ['codex', 'anthropic'],
      modelIds: ['alpha', 'zed'],
      modelChecks: [
        { providerId: 'anthropic', model: 'claude-sonnet-4-5', effort: 'low' },
        { providerId: 'codex', model: 'gpt-5', effort: 'high' },
      ],
      limitContext: true,
      modelVerificationMode: 'deep',
    });

    expect(firstKey).toBe(secondKey);
    expect(coordinator.createPrepareForProvisioningInFlightKey('/workspace/order-key')).toBe(
      coordinator.createPrepareForProvisioningInFlightKey('/workspace/order-key', {
        providerId: 'anthropic',
      })
    );
  });

  it('clears one probe cache entry per requested provider when forceFresh is set', async () => {
    const cachedResult = (cacheKey: string): CachedProbeResult => ({
      cacheKey,
      claudePath: '/fake/claude',
      authSource: 'none',
      cachedAtMs: 1,
    });
    const invalidateProbeCache = vi.fn();
    const providerProbeCache = createProviderProbeCacheFake({
      invalidate: invalidateProbeCache,
      get: vi.fn((cacheKey: string) => cachedResult(cacheKey)),
    });
    const coordinator = createCoordinator({ providerProbeCache });

    await coordinator.prepareForProvisioning('/workspace/force-fresh-prepare', {
      forceFresh: true,
      providerIds: ['anthropic', 'codex', 'codex'],
    });

    expect(invalidateProbeCache).toHaveBeenCalledWith(
      createProbeCacheKey('/workspace/force-fresh-prepare', 'anthropic')
    );
    expect(invalidateProbeCache).toHaveBeenCalledWith(
      createProbeCacheKey('/workspace/force-fresh-prepare', 'codex')
    );
    expect(invalidateProbeCache.mock.calls).toEqual([
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

  it('keeps provider probe cache timestamps inside the cache port', async () => {
    let now = 1_000;
    const cache = createInMemoryProviderProbeCachePort({ ttlMs: 10, now: () => now });

    await cache.getOrCreate('probe-key', async () => ({
      result: {
        claudePath: '/fake/claude',
        authSource: 'none',
      },
      cacheable: true,
    }));

    expect(cache.get('probe-key')).toMatchObject({ cachedAtMs: 1_000 });
    const cached = cache.get('probe-key');
    if (!cached) {
      throw new Error('Expected cached probe result.');
    }
    cached.claudePath = '/mutated';
    cached.cachedAtMs = 0;
    expect(cache.get('probe-key')).toMatchObject({
      claudePath: '/fake/claude',
      cachedAtMs: 1_000,
    });
    now = 1_009;
    expect(cache.get('probe-key')).not.toBeNull();
    now = 1_010;
    expect(cache.get('probe-key')).toBeNull();
  });

  it('shares rejected probe attempts and permits a later retry', async () => {
    const cache = createInMemoryProviderProbeCachePort();
    const rejectedAttempt = deferredPublication();
    const create = vi
      .fn<() => Promise<ProviderProbePublication>>()
      .mockImplementationOnce(() => rejectedAttempt.promise)
      .mockResolvedValueOnce({
        result: { claudePath: '/retry/claude', authSource: 'none' },
        cacheable: true,
      });
    const first = cache.getOrCreate('probe-key', create);
    const second = cache.getOrCreate('probe-key', create);
    const sharedError = new Error('probe failed');

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    rejectedAttempt.reject(sharedError);

    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      { status: 'rejected', reason: sharedError },
      { status: 'rejected', reason: sharedError },
    ]);
    expect(create).toHaveBeenCalledOnce();
    await expect(cache.getOrCreate('probe-key', create)).resolves.toEqual({
      claudePath: '/retry/claude',
      authSource: 'none',
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('delivers the current epoch rejection to a superseded caller', async () => {
    const cache = createInMemoryProviderProbeCachePort();
    const staleAttempt = deferredPublication();
    const freshAttempt = deferredPublication();
    const staleCreate = vi.fn(() => staleAttempt.promise);
    const freshCreate = vi.fn(() => freshAttempt.promise);
    const staleCaller = cache.getOrCreate('probe-key', staleCreate);

    await vi.waitFor(() => expect(staleCreate).toHaveBeenCalledOnce());
    cache.invalidate('probe-key');

    const freshCaller = cache.getOrCreate('probe-key', freshCreate);
    await vi.waitFor(() => expect(freshCreate).toHaveBeenCalledOnce());
    const freshError = new Error('fresh probe failed');
    freshAttempt.reject(freshError);
    await expect(freshCaller).rejects.toBe(freshError);

    staleAttempt.resolve({
      result: { claudePath: '/stale/claude', authSource: 'none' },
      cacheable: true,
    });
    await expect(staleCaller).rejects.toBe(freshError);

    expect(staleCreate).toHaveBeenCalledOnce();
    expect(freshCreate).toHaveBeenCalledOnce();
    expect(cache.get('probe-key')).toBeNull();
  });

  it.each(['success', 'rejection'] as const)(
    'starts a fresh probe after TTL while a superseded %s remains pending',
    async (staleOutcome) => {
      let now = 1_000;
      const cache = createInMemoryProviderProbeCachePort({ ttlMs: 10, now: () => now });
      const staleAttempt = deferredPublication();
      const beforeTtlAttempt = deferredPublication();
      const afterTtlAttempt = deferredPublication();
      const staleCreate = vi.fn(() => staleAttempt.promise);
      const beforeTtlCreate = vi.fn(() => beforeTtlAttempt.promise);
      const afterTtlCreate = vi.fn(() => afterTtlAttempt.promise);
      const staleCaller = cache.getOrCreate('probe-key', staleCreate);

      await vi.waitFor(() => expect(staleCreate).toHaveBeenCalledOnce());
      cache.invalidate('probe-key');

      const beforeTtlCaller = cache.getOrCreate('probe-key', beforeTtlCreate);
      await vi.waitFor(() => expect(beforeTtlCreate).toHaveBeenCalledOnce());
      beforeTtlAttempt.resolve({
        result: { claudePath: '/before-ttl/claude', authSource: 'none' },
        cacheable: true,
      });
      await expect(beforeTtlCaller).resolves.toEqual({
        claudePath: '/before-ttl/claude',
        authSource: 'none',
      });

      now = 1_010;
      const afterTtlCaller = cache.getOrCreate('probe-key', afterTtlCreate);
      await vi.waitFor(() => expect(afterTtlCreate).toHaveBeenCalledOnce());
      afterTtlAttempt.resolve({
        result: { claudePath: '/after-ttl/claude', authSource: 'none' },
        cacheable: true,
      });
      await expect(afterTtlCaller).resolves.toEqual({
        claudePath: '/after-ttl/claude',
        authSource: 'none',
      });

      if (staleOutcome === 'success') {
        staleAttempt.resolve({
          result: { claudePath: '/stale/claude', authSource: 'none' },
          cacheable: true,
        });
      } else {
        staleAttempt.reject(new Error('stale probe failed'));
      }

      await expect(staleCaller).resolves.toEqual({
        claudePath: '/after-ttl/claude',
        authSource: 'none',
      });
      expect(cache.get('probe-key')).toMatchObject({
        claudePath: '/after-ttl/claude',
        authSource: 'none',
      });
      expect(staleCreate).toHaveBeenCalledOnce();
      expect(beforeTtlCreate).toHaveBeenCalledOnce();
      expect(afterTtlCreate).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  );

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

  it('makes a probe superseded by force-fresh return the current probe facts', async () => {
    const cwd = '/workspace/probe-cache-clear-race';
    const probeReleases: ((value: { warning?: string }) => void)[] = [];
    const probeClaudeRuntime = vi.fn(
      () =>
        new Promise<{ warning?: string }>((resolve) => {
          probeReleases.push(resolve);
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
    const releaseProbe = (index: number, value: { warning?: string }): void => {
      const release = probeReleases[index];
      if (!release) {
        throw new Error(`Expected provider probe release callback ${index}.`);
      }
      release(value);
    };

    const staleProbe = coordinator.getCachedOrProbeResult(cwd, 'codex');
    await vi.waitFor(() => expect(probeReleases).toHaveLength(1));

    const forceFreshPrepare = coordinator.prepareForProvisioning(cwd, {
      forceFresh: true,
      providerId: 'codex',
    });
    await vi.waitFor(() => expect(probeReleases).toHaveLength(2));

    releaseProbe(0, { warning: 'stale provider note' });
    releaseProbe(1, {});

    await expect(forceFreshPrepare).resolves.toMatchObject({ ready: true });
    await expect(staleProbe).resolves.toEqual({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
    });
    expect(coordinator.getFreshCachedProbeResult(cwd, 'codex')).toMatchObject({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
    });
    expect(coordinator.getFreshCachedProbeResult(cwd, 'codex')?.warning).toBeUndefined();
    expect(buildProvisioningEnv).toHaveBeenCalledTimes(2);
    expect(probeClaudeRuntime).toHaveBeenCalledTimes(2);
  });

  it('shares invalidation epochs across coordinators using one probe cache', async () => {
    const cwd = '/workspace/probe-cache-shared-epoch';
    const sharedCache = createInMemoryProviderProbeCachePort();
    const staleProbes: ReturnType<typeof deferredProbe>[] = [];
    const freshProbes: ReturnType<typeof deferredProbe>[] = [];
    const staleProbeRuntime = vi.fn(() => {
      const probe = deferredProbe();
      staleProbes.push(probe);
      return probe.promise;
    });
    const freshProbeRuntime = vi.fn(() => {
      const probe = deferredProbe();
      freshProbes.push(probe);
      return probe.promise;
    });
    const buildProvisioningEnv = vi.fn().mockResolvedValue({
      env: { PATH: '/bin' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--codex'],
    });
    const staleCoordinator = createCoordinator({
      providerProbeCache: sharedCache,
      resolveClaudeBinaryPath: vi.fn().mockResolvedValue('/stale/claude'),
      buildProvisioningEnv,
      probeClaudeRuntime: staleProbeRuntime,
    });
    const freshCoordinator = createCoordinator({
      providerProbeCache: sharedCache,
      resolveClaudeBinaryPath: vi.fn().mockResolvedValue('/fresh/claude'),
      buildProvisioningEnv,
      probeClaudeRuntime: freshProbeRuntime,
    });

    const staleCaller = staleCoordinator.getCachedOrProbeResult(cwd, 'codex');
    await vi.waitFor(() => expect(staleProbes).toHaveLength(1));

    freshCoordinator.clearProbeCache(cwd, 'codex');
    const freshCaller = freshCoordinator.getCachedOrProbeResult(cwd, 'codex');
    await vi.waitFor(() => expect(freshProbes).toHaveLength(1));

    freshProbes[0]?.resolve({});
    await expect(freshCaller).resolves.toEqual({
      claudePath: '/fresh/claude',
      authSource: 'codex_runtime',
    });

    staleProbes[0]?.resolve({ warning: 'stale provider note' });
    await expect(staleCaller).resolves.toEqual({
      claudePath: '/fresh/claude',
      authSource: 'codex_runtime',
    });

    expect(sharedCache.get(createProbeCacheKey(cwd, 'codex'))).toMatchObject({
      claudePath: '/fresh/claude',
      authSource: 'codex_runtime',
    });
    expect(buildProvisioningEnv).toHaveBeenCalledTimes(2);
    expect(staleProbeRuntime).toHaveBeenCalledOnce();
    expect(freshProbeRuntime).toHaveBeenCalledOnce();
  });
});
