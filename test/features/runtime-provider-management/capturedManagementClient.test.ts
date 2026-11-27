// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { CapturedRuntimeSourceError } from '../../../src/features/agent-backend/main';
import { captureProviderManagement } from '../../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import { parseManagementCatalog } from '../../../src/features/runtime-provider-management/main/adapters/output/capturedManagementCatalog';
import * as managementPreferences from '../../../src/features/runtime-provider-management/main/adapters/output/capturedManagementPreferences';
import { createCapturedRuntimeProviderManagementClient } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient';
import { createRuntimeProviderManagementFeature } from '../../../src/features/runtime-provider-management/main/composition/createRuntimeProviderManagementFeature';
import * as logging from '../../../src/shared/utils/logger';
import { parseOpenCodeQualifiedModelRef } from '../../../src/shared/utils/opencodeModelRef';

import type {
  CapturedProviderManagement,
  ProviderManagementOperation,
} from '../../../src/features/agent-backend/main';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

const binding = { profileId: 'TEST-original', configRevision: 'TEST-v1' };
function fixture(
  declaredInputModalities?: JsonValue,
  generation: 'v1' | 'v2' = 'v1',
  configured = false
) {
  const calls: { operation: string; payload: Record<string, JsonValue> }[] = [];
  let connected = false;
  let fail = false;
  let barrier = Promise.resolve();
  const target: CapturedProviderManagement = {
    ...binding,
    targetId: 'a'.repeat(64),
    isCurrent: () => true,
    async request(
      operation: ProviderManagementOperation,
      payload: Record<string, JsonValue>
    ): Promise<JsonValue> {
      calls.push({ operation, payload });
      await barrier;
      if (operation === 'credential.pending') return { ok: true, value: { generation, receipt: null } };
      if (fail) throw new Error('TEST-api-key-raw-should-never-escape');
      if (operation === 'credential') {
        connected = payload.kind === 'credential.set';
        return {
          ok: true,
          value: {
            ...binding,
            commandId: payload.commandId!,
            providerId: payload.providerId!,
            kind: payload.kind!,
            phase: 'completed',
          },
        };
      }
      if (operation !== 'catalog') throw new Error('Unexpected operation');
      return {
        ok: true,
        value: {
          ...binding,
          runtime: generation === 'v2' ? { generation, version: '2.1.4' } : { generation },
          secretExtension: 'TEST-secret',
          providers: [
            {
              providerId: 'TEST-provider',
              displayName: 'TEST provider',
              source: 'api',
              connected,
              configured,
              defaultModelId: 'TEST-model',
              modelCount: 1,
              authMethods: ['api'],
              secretExtension: 'TEST-secret',
              models: payload.providerId
                ? [
                    {
                      modelId: 'TEST-model',
                      displayName: 'TEST model',
                      contextTokens: 8192,
                      outputTokens: 1024,
                      free: true,
                      ...(declaredInputModalities === undefined ? {} : { declaredInputModalities }),
                    },
                  ]
                : [],
            },
          ],
        },
      };
    },
  };
  const capture = vi.fn(async (_path: string | null) => target);
  return {
    target,
    capture,
    calls,
    port: createCapturedRuntimeProviderManagementClient({ capture }),
    setBarrier: (value: Promise<void>) => {
      barrier = value;
    },
    fail: () => {
      fail = true;
    },
  };
}

it('source capture and native catalog failures keep scoped configuration guidance without raw contents', async () => {
  const f = fixture(undefined, 'v2');
  f.capture.mockRejectedValueOnce(new CapturedRuntimeSourceError('configuration-invalid'));
  expect((await f.port.loadView({ runtimeId: 'opencode' })).error).toMatchObject({
    code: 'runtime-misconfigured',
    recoverable: true,
    message:
      'OpenCode configuration could not be applied. Check the selected provider and model settings, then refresh.',
  });
  f.target.request = async () => ({
    ok: false,
    code: 'held',
    reason: 'configuration-changed',
    raw: 'TEST-private-config-or-token-must-not-escape',
  });
  const result = await f.port.loadModels({ runtimeId: 'opencode', providerId: 'TEST-provider' });
  expect(result.error).toMatchObject({
    code: 'runtime-misconfigured',
    recoverable: true,
    message:
      'OpenCode configuration changed during this action. Refresh provider settings and try again.',
  });
  expect(JSON.stringify(result)).not.toContain('TEST-private-config-or-token-must-not-escape');
});

it('maps native catalogs/models without private metadata or invented model execution/default proof', async () => {
  const f = fixture();
  const view = await f.port.loadView({ runtimeId: 'opencode' });
  expect(view.view?.defaultModel).toBeNull();
  const result = await f.port.loadModels({ runtimeId: 'opencode', providerId: 'TEST-provider' });
  expect(result.models?.models).toEqual([
    expect.objectContaining({
      modelId: 'TEST-provider/TEST-model',
      availability: 'untested',
      default: false,
      free: true,
      proofState: 'needs_probe',
      requiresExecutionProof: true,
    }),
  ]);
  const text = JSON.stringify([view, result]);
  for (const secret of ['TEST-secret', 'TEST-original', 'TEST-v1', 'targetId'])
    expect(text).not.toContain(secret);
  expect(f.capture).toHaveBeenCalledWith(null);
  expect(view.view?.providers[0]?.actions.some((action) => action.id === 'test')).toBe(false);

  const configured = fixture(undefined, 'v2', true);
  const configuredView = await configured.port.loadView({ runtimeId: 'opencode' });
  expect(configuredView.view?.providers[0]).toMatchObject({
    state: 'not-connected',
    modelCount: 1,
    actions: [
      { id: 'connect', enabled: true, ownershipScope: 'runtime' },
      { id: 'test', enabled: true, requiresSecret: false, ownershipScope: 'runtime' },
    ],
  });
  const configuredModels = await configured.port.loadModels({
    runtimeId: 'opencode', providerId: 'TEST-provider',
  });
  expect(configuredModels.models?.models[0]).toMatchObject({
    availability: 'untested',
    default: false,
    proofState: 'needs_probe',
    requiresExecutionProof: true,
  });
  for (const secret of ['TEST-secret', 'TEST-original', 'TEST-v1', 'targetId'])
    expect(JSON.stringify([configuredView, configuredModels])).not.toContain(secret);
});

it.each(['v1', 'v2'] as const)(
  '%s keeps native model identities distinct when they contain the provider prefix',
  async (generation) => {
    const f = fixture(undefined, generation);
    const nativeModels = ['auto', 'openrouter/auto', 'anthropic/claude'];
    const nativeRequest = f.target.request.bind(f.target);
    f.target.request = async (operation, payload) => {
      const reply = await nativeRequest(operation, payload);
      if (operation === 'catalog') {
        const result = reply as {
          ok: boolean;
          value: {
            providers: {
              providerId: string;
              defaultModelId: string;
              modelCount: number;
              models: JsonValue[];
            }[];
          };
        };
        const provider = result.value.providers[0]!;
        provider.providerId = 'openrouter';
        provider.defaultModelId = 'openrouter/auto';
        provider.modelCount = nativeModels.length;
        provider.models = nativeModels.map((modelId) => ({
          modelId,
          displayName: modelId,
          contextTokens: 8192,
          outputTokens: 1024,
          free: false,
        }));
      }
      return reply;
    };

    const result = await f.port.loadModels({ runtimeId: 'opencode', providerId: 'openrouter' });
    expect(result.error).toBeUndefined();
    const rows = result.models!.models;
    expect(rows.map((model) => model.modelId)).toEqual([
      'openrouter/auto',
      'openrouter/openrouter/auto',
      'openrouter/anthropic/claude',
    ]);
    expect(rows.map((model) => parseOpenCodeQualifiedModelRef(model.modelId)?.modelId)).toEqual(
      nativeModels
    );
    for (const model of rows) {
      expect(model).toMatchObject({
        providerId: 'openrouter',
        availability: 'untested',
        default: false,
        proofState: 'needs_probe',
        requiresExecutionProof: true,
      });
    }
  }
);

it('filters/paginates a directory and reports malformed responses as unavailable rather than empty ready', async () => {
  const f = fixture();
  expect(
    (await f.port.loadProviderDirectory({ runtimeId: 'opencode', filter: 'connected' })).directory
      ?.entries
  ).toEqual([]);
  expect(
    (await f.port.loadProviderDirectory({ runtimeId: 'opencode', query: 'TEST', limit: 1 }))
      .directory?.returnedCount
  ).toBe(1);
  expect(
    (await f.port.loadProviderDirectory({ runtimeId: 'opencode', cursor: '1e0' })).error?.code
  ).toBe('runtime-unhealthy');
  expect(() =>
    parseManagementCatalog(
      { ok: true, value: { ...binding, configRevision: 'wrong', providers: [] } },
      binding
    )
  ).toThrow();
  expect(() =>
    parseManagementCatalog(
      { ok: true, value: { ...binding, providers: [{ connected: true }] } },
      binding
    )
  ).toThrow();
});

it('captures credential intent before awaits, then refreshes the same original owner', async () => {
  const f = fixture();
  let release!: () => void;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  f.capture.mockImplementationOnce(async () => {
    await barrier;
    return f.target;
  });
  const metadata = { plan: 'TEST-original-plan' };
  const input = {
    runtimeId: 'opencode' as const,
    providerId: 'TEST-provider',
    method: 'api' as const,
    apiKey: 'TEST-original-key',
    metadata,
    projectPath: '/TEST/original',
  };
  const pending = f.port.connectProvider(input);
  input.providerId = 'TEST-changed';
  input.apiKey = 'TEST-changed-key';
  metadata.plan = 'TEST-changed';
  release();
  expect((await pending).provider?.state).toBe('connected');
  expect(f.calls[0]).toEqual({ operation: 'credential.pending', payload: { providerId: 'TEST-provider' } });
  expect(f.calls[1]).toEqual({
    operation: 'credential',
    payload: {
      commandId: expect.any(String),
      kind: 'credential.set',
      providerId: 'TEST-provider',
      key: 'TEST-original-key',
      metadata: { plan: 'TEST-original-plan' },
    },
  });
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.calls[2]).toEqual({ operation: 'catalog', payload: { providerId: 'TEST-provider' } });
  expect(
    (await f.port.forgetCredential({ runtimeId: 'opencode', providerId: 'TEST-provider' })).provider
      ?.state
  ).toBe('not-connected');
  expect(f.calls[4]?.payload.commandId).not.toBe(f.calls[1]?.payload.commandId);
});

it('contains raw failures and does not dispatch another owner or legacy CLI after an unknown mutation', async () => {
  const f = fixture();
  f.fail();
  const result = await f.port.connectWithApiKey({
    runtimeId: 'opencode',
    providerId: 'TEST-provider',
    apiKey: 'TEST-key',
  });
  expect(result.error?.code).toBe('runtime-unhealthy');
  expect(JSON.stringify(result)).not.toContain('TEST-api-key-raw');
  expect(f.calls.map((call) => call.operation)).toEqual(['credential.pending', 'credential', 'credential.resume']);
  expect(f.capture).toHaveBeenCalledTimes(1);
});

it('V2 preserves native plain-key setup and its announced model verification without offering V1 forget', async () => {
  const f = fixture(undefined, 'v2');
  const form = await f.port.loadSetupForm({ runtimeId: 'opencode', providerId: 'TEST-provider' });
  expect(form.setupForm).toMatchObject({ method: 'api', supported: true,
    verification: { kind: 'model-request', freeModelPreferred: false, mayUseQuotaOrBalance: true } });
  expect(f.calls.every(call => call.operation === 'catalog')).toBe(true);
  const connected = await f.port.connectWithApiKey({ runtimeId: 'opencode', providerId: 'TEST-provider', apiKey: 'TEST-key' });
  expect(connected.provider?.state).toBe('connected');
  expect(connected.provider?.actions.some(action => action.id === 'forget')).toBe(false);
  expect(f.calls.filter(call => call.operation === 'credential')).toHaveLength(1);
  const forgotten = await f.port.forgetCredential({ runtimeId: 'opencode', providerId: 'TEST-provider' });
  expect(forgotten.error).toBeDefined();
  expect(f.calls.filter(call => call.operation === 'credential')).toHaveLength(1);
  const nativeRequest = f.target.request.bind(f.target);
  f.target.request = async (operation, payload): Promise<JsonValue> => {
    const reply = await nativeRequest(operation, payload);
    return operation === 'credential' ? { ok: true, value: { ...binding,
      commandId: payload.commandId!, providerId: payload.providerId!, kind: payload.kind!,
      phase: 'held', reason: 'verification-rejected' } } : reply;
  };
  const rejected = await f.port.connectWithApiKey({ runtimeId: 'opencode', providerId: 'TEST-provider', apiKey: 'TEST-wrong-key' });
  expect(rejected.error).toMatchObject({ code: 'auth-failed', recoverable: true });
  expect(rejected.error?.message).toContain('Check the key and connect again');
  expect(rejected.provider).toBeUndefined();
  expect(f.calls.filter(call => call.operation === 'credential')).toHaveLength(2);
});

it('cancels only the original model-load subscribers and hides their late catalog result', async () => {
  const f = fixture();
  let release!: () => void;
  f.setBarrier(
    new Promise<void>((done) => {
      release = done;
    })
  );
  const pending = f.port.loadModels({
    runtimeId: 'opencode',
    providerId: 'TEST-provider',
    requestGroupId: 'TEST-group',
  });
  await vi.waitFor(() => expect(f.calls).toHaveLength(1));
  expect(await f.port.cancelModelLoad({ requestGroupId: 'TEST-group' })).toEqual({ ok: true });
  release();
  expect((await pending).models).toBeUndefined();
  expect(
    (
      await f.port.loadModels({
        runtimeId: 'opencode',
        providerId: 'TEST-provider',
        requestGroupId: 'TEST-group',
      })
    ).models?.models
  ).toHaveLength(1);
});

it('shares only an in-flight captured model catalog while keeping each subscriber cancellation independent', async () => {
  const f = fixture();
  const unused = async () => {
    throw new Error('TEST unexpected local-provider operation');
  };
  // Main's registered IPC handlers retain this same feature/port between calls.
  const feature = createRuntimeProviderManagementFeature({
    port: f.port,
    companionRegistry: new Map(),
    localProviderConnector: {
      listLocalProviders: unused,
      scanLocalProviders: unused,
      probeLocalProvider: unused,
      configureLocalProvider: unused,
    },
  });
  let release!: () => void;
  f.setBarrier(
    new Promise<void>((done) => {
      release = done;
    })
  );
  const input = { runtimeId: 'opencode' as const, providerId: 'TEST-provider', refresh: true };
  const first = feature.loadModels({ ...input, requestGroupId: 'TEST-dialog' });
  await vi.waitFor(() => expect(f.calls).toHaveLength(1));
  const second = feature.loadModels({ ...input, requestGroupId: 'TEST-picker' });
  try {
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(2));
    expect(f.calls).toEqual([{ operation: 'catalog', payload: { providerId: 'TEST-provider' } }]);
    expect(await feature.cancelModelLoad({ requestGroupId: 'TEST-dialog' })).toEqual({ ok: true });
    release();
    expect((await first).models).toBeUndefined();
    expect((await second).models?.models).toEqual([
      expect.objectContaining({ modelId: 'TEST-provider/TEST-model' }),
    ]);
    expect(
      (await feature.loadModels({ ...input, requestGroupId: 'TEST-after-settlement' })).models
        ?.models
    ).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
});

it.each(['retired', 'current'] as const)(
  'starts a fresh same-key catalog after navigation with the %s request settling first',
  async (settlesFirst) => {
    const f = fixture();
    let selection = {};
    let draining = false;
    const releases: (() => void)[] = [];
    const targets: CapturedProviderManagement[] = [];
    const request = vi.fn(async (method: string, payload?: JsonValue): Promise<JsonValue> => {
      expect(method).toBe('management.catalog');
      expect(payload).toEqual({ ...binding, providerId: 'TEST-provider' });
      if (!draining) await new Promise<void>((resolve) => releases.push(resolve));
      return f.target.request('catalog', { providerId: 'TEST-provider' });
    });
    const capture = vi.fn(async () => {
      const originalSelection = selection;
      const target = captureProviderManagement({
        ...binding,
        targetId: f.target.targetId,
        client: { request },
        start: async () => undefined,
        ownerAvailable: () => true,
        foregroundCurrent: () => originalSelection === selection,
      });
      targets.push(target);
      return target;
    });
    const port = createCapturedRuntimeProviderManagementClient({ capture });
    const input = { runtimeId: 'opencode' as const, providerId: 'TEST-provider' };
    const retired = port.loadModels(input);
    const pending = [retired];
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      // Registry selections never revive on A -> B -> A, although descriptor identity does.
      selection = {};
      const current = port.loadModels(input);
      pending.push(current);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(targets[0].isCurrent()).toBe(false);
      expect(targets[1].isCurrent()).toBe(true);
      expect(targets[0].targetId).toBe(targets[1].targetId);
      releases[settlesFirst === 'retired' ? 0 : 1]();
      if (settlesFirst === 'retired') {
        expect((await retired).models).toBeUndefined();
      } else {
        expect((await current).models?.models).toEqual([
          expect.objectContaining({ modelId: 'TEST-provider/TEST-model' }),
        ]);
      }
      const next = port.loadModels(input);
      pending.push(next);
      await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(3));
      if (settlesFirst === 'retired') {
        // The retired request's finally must leave the replacement pending entry intact.
        expect(request).toHaveBeenCalledTimes(2);
        releases[1]();
        expect((await current).models?.models).toHaveLength(1);
      } else {
        // Completed responses are not cached; an old finally cannot delete this new read.
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
        releases[0]();
        expect((await retired).models).toBeUndefined();
        const joining = port.loadModels(input);
        pending.push(joining);
        await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(4));
        expect(request).toHaveBeenCalledTimes(3);
        releases[2]();
        expect((await joining).models?.models).toHaveLength(1);
      }
      expect((await next).models?.models).toHaveLength(1);
    } finally {
      draining = true;
      for (const release of releases) release();
      await Promise.allSettled(pending);
    }
  }
);

it.each(['targetId', 'profileId', 'configRevision', 'providerId'] as const)(
  'does not share a captured model read across changed %s',
  async (field) => {
    const f = fixture();
    let release!: () => void;
    f.setBarrier(
      new Promise<void>((done) => {
        release = done;
      })
    );
    const original = f.target;
    const changed: CapturedProviderManagement =
      field === 'providerId'
        ? original
        : { ...original, [field]: field === 'targetId' ? 'b'.repeat(64) : 'TEST-new-binding' };
    const capture = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(changed);
    const port = createCapturedRuntimeProviderManagementClient({ capture });
    const input = { runtimeId: 'opencode' as const, providerId: 'TEST-provider', refresh: true };
    const first = port.loadModels(input);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    const second = port.loadModels({
      ...input,
      providerId: field === 'providerId' ? 'TEST-other-provider' : input.providerId,
    });
    try {
      await vi.waitFor(() => expect(f.calls).toHaveLength(2));
      release();
      expect((await first).models?.models).toHaveLength(1);
      const result = await second;
      if (field === 'targetId') expect(result.models?.models).toHaveLength(1);
      else expect(result.models).toBeUndefined();
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
  }
);

it.each(['before joining', 'after the native read'] as const)(
  'refuses only the captured subscriber whose owner changed %s',
  async (when) => {
    const f = fixture();
    let release!: () => void;
    f.setBarrier(
      new Promise<void>((done) => {
        release = done;
      })
    );
    let current = when !== 'before joining';
    const subscriber: CapturedProviderManagement = { ...f.target, isCurrent: () => current };
    const capture = vi.fn().mockResolvedValueOnce(f.target).mockResolvedValueOnce(subscriber);
    const port = createCapturedRuntimeProviderManagementClient({ capture });
    const input = { runtimeId: 'opencode' as const, providerId: 'TEST-provider' };
    const first = port.loadModels(input);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    const second = port.loadModels(input);
    try {
      await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
      current = false;
      release();
      expect((await first).models?.models).toHaveLength(1);
      expect((await second).models).toBeUndefined();
      expect(f.calls).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
  }
);

it('retires a rejected shared model read before a fresh request without exposing native errors', async () => {
  const f = fixture();
  let release!: () => void;
  f.setBarrier(
    new Promise<void>((done) => {
      release = done;
    })
  );
  let reject = true;
  const original = f.target.request;
  f.target.request = async (...args) => {
    const raw = await original(...args);
    if (reject) throw new Error('TEST-private-native-error');
    return raw;
  };
  const input = { runtimeId: 'opencode' as const, providerId: 'TEST-provider', refresh: true };
  const first = f.port.loadModels(input);
  await vi.waitFor(() => expect(f.calls).toHaveLength(1));
  const second = f.port.loadModels(input);
  try {
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(2));
    expect(f.calls).toHaveLength(1);
    release();
    const results = await Promise.all([first, second]);
    for (const result of results) expect(result.error?.code).toBe('runtime-unhealthy');
    expect(JSON.stringify(results)).not.toContain('TEST-private-native-error');
    reject = false;
    expect((await f.port.loadModels(input)).models?.models).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
});

it('keeps an all-cancelled model read owned until it settles and then releases it', async () => {
  const f = fixture();
  let release!: () => void;
  f.setBarrier(
    new Promise<void>((done) => {
      release = done;
    })
  );
  const input = { runtimeId: 'opencode' as const, providerId: 'TEST-provider' };
  let settled = 0;
  const first = f.port.loadModels({ ...input, requestGroupId: 'TEST-first' }).finally(() => {
    settled++;
  });
  await vi.waitFor(() => expect(f.calls).toHaveLength(1));
  const second = f.port.loadModels({ ...input, requestGroupId: 'TEST-second' }).finally(() => {
    settled++;
  });
  try {
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(2));
    await f.port.cancelModelLoad({ requestGroupId: 'TEST-first' });
    await f.port.cancelModelLoad({ requestGroupId: 'TEST-second' });
    expect(settled).toBe(0);
    expect(f.calls).toHaveLength(1);
    release();
    const results = await Promise.all([first, second]);
    expect(settled).toBe(2);
    for (const result of results) expect(result.models).toBeUndefined();
    expect((await f.port.loadModels(input)).models?.models).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
});

it('projects each shared native catalog with separate preferences and filters without mutating raw data', async () => {
  const f = fixture();
  let release!: () => void;
  f.setBarrier(
    new Promise<void>((done) => {
      release = done;
    })
  );
  let rawResult: JsonValue = null;
  let originalBytes = '';
  const original = f.target.request;
  f.target.request = async (...args) => {
    rawResult = await original(...args);
    originalBytes = JSON.stringify(rawResult);
    return rawResult;
  };
  const preferences = vi.spyOn(managementPreferences, 'selectedPreferences');
  const input = { runtimeId: 'opencode' as const, providerId: 'TEST-provider' };
  const first = f.port.loadModels({ ...input, query: 'TEST model' });
  await vi.waitFor(() => expect(f.calls).toHaveLength(1));
  const second = f.port.loadModels({ ...input, query: 'TEST absent model' });
  try {
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(2));
    expect(f.calls).toHaveLength(1);
    release();
    expect((await first).models?.models).toHaveLength(1);
    expect((await second).models?.models).toEqual([]);
    expect(preferences).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(rawResult)).toBe(originalBytes);
  } finally {
    release();
    await Promise.allSettled([first, second]);
    preferences.mockRestore();
  }
});

it('keeps pending parity explicit and never silently falls back to the old implementation', async () => {
  const f = fixture();
  expect(
    (
      await f.port.setDefaultModel({
        runtimeId: 'opencode',
        providerId: 'TEST-provider',
        modelId: 'TEST-provider/TEST-model',
      })
    ).error?.code
  ).toBe('unsupported-action');
  expect(
    (
      await f.port.connectProvider({
        runtimeId: 'opencode',
        providerId: 'TEST-provider',
        method: 'oauth',
      })
    ).error?.code
  ).toBe('unsupported-action');
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});

it('does not bypass unsupported native API prompts with a generic key form', async () => {
  const f = fixture();
  const nativeRequest = f.target.request.bind(f.target);
  f.target.request = async (operation, payload) => {
    const reply = await nativeRequest(operation, payload);
    if (operation === 'catalog') {
      const result = reply as { ok: boolean; value: { providers: { authOptions?: unknown }[] } };
      result.value.providers[0]!.authOptions = [
        {
          methodIndex: 0,
          type: 'api',
          label: 'TEST unsupported prompt',
          supported: false,
          prompts: [],
        },
      ];
    }
    return reply;
  };
  const result = await f.port.loadSetupForm({ runtimeId: 'opencode', providerId: 'TEST-provider' });
  expect(result.setupForm).toMatchObject({ supported: false, method: 'manual', secret: null });
});

it('missing API key in a malformed connect cannot be interpreted as credential forget', async () => {
  const f = fixture();
  const result = await f.port.connectWithApiKey({
    runtimeId: 'opencode',
    providerId: 'TEST-provider',
    apiKey: undefined,
  } as unknown as Parameters<typeof f.port.connectWithApiKey>[0]);
  expect(result.error).toBeDefined();
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});

it('preserves native model declarations through the captured catalog without inventing missing support', async () => {
  for (const [declaration, expected] of [
    [
      ['image', 'video'],
      ['image', 'video'],
    ],
    [[], []],
    [null, null],
    [['image', 1], null],
    [undefined, undefined],
  ] as const) {
    const f = fixture(
      declaration === undefined ? undefined : declaration === null ? null : [...declaration]
    );
    const result = await f.port.loadModels({
      runtimeId: 'opencode',
      providerId: 'TEST-provider',
      projectPath: '/TEST/recipient-project',
    });
    expect(result.models?.models[0]?.declaredInputModalities).toEqual(expected);
    expect(f.capture).toHaveBeenCalledWith('/TEST/recipient-project');
  }
});

function observeViewDiagnostics(flag: string | undefined) {
  const previous = process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS;
  if (flag === undefined) delete process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS;
  else process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS = flag;
  const records: logging.LogSinkEntry[] = [];
  const remove = logging.addLogSink((entry) => {
    if (entry.namespace === 'Host:ProviderView') records.push(entry);
  });
  return {
    records,
    restore: () => {
      remove();
      if (previous === undefined) delete process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS;
      else process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS = previous;
    },
  };
}

function deferredViewStage() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

it('observes the three original view awaits without another catalog or currentness read', async () => {
  const observation = observeViewDiagnostics('1');
  try {
    const f = fixture();
    const captureBlock = deferredViewStage();
    const captureEntered = deferredViewStage();
    const catalogBlock = deferredViewStage();
    const catalogEntered = deferredViewStage();
    const preferencesBlock = deferredViewStage();
    const preferencesEntered = deferredViewStage();
    const current = vi.fn((): boolean => true);
    f.target.isCurrent = current;
    f.capture.mockImplementationOnce(async () => {
      captureEntered.release();
      await captureBlock.promise;
      return f.target;
    });
    const originalRequest = f.target.request.bind(f.target);
    f.target.request = (operation, payload) => {
      catalogEntered.release();
      return originalRequest(operation, payload);
    };
    f.setBarrier(catalogBlock.promise);
    const originalPreferences = managementPreferences.selectedPreferences;
    const preferences = vi.spyOn(managementPreferences, 'selectedPreferences')
      .mockImplementation(async (target, nativeDefault) => {
        preferencesEntered.release();
        await preferencesBlock.promise;
        return originalPreferences(target, nativeDefault);
      });
    const pending = f.port.loadView({ runtimeId: 'opencode', projectPath: '/TEST/private-project' });
    try {
      await captureEntered.promise;
      expect(observation.records).toHaveLength(1);
      captureBlock.release();
      await catalogEntered.promise;
      expect(observation.records).toHaveLength(2);
      catalogBlock.release();
      await preferencesEntered.promise;
      expect(observation.records).toHaveLength(3);
      expect(current).not.toHaveBeenCalled();
      preferencesBlock.release();
      expect((await pending).view).toBeDefined();
      expect(f.capture).toHaveBeenCalledTimes(1);
      expect(f.capture).toHaveBeenCalledWith('/TEST/private-project');
      expect(f.calls).toEqual([{ operation: 'catalog', payload: {} }]);
      expect(preferences).toHaveBeenCalledTimes(1);
      expect(preferences).toHaveBeenCalledWith(f.target, null);
      expect(current).toHaveBeenCalledTimes(2);
      expect(observation.records.map((entry) => entry.args)).toEqual(
        ['capture', 'catalog', 'preferences', 'resolved'].map((stage) => [
          'Runtime provider view stage',
          { kind: 'runtime-provider-view-stage-v1', view: 1, stage, scope: 'project' },
        ])
      );
    } finally {
      captureBlock.release();
      catalogBlock.release();
      preferencesBlock.release();
      await pending.catch(() => undefined);
      preferences.mockRestore();
    }
  } finally {
    observation.restore();
  }
});

it('keeps disabled views silent and bounds observations to the first 32 enabled views per port', async () => {
  const observation = observeViewDiagnostics(undefined);
  try {
    const f = fixture();
    expect((await f.port.loadView({ runtimeId: 'opencode' })).view).toBeDefined();
    process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS = 'true';
    expect((await f.port.loadView({ runtimeId: 'opencode' })).view).toBeDefined();
    expect(observation.records).toEqual([]);
    process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS = '1';
    for (let index = 0; index < 33; index++)
      expect((await f.port.loadView({ runtimeId: 'opencode' })).view).toBeDefined();
    expect(f.capture).toHaveBeenCalledTimes(35);
    expect(f.calls).toEqual(Array.from({ length: 35 }, () => ({ operation: 'catalog', payload: {} })));
    expect(observation.records).toHaveLength(128);
    const stages = ['capture', 'catalog', 'preferences', 'resolved'];
    observation.records.forEach((entry, index) => {
      expect(entry.level).toBe('diagnostic');
      expect(entry.args).toEqual([
        'Runtime provider view stage',
        { kind: 'runtime-provider-view-stage-v1', view: Math.floor(index / 4) + 1,
          stage: stages[index % 4], scope: 'global' },
      ]);
    });
    const other = fixture();
    expect((await other.port.loadView({
      runtimeId: 'opencode', projectPath: '/TEST/private-other-project',
    })).view).toBeDefined();
    expect(observation.records.slice(128).map((entry) => entry.args)).toEqual(
      stages.map((stage) => [
        'Runtime provider view stage',
        { kind: 'runtime-provider-view-stage-v1', view: 1, stage, scope: 'project' },
      ])
    );
    for (const secret of ['TEST-private', '/TEST/', binding.profileId, binding.configRevision,
      'a'.repeat(64), 'TEST-secret'])
      expect(JSON.stringify(observation.records)).not.toContain(secret);
  } finally {
    observation.restore();
  }
});

it('keeps original view failures and their call boundaries without recording raw errors', async () => {
  const observation = observeViewDiagnostics('1');
  try {
    for (const failure of ['capture', 'catalog', 'preferences', 'final-current'] as const) {
      const f = fixture();
      const current = vi.fn((): boolean => true);
      f.target.isCurrent = current;
      if (failure === 'capture')
        f.capture.mockRejectedValueOnce(new CapturedRuntimeSourceError('configuration-invalid'));
      else if (failure === 'catalog') f.fail();
      else if (failure === 'preferences') current.mockReturnValue(false);
      else current.mockReturnValueOnce(true).mockReturnValue(false);
      const start = observation.records.length;
      const result = await f.port.loadView({ runtimeId: 'opencode' });
      expect(result.error?.code).toBe(
        failure === 'capture' ? 'runtime-misconfigured' : 'runtime-unhealthy'
      );
      expect(result.view).toBeUndefined();
      expect(f.capture).toHaveBeenCalledTimes(1);
      expect(f.calls).toEqual(
        failure === 'capture' ? [] : [{ operation: 'catalog', payload: {} }]
      );
      expect(current).toHaveBeenCalledTimes(
        failure === 'preferences' ? 1 : failure === 'final-current' ? 2 : 0
      );
      const stages = failure === 'capture' ? ['capture', 'rejected']
        : failure === 'catalog' ? ['capture', 'catalog', 'rejected']
          : ['capture', 'catalog', 'preferences', 'rejected'];
      expect(observation.records.slice(start).map((entry) => entry.args)).toEqual(
        stages.map((stage) => [
          'Runtime provider view stage',
          { kind: 'runtime-provider-view-stage-v1', view: 1, stage, scope: 'global' },
        ])
      );
    }
    for (const secret of ['TEST-api-key-raw', binding.profileId, binding.configRevision, 'TEST-secret'])
      expect(JSON.stringify(observation.records)).not.toContain(secret);
  } finally {
    observation.restore();
  }
});

it('contains throwing diagnostic sinks and observer creation without changing the original view', async () => {
  const observation = observeViewDiagnostics('1');
  let removeThrowingSink: (() => void) | undefined;
  try {
    const baseline = await fixture().port.loadView({ runtimeId: 'opencode' });
    const f = fixture();
    let sinkCalls = 0;
    removeThrowingSink = logging.addLogSink((entry) => {
      if (entry.namespace === 'Host:ProviderView') {
        sinkCalls++;
        throw new Error('TEST-observer-secret');
      }
    });
    expect(await f.port.loadView({ runtimeId: 'opencode' })).toEqual(baseline);
    expect(sinkCalls).toBe(4);
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual([{ operation: 'catalog', payload: {} }]);
    removeThrowingSink();
    removeThrowingSink = undefined;
    const other = fixture();
    const logger = vi.spyOn(logging, 'createLogger').mockImplementation(() => {
      throw new Error('TEST-logger-factory-secret');
    });
    try {
      expect(await other.port.loadView({ runtimeId: 'opencode' })).toEqual(baseline);
      expect(logger).toHaveBeenCalledTimes(4);
      expect(other.capture).toHaveBeenCalledTimes(1);
      expect(other.calls).toEqual([{ operation: 'catalog', payload: {} }]);
    } finally {
      logger.mockRestore();
    }
    expect(JSON.stringify(observation.records)).not.toContain('TEST-observer-secret');
    expect(JSON.stringify(observation.records)).not.toContain('TEST-logger-factory-secret');
  } finally {
    removeThrowingSink?.();
    observation.restore();
  }
});
