// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { createCapturedRuntimeProviderManagementClient } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient';
import { parseManagementCatalog } from '../../../src/features/runtime-provider-management/main/adapters/output/capturedManagementCatalog';
import type {
  CapturedProviderManagement,
  ProviderManagementOperation,
} from '../../../src/features/agent-backend/main';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

const binding = { profileId: 'TEST-original', configRevision: 'TEST-v1' };
function fixture() {
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
          secretExtension: 'TEST-secret',
          providers: [
            {
              providerId: 'TEST-provider',
              displayName: 'TEST provider',
              source: 'api',
              connected,
              configured: false,
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
});

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
  expect(f.calls[0]).toEqual({
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
  expect(f.calls[1]).toEqual({ operation: 'catalog', payload: { providerId: 'TEST-provider' } });
  expect(
    (await f.port.forgetCredential({ runtimeId: 'opencode', providerId: 'TEST-provider' })).provider
      ?.state
  ).toBe('not-connected');
  expect(f.calls[2]?.payload.commandId).not.toBe(f.calls[0]?.payload.commandId);
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
  expect(f.calls.map((call) => call.operation)).toEqual(['credential']);
  expect(f.capture).toHaveBeenCalledTimes(1);
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
