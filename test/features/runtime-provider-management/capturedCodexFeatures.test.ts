// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { createCapturedRuntimeProviderStatusClient } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient';
import { createCapturedCodexFeatures } from '../../../src/features/runtime-provider-management/main/adapters/output/createCapturedCodexFeatures';

import type { CapturedProviderManagement } from '../../../src/features/agent-backend/main';

function fixture(suffix = '') {
  let current = true;
  const value = {
    profileId: `TEST-codex${suffix}`,
    configRevision: `TEST-config${suffix}`,
    account: null,
    requiresOpenaiAuth: true,
    configuration: {
      model: `TEST-model${suffix}`,
      modelProvider: 'TEST-local',
      reasoningEffort: 'high',
    },
    models: [
      {
        id: `TEST-model${suffix}`,
        model: `TEST-model${suffix}`,
        displayName: 'TEST model',
        description: '',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high', 'future'],
        defaultReasoningEffort: 'high',
        inputModalities: ['text'],
        supportsPersonality: false,
      },
    ],
  };
  const request = vi.fn(async () => ({ ok: true, value }));
  const target: CapturedProviderManagement = {
    targetId: (suffix === 'B' ? 'b' : 'a').repeat(64),
    profileId: `TEST-codex${suffix}`,
    configRevision: `TEST-config${suffix}`,
    isCurrent: () => current,
    request,
  };
  const capture = vi.fn(async () => target);
  return {
    ...createCapturedCodexFeatures(capture, undefined, () => 'chatgpt'),
    value,
    target,
    request,
    capture,
    stale: () => {
      current = false;
    },
  };
}

it('reads captured account/catalog, strips no policy into auth/launch, and refuses unsupported mutations before I/O', async () => {
  const f = fixture();
  const snapshot = await f.accountFeature.getSnapshot();
  expect(Object.hasOwn(snapshot, 'runtimeContext')).toBe(false);
  expect(snapshot).toMatchObject({
    managedAccount: null,
    preferredAuthMode: 'chatgpt',
    effectiveAuthMode: null,
    launchAllowed: false,
    appServerState: 'healthy',
  });
  expect(await f.modelCatalogFeature.getCatalog()).toMatchObject({
    source: 'app-server',
    defaultModelId: 'TEST-model',
    models: [{ id: 'TEST-model', supportedReasoningEfforts: ['medium', 'high'] }],
  });
  expect(f.request.mock.calls).toEqual([
    ['codex.metadata', { includeModels: false }],
    ['codex.metadata', { includeModels: true }],
  ]);
  const calls = f.request.mock.calls.length;
  await expect(f.accountFeature.refreshSnapshot({ forceRefreshToken: true })).rejects.toThrow(
    'not integrated'
  );
  await expect(f.accountFeature.logout()).rejects.toThrow('not integrated');
  await expect(f.modelCatalogFeature.getCatalog({ profile: 'foreign' })).rejects.toThrow(
    'captured Codex profile'
  );
  expect(f.request).toHaveBeenCalledTimes(calls);

  const a = fixture('A'),
    b = fixture('B');
  Object.assign(a.value, { account: { type: 'chatgpt', email: 'TEST-A', planType: 'plus' } });
  Object.assign(b.value, { account: { type: 'chatgpt', email: 'TEST-B', planType: 'plus' } });
  let release: () => void = () => {
    throw new Error('TEST pending original read missing');
  };
  let entered: () => void = () => {
    throw new Error('TEST pending original request missing');
  };
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  a.request.mockImplementation(async () => {
    entered();
    await barrier;
    return { ok: true, value: a.value };
  });
  let current = a.target;
  const selected = createCapturedCodexFeatures(
    async () => current,
    undefined,
    () => 'chatgpt'
  );
  const originalRead = selected.accountFeature.getSnapshot();
  try {
    await reading;
    current = b.target;
    const fresh = await selected.modelCatalogFeature.getCatalog();
    release();
    const retained = await originalRead;
    expect(retained.managedAccount?.email).toBe('TEST-A');
    expect(fresh.models[0]?.id).toBe('TEST-modelB');
    expect(a.request).toHaveBeenCalledExactlyOnceWith('codex.metadata', { includeModels: false });
    expect(b.request).toHaveBeenCalledExactlyOnceWith('codex.metadata', { includeModels: true });
    expect(selected.accountFeature.getCachedSnapshot()).toBeNull();
    expect(JSON.stringify({ retained, fresh })).not.toMatch(
      /targetId|configRevision|nativeExecutableDigest|TEST-codex/
    );
  } finally {
    release();
    await originalRead.catch(() => undefined);
    await selected.accountFeature.dispose();
    await selected.modelCatalogFeature.dispose();
  }
});

it('cannot publish foreign, stale or secret-bearing metadata or retained global snapshots', async () => {
  const nullable = fixture();
  Object.assign(nullable.value, {
    account: { type: 'chatgpt', email: null, planType: 'plus' },
  });
  expect(await nullable.accountFeature.getSnapshot()).toMatchObject({
    managedAccount: { type: 'chatgpt', email: null, planType: 'plus' },
    effectiveAuthMode: 'chatgpt',
    appServerState: 'healthy',
  });
  for (const account of [
    { type: 'chatgpt', planType: 'plus' },
    ...[42, [], {}, '', 'TEST\0email', 'x'.repeat(1025)].map((email) => ({
      type: 'chatgpt',
      email,
      planType: 'plus',
    })),
    { type: 'chatgpt', email: null, planType: 'plus', accessToken: 'TEST-secret' },
  ]) {
    const malformed = fixture();
    Object.assign(malformed.value, { account });
    const published = vi.fn();
    const unsubscribe = malformed.accountFeature.subscribe(published);
    await expect(malformed.accountFeature.getSnapshot()).rejects.toThrow('unavailable');
    expect(published).not.toHaveBeenCalled();
    unsubscribe();
  }
  const f = fixture();
  f.value.configRevision = 'foreign';
  await expect(f.accountFeature.getSnapshot()).rejects.toThrow('unavailable');
  f.value.configRevision = 'TEST-config';
  Object.assign(f.value, { accessToken: 'TEST-secret' });
  await expect(f.accountFeature.getSnapshot()).rejects.toThrow('unavailable');
  Reflect.deleteProperty(f.value, 'accessToken');
  f.stale();
  await expect(f.modelCatalogFeature.getCatalog()).rejects.toThrow('unavailable');
  expect(f.accountFeature.getCachedSnapshot()).toBeNull();
});

it('Codex status uses its explicit captured runtime and cannot fall through to another catalog or grant launch', async () => {
  const f = fixture();
  const otherRuntime = vi.fn(async () => {
    throw new Error('wrong runtime');
  });
  const status = createCapturedRuntimeProviderStatusClient({
    capture: otherRuntime,
    captureCodex: f.capture,
    readHealth: async () => ({ buildId: 'TEST-host' }),
  });
  expect(await status.getProviderStatus('codex')).toMatchObject({
    providerId: 'codex',
    supported: true,
    authenticated: false,
    canLoginFromUi: true,
    statusCheckOutcome: 'model_only',
    capabilities: { teamLaunch: false, oneShot: false },
    modelCatalog: { defaultModelId: 'TEST-model' },
    catalogScope: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(otherRuntime).not.toHaveBeenCalled();
});

it('automatic quota refresh remains a captured read and does not silently force token refresh', async () => {
  const f = fixture();
  Object.assign(f.value, {
    rateLimits: {
      state: 'ready',
      snapshot: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null },
        secondary: null,
        credits: null,
        planType: 'plus',
      },
    },
  });
  expect(await f.accountFeature.refreshSnapshot({ includeRateLimits: true })).toMatchObject({
    rateLimits: { primary: { usedPercent: 0 }, planType: 'plus' },
  });
  expect(f.request).toHaveBeenCalledWith('codex.metadata', {
    includeModels: false,
    includeRateLimits: true,
  });
});
