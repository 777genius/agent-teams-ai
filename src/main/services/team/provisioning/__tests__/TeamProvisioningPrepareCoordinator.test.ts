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
  ProviderProbePublication,
  TeamProvisioningPrepareCoordinatorPorts,
} from '../TeamProvisioningPrepareCoordinator';
import type { TeamCreateRequest, TeamProvisioningPrepareResult } from '@shared/types';

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

  it('deeply isolates future prepare result fields between coalesced callers', async () => {
    type FuturePrepareResult = TeamProvisioningPrepareResult & {
      runtimeFacts: { models: { id: string }[] };
    };
    const sharedResult: FuturePrepareResult = {
      ready: true,
      message: 'ready',
      runtimeFacts: { models: [{ id: 'original' }] },
    };
    const coordinator = createCoordinator();
    vi.spyOn(coordinator, 'prepareForProvisioningOnce').mockResolvedValue(sharedResult);

    const first = coordinator.prepareForProvisioning('/workspace/future-prepare-fields');
    const second = coordinator.prepareForProvisioning('/workspace/future-prepare-fields');
    const [firstResult, secondResult] = (await Promise.all([first, second])) as [
      FuturePrepareResult,
      FuturePrepareResult,
    ];

    firstResult.runtimeFacts.models[0].id = 'mutated';

    expect(secondResult.runtimeFacts.models).toEqual([{ id: 'original' }]);
    expect(sharedResult.runtimeFacts.models).toEqual([{ id: 'original' }]);
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

  it('coalesces set-like model checks without changing the first request order', async () => {
    let releaseVerification:
      | ((result: { details: string[]; warnings: string[]; blockingMessages: string[] }) => void)
      | null = null;
    const verifySelectedProviderModels = vi.fn(
      () =>
        new Promise<{
          details: string[];
          warnings: string[];
          blockingMessages: string[];
        }>((resolve) => {
          releaseVerification = resolve;
        })
    );
    const coordinator = createCoordinator({ verifySelectedProviderModels });

    const first = coordinator.prepareForProvisioning('/workspace/canonical-model-checks', {
      providerId: 'codex',
      modelChecks: [
        { providerId: 'codex', model: 'zed' },
        { providerId: 'codex', model: 'alpha' },
      ],
    });
    const second = coordinator.prepareForProvisioning('/workspace/canonical-model-checks', {
      providerId: 'codex',
      modelChecks: [
        { providerId: 'codex', model: 'alpha' },
        { providerId: 'codex', model: 'zed' },
      ],
    });

    await vi.waitFor(() => expect(verifySelectedProviderModels).toHaveBeenCalledOnce());
    expect(verifySelectedProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        modelIds: ['zed', 'alpha'],
        modelChecks: [{ modelId: 'zed' }, { modelId: 'alpha' }],
      })
    );

    const release = releaseVerification as
      | ((result: { details: string[]; warnings: string[]; blockingMessages: string[] }) => void)
      | null;
    if (!release) {
      throw new Error('Expected model verification release callback to be registered.');
    }
    release({ details: [], warnings: [], blockingMessages: [] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ready: true }),
      expect.objectContaining({ ready: true }),
    ]);
    expect(verifySelectedProviderModels).toHaveBeenCalledOnce();
  });

  it('clears one probe cache entry per requested provider when forceFresh is set', async () => {
    const cachedResult = (cacheKey: string): CachedProbeResult => ({
      cacheKey,
      cachedAtMs: 1,
      result: {
        claudePath: '/fake/claude',
        authSource: 'none',
      },
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
        cachedAtMs: 1,
        result: {
          claudePath: '/fake/claude',
          authSource: 'codex_runtime',
        },
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

  it('preserves and deeply isolates future cached fields through coordinator cache hits', async () => {
    type FutureProbeResult = ProbeResult & {
      runtimeFacts: { models: { id: string }[] };
    };
    const cwd = '/workspace/prepare-cache-hit-future-fields';
    const cacheKey = createProbeCacheKey(cwd, 'codex');
    const cached: CachedProbeResult & { result: FutureProbeResult } = {
      cacheKey,
      cachedAtMs: 1,
      result: {
        claudePath: '/fake/claude',
        authSource: 'codex_runtime',
        runtimeFacts: { models: [{ id: 'original' }] },
      },
    };
    const providerProbeCache = createProviderProbeCacheFake({
      get: vi.fn(() => cached),
    });
    const coordinator = createCoordinator({ providerProbeCache });

    const first = (await coordinator.getCachedOrProbeResult(cwd, 'codex')) as FutureProbeResult;
    first.runtimeFacts.models[0].id = 'mutated';
    const second = (await coordinator.getCachedOrProbeResult(cwd, 'codex')) as FutureProbeResult;

    expect(second).toEqual({
      claudePath: '/fake/claude',
      authSource: 'codex_runtime',
      runtimeFacts: { models: [{ id: 'original' }] },
    });
    expect(cached.result.runtimeFacts.models).toEqual([{ id: 'original' }]);
    expect(providerProbeCache.getOrCreate).not.toHaveBeenCalled();
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
    cached.result.claudePath = '/mutated';
    cached.cachedAtMs = 0;
    expect(cache.get('probe-key')).toMatchObject({
      cachedAtMs: 1_000,
      result: { claudePath: '/fake/claude' },
    });
    now = 1_009;
    expect(cache.get('probe-key')).not.toBeNull();
    now = 1_010;
    expect(cache.get('probe-key')).toBeNull();
  });

  it('deeply isolates future fields from probe publishers, coalesced callers, and cache hits', async () => {
    type FutureProbeResult = ProbeResult & {
      cacheKey: { source: string };
      cachedAtMs: { source: string };
      runtimeFacts: { models: { id: string }[] };
    };
    const cache = createInMemoryProviderProbeCachePort();
    const publication = deferredPublication();
    const publishedResult: FutureProbeResult = {
      claudePath: '/fake/claude',
      authSource: 'none',
      cacheKey: { source: 'probe-result' },
      cachedAtMs: { source: 'probe-result' },
      runtimeFacts: { models: [{ id: 'original' }] },
    };
    const create = vi.fn(() => publication.promise);
    const firstCall = cache.getOrCreate('probe-key', create);
    const secondCall = cache.getOrCreate('probe-key', create);

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    publication.resolve({ result: publishedResult, cacheable: true });
    const [first, second] = (await Promise.all([firstCall, secondCall])) as [
      FutureProbeResult,
      FutureProbeResult,
    ];

    first.runtimeFacts.models[0].id = 'first-mutated';
    publishedResult.runtimeFacts.models[0].id = 'publisher-mutated';
    const cacheHit = (await cache.getOrCreate('probe-key', async () => {
      throw new Error('Expected the cached probe result.');
    })) as FutureProbeResult;

    expect(second.runtimeFacts.models).toEqual([{ id: 'original' }]);
    expect(cacheHit.cacheKey).toEqual({ source: 'probe-result' });
    expect(cacheHit.cachedAtMs).toEqual({ source: 'probe-result' });
    expect(cacheHit.runtimeFacts.models).toEqual([{ id: 'original' }]);
    cacheHit.runtimeFacts.models[0].id = 'cache-hit-mutated';
    expect(cache.get('probe-key')).toMatchObject({
      result: { runtimeFacts: { models: [{ id: 'original' }] } },
    });
  });

  it('isolates shared buffer memory while preserving future-field view relationships', async () => {
    type FutureProbeResult = ProbeResult & {
      runtimeFacts: {
        memory: SharedArrayBuffer;
        bytes: Uint8Array;
        tail: DataView;
      };
    };
    const cache = createInMemoryProviderProbeCachePort();
    const memory = new SharedArrayBuffer(4);
    const publishedBytes = new Uint8Array(memory);
    publishedBytes.set([1, 2, 3, 4]);
    const publishedResult: FutureProbeResult = {
      claudePath: '/fake/claude',
      authSource: 'none',
      runtimeFacts: {
        memory,
        bytes: publishedBytes,
        tail: new DataView(memory, 2, 2),
      },
    };
    const publication = deferredPublication();
    const create = vi.fn(() => publication.promise);
    const firstCall = cache.getOrCreate('probe-key', create);
    const secondCall = cache.getOrCreate('probe-key', create);

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    publication.resolve({ result: publishedResult, cacheable: true });
    const [first, second] = (await Promise.all([firstCall, secondCall])) as [
      FutureProbeResult,
      FutureProbeResult,
    ];

    expect(first.runtimeFacts.bytes.buffer).toBe(first.runtimeFacts.memory);
    expect(first.runtimeFacts.tail.buffer).toBe(first.runtimeFacts.memory);
    expect([...first.runtimeFacts.bytes]).toEqual([1, 2, 3, 4]);

    publishedBytes[0] = 90;
    first.runtimeFacts.bytes[1] = 91;
    expect([...second.runtimeFacts.bytes]).toEqual([1, 2, 3, 4]);

    const cacheHit = (await cache.getOrCreate('probe-key', async () => {
      throw new Error('Expected the cached probe result.');
    })) as FutureProbeResult;
    expect(cacheHit.runtimeFacts.bytes.buffer).toBe(cacheHit.runtimeFacts.memory);
    expect(cacheHit.runtimeFacts.tail.buffer).toBe(cacheHit.runtimeFacts.memory);
    expect([...cacheHit.runtimeFacts.bytes]).toEqual([1, 2, 3, 4]);

    cacheHit.runtimeFacts.tail.setUint8(0, 92);
    const laterCacheHit = (await cache.getOrCreate('probe-key', async () => {
      throw new Error('Expected the cached probe result.');
    })) as FutureProbeResult;
    expect([...laterCacheHit.runtimeFacts.bytes]).toEqual([1, 2, 3, 4]);
    expect([...publishedBytes]).toEqual([90, 2, 3, 4]);
  });

  it('preserves complex structured-clone topology while isolating shared memory', async () => {
    interface RuntimeFacts {
      memory: SharedArrayBuffer;
      aliasA: { id: string };
      aliasB: { id: string };
      views: {
        bytes: Uint8Array;
        ints: Int16Array;
        floats: Float32Array;
        bigInts: BigUint64Array;
        data: DataView;
      };
      map: Map<unknown, unknown>;
      set: Set<unknown>;
      error: Error;
      date: Date;
      regexp: RegExp;
      self?: RuntimeFacts;
    }
    type FutureProbeResult = ProbeResult & { runtimeFacts: RuntimeFacts };

    const cache = createInMemoryProviderProbeCachePort();
    const memory = new SharedArrayBuffer(32);
    const publishedBytes = new Uint8Array(memory);
    publishedBytes.set(Array.from({ length: 32 }, (_, index) => index));
    const alias = { id: 'shared-alias' };
    const map = new Map<unknown, unknown>();
    const set = new Set<unknown>();
    const error = new Error('probe failed', {
      cause: { bytes: new Uint8Array(memory, 3, 4) },
    });
    const runtimeFacts: RuntimeFacts = {
      memory,
      aliasA: alias,
      aliasB: alias,
      views: {
        bytes: new Uint8Array(memory, 1, 6),
        ints: new Int16Array(memory, 2, 3),
        floats: new Float32Array(memory, 8, 2),
        bigInts: new BigUint64Array(memory, 16, 1),
        data: new DataView(memory, 24, 4),
      },
      map,
      set,
      error,
      date: new Date('2026-07-13T00:00:00.000Z'),
      regexp: /probe-cache/giu,
    };
    runtimeFacts.self = runtimeFacts;
    map.set(alias, memory);
    map.set(memory, alias);
    set.add(set);
    set.add(memory);

    let getterCalls = 0;
    const publishedResult: FutureProbeResult = {
      claudePath: '/fake/claude',
      authSource: 'none',
      runtimeFacts,
    };
    Object.defineProperty(publishedResult, 'throwingGetter', {
      enumerable: false,
      get() {
        getterCalls += 1;
        throw new Error('Getter must not be invoked while cloning.');
      },
    });

    const isolated = (await cache.getOrCreate('probe-key', async () => ({
      result: publishedResult,
      cacheable: true,
    }))) as FutureProbeResult;
    const isolatedFacts = isolated.runtimeFacts;
    const isolatedCause = isolatedFacts.error.cause as { bytes: Uint8Array };

    expect(getterCalls).toBe(0);
    expect(isolatedFacts.self).toBe(isolatedFacts);
    expect(isolatedFacts.aliasA).toBe(isolatedFacts.aliasB);
    expect(isolatedFacts.map.get(isolatedFacts.aliasA)).toBe(isolatedFacts.memory);
    expect(isolatedFacts.map.get(isolatedFacts.memory)).toBe(isolatedFacts.aliasA);
    expect(isolatedFacts.set.has(isolatedFacts.set)).toBe(true);
    expect(isolatedFacts.set.has(isolatedFacts.memory)).toBe(true);

    expect(isolatedFacts.views.bytes).toBeInstanceOf(Uint8Array);
    expect(isolatedFacts.views.ints).toBeInstanceOf(Int16Array);
    expect(isolatedFacts.views.floats).toBeInstanceOf(Float32Array);
    expect(isolatedFacts.views.bigInts).toBeInstanceOf(BigUint64Array);
    expect(isolatedFacts.views.data).toBeInstanceOf(DataView);
    for (const view of Object.values(isolatedFacts.views)) {
      expect(view.buffer).toBe(isolatedFacts.memory);
    }
    expect(isolatedFacts.views.bytes).toMatchObject({ byteOffset: 1, length: 6 });
    expect(isolatedFacts.views.ints).toMatchObject({ byteOffset: 2, length: 3 });
    expect(isolatedFacts.views.floats).toMatchObject({ byteOffset: 8, length: 2 });
    expect(isolatedFacts.views.bigInts).toMatchObject({ byteOffset: 16, length: 1 });
    expect(isolatedFacts.views.data).toMatchObject({ byteOffset: 24, byteLength: 4 });
    expect(isolatedCause.bytes.buffer).toBe(isolatedFacts.memory);
    expect(isolatedCause.bytes).toMatchObject({ byteOffset: 3, length: 4 });

    expect(isolatedFacts.error).toBeInstanceOf(Error);
    expect(isolatedFacts.error.message).toBe('probe failed');
    expect(isolatedFacts.date).toBeInstanceOf(Date);
    expect(isolatedFacts.date.toISOString()).toBe('2026-07-13T00:00:00.000Z');
    expect(isolatedFacts.regexp).toBeInstanceOf(RegExp);
    expect(isolatedFacts.regexp).toEqual(/probe-cache/giu);

    publishedBytes[1] = 200;
    expect(isolatedFacts.views.bytes[0]).toBe(1);
    isolatedFacts.views.bytes[1] = 201;
    const cacheHit = cache.get('probe-key') as CachedProbeResult & {
      result: FutureProbeResult;
    };
    expect(cacheHit.result.runtimeFacts.views.bytes[1]).toBe(2);
    expect(getterCalls).toBe(0);
  });

  it('does not pin a failed clone of a future probe result field', async () => {
    const cache = createInMemoryProviderProbeCachePort();
    const create = vi
      .fn<() => Promise<ProviderProbePublication>>()
      .mockResolvedValueOnce({
        result: {
          claudePath: '/uncloneable/claude',
          authSource: 'none',
          runtimeFacts: { format: () => 'future field' },
        },
        cacheable: true,
      })
      .mockResolvedValueOnce({
        result: { claudePath: '/retry/claude', authSource: 'none' },
        cacheable: true,
      });
    const first = cache.getOrCreate('probe-key', create);
    const second = cache.getOrCreate('probe-key', create);

    const failedAttempts = await Promise.allSettled([first, second]);

    expect(failedAttempts.map((attempt) => attempt.status)).toEqual(['rejected', 'rejected']);
    expect(create).toHaveBeenCalledOnce();
    await expect(cache.getOrCreate('probe-key', create)).resolves.toEqual({
      claudePath: '/retry/claude',
      authSource: 'none',
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(cache.get('probe-key')).toMatchObject({
      result: { claudePath: '/retry/claude', authSource: 'none' },
    });
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

  it('does not let a superseded caller repopulate an invalidated cache epoch', async () => {
    const cache = createInMemoryProviderProbeCachePort();
    const staleAttempt = deferredPublication();
    const staleCreate = vi.fn(() => staleAttempt.promise);
    const freshCreate = vi.fn().mockResolvedValue({
      result: { claudePath: '/fresh/claude', authSource: 'none' },
      cacheable: true,
    });
    const staleCaller = cache.getOrCreate('probe-key', staleCreate);

    await vi.waitFor(() => expect(staleCreate).toHaveBeenCalledOnce());
    cache.invalidate('probe-key');
    staleAttempt.resolve({
      result: { claudePath: '/stale/claude', authSource: 'none' },
      cacheable: true,
    });

    await expect(staleCaller).resolves.toEqual({
      claudePath: '/stale/claude',
      authSource: 'none',
    });
    await expect(cache.getOrCreate('probe-key', freshCreate)).resolves.toEqual({
      claudePath: '/fresh/claude',
      authSource: 'none',
    });
    expect(staleCreate).toHaveBeenCalledOnce();
    expect(freshCreate).toHaveBeenCalledOnce();
    expect(cache.get('probe-key')).toMatchObject({
      result: {
        claudePath: '/fresh/claude',
        authSource: 'none',
      },
    });
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
        result: {
          claudePath: '/after-ttl/claude',
          authSource: 'none',
        },
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
      result: {
        claudePath: '/fake/claude',
        authSource: 'codex_runtime',
      },
    });
    expect(coordinator.getFreshCachedProbeResult(cwd, 'codex')?.result.warning).toBeUndefined();
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
      result: {
        claudePath: '/fresh/claude',
        authSource: 'codex_runtime',
      },
    });
    expect(buildProvisioningEnv).toHaveBeenCalledTimes(2);
    expect(staleProbeRuntime).toHaveBeenCalledOnce();
    expect(freshProbeRuntime).toHaveBeenCalledOnce();
  });
});
