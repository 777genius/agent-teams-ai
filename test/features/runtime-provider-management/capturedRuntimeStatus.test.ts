// @vitest-environment node
import { expect, it, vi } from 'vitest';

import {
  canManagedInstallChangeOpenCodeRuntime,
  resolveOpenCodeQuickConnectRuntimeRevision,
} from '../../../src/features/runtime-provider-management/core/domain/runtimeProviderQuickConnect';
import {
  type CapturedRuntimeProviderStatusDependencies,
  createCapturedRuntimeProviderStatusClient,
} from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient';
import { getTeamEffortSelectorPresentation } from '../../../src/renderer/utils/teamEffortOptions';

import type { CapturedProviderManagement } from '../../../src/features/agent-backend/main';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

function fixture(
  runtime?: JsonValue,
  maintenance: Pick<
    CapturedRuntimeProviderStatusDependencies,
    'resolveLatestOpenCodeVersion' | 'qualifiedOpenCodeV2Version'
  > = {}
) {
  let current = true;
  const request = vi.fn(async () => ({
    ok: true,
    value: {
      profileId: 'TEST-profile',
      configRevision: 'TEST-config',
      ...(runtime === undefined ? {} : { runtime }),
      configuredDefaultModelId: 'TEST-local/TEST-model',
      providers: [
        {
          providerId: 'TEST-local',
          displayName: 'TEST Local',
          connected: true,
          configured: true,
          configuredAuthless: true,
          source: 'config',
          modelCount: 1,
          defaultModelId: 'TEST-model',
          authMethods: ['api'],
          models: [
            {
              modelId: 'TEST-model',
              displayName: 'TEST Model',
              contextTokens: 4096,
              outputTokens: 128,
              free: false,
              variants: ['low', 'high', 'max', 'ultra', 'TEST-custom-variant'],
            },
          ],
        },
      ],
    },
  }));
  const target: CapturedProviderManagement = {
    targetId: 'a'.repeat(64),
    profileId: 'TEST-profile',
    configRevision: 'TEST-config',
    isCurrent: () => current,
    request,
  };
  const capture = vi.fn(async () => target);
  const readHealth = vi.fn(async () => ({ buildId: 'TEST-host' }));
  const port = createCapturedRuntimeProviderStatusClient({
    capture,
    readHealth,
    captureGuard: () => () => current,
    now: () => 1700000000000,
    ...maintenance,
  });
  return {
    port,
    request,
    capture,
    readHealth,
    stale: () => {
      current = false;
    },
  };
}

it('native installation health needs no fork path; deferred status makes no provider or model request', async () => {
  const f = fixture();
  expect(await f.port.getStatus({ providerStatusMode: 'defer' })).toMatchObject({
    displayName: 'Agent Teams Host',
    installed: true,
    installedVersion: 'TEST-host',
    binaryPath: null,
    supportsSelfUpdate: false,
    authLoggedIn: false,
  });
  expect(f.readHealth).toHaveBeenCalledTimes(1);
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});

it('projects bounded native catalog and effective default without treating credentials as execution/authentication proof', async () => {
  const f = fixture();
  const status = await f.port.getProviderStatus('opencode', { projectPath: '/TEST/project' });
  expect(f.capture).toHaveBeenCalledWith('/TEST/project');
  expect(f.request).toHaveBeenCalledWith('catalog', { includeModels: true });
  expect(status).toMatchObject({
    supported: true,
    authenticated: false,
    verificationState: 'unknown',
    statusCheckOutcome: 'model_only',
    capabilities: { teamLaunch: false, oneShot: false },
    models: ['TEST-local/TEST-model'],
    modelCatalog: { status: 'ready', defaultModelId: 'TEST-local/TEST-model' },
  });
  expect(status.modelCatalog?.models[0]?.metadata?.opencode).toMatchObject({
    routeKind: 'configured_local',
    proofState: 'needs_probe',
  });
  expect(status.modelCatalog?.models[0]?.supportedReasoningEfforts).toEqual(['low', 'high']);
  expect(getTeamEffortSelectorPresentation({
    providerId: 'opencode', model: 'TEST-local/TEST-model', providerStatus: status,
  })).toMatchObject({
    disabled: false,
    options: [{ value: '', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
  });
  expect(f.request.mock.calls).toHaveLength(1);
  expect(status.catalogScope).toMatch(/^[a-f0-9]{64}$/);
  expect(status.catalogScope).not.toBe('a'.repeat(64));
});

it('only valid current native variants enable the existing effort selector', async () => {
  for (const variants of [undefined, [], ['high', 'high'], [' high'], [7], 'high']) {
    const f = fixture();
    const response = await f.request.getMockImplementation()!();
    Object.assign(response.value.providers[0]!.models[0]!, { variants });
    f.request.mockResolvedValue(response);
    const status = await f.port.getProviderStatus('opencode');
    if (variants === undefined || Array.isArray(variants) && variants.length === 0) {
      expect(status.statusCheckOutcome).toBe('model_only');
      expect(getTeamEffortSelectorPresentation({
        providerId: 'opencode', model: 'TEST-local/TEST-model', providerStatus: status,
      }).disabled).toBe(true);
    } else {
      expect(status.statusCheckOutcome).toBe('transient_error');
      expect(status.models).toEqual([]);
    }
  }
});

it('partial adapters fail explicitly and never consult an ambient legacy runtime; stale catalog data is discarded', async () => {
  const f = fixture();
  const status = await f.port.getStatus();
  expect(status.installed).toBe(true);
  for (const id of ['anthropic', 'codex'])
    expect(status.providers.find((p) => p.providerId === id)).toMatchObject({
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
      authenticated: false,
    });
  f.stale();
  expect((await f.port.getProviderStatus('opencode')).models).toEqual([]);
  expect((await f.port.getStatus()).installed).toBe(false);
});

it('a failed native handshake prevents provider allocation rather than resolving a fork binary', async () => {
  const f = fixture();
  f.readHealth.mockRejectedValueOnce(new Error('TEST-private-launch-error'));
  const status = await f.port.getStatus();
  expect(status.installed).toBe(false);
  expect(f.capture).not.toHaveBeenCalled();
  expect(JSON.stringify(status)).not.toContain('TEST-private-launch-error');
});

it('the original V2 catalog supplies engine availability without a CLI path or model authority', async () => {
  const resolveLatestOpenCodeVersion = vi.fn(async () => '2.3.0');
  const maintenance = { resolveLatestOpenCodeVersion, qualifiedOpenCodeV2Version: '2.1.4' };
  const f = fixture({ generation: 'v2', version: '2.1.4' }, maintenance);
  expect(await f.port.readOpenCodeRuntimeStatus!()).toEqual({
    installed: true,
    source: 'captured-host',
    state: 'ready',
    version: '2.1.4',
    v2Support: 'ready',
  });
  expect(f.capture).toHaveBeenCalledWith(null);
  expect(f.request).toHaveBeenCalledExactlyOnceWith('catalog', {});
  const seed = createCapturedRuntimeProviderStatusClient({
    capture: f.capture,
    readHealth: f.readHealth,
    ...maintenance,
    captureSources: async () => ({
      current: async () => ({
        sourceId: 'a'.repeat(64),
        revision: 'b'.repeat(64),
        profileId: 'TEST-profile',
        configRevision: 'TEST-config',
        sourceKind: 'bundled' as const,
        nativeGeneration: 'v2' as const,
        engineVersion: '2.1.4',
      }),
    }),
  });
  expect(await seed.readOpenCodeRuntimeStatus!()).toEqual({
    installed: true,
    source: 'captured-host',
    state: 'ready',
    version: '2.1.4',
    engineVersion: '2.1.4',
    v2Support: 'ready',
    sourceRevision: 'b'.repeat(64),
  });
  expect(resolveLatestOpenCodeVersion).not.toHaveBeenCalled();
  const provider = await f.port.getProviderStatus('opencode');
  expect(provider.authenticated).toBe(false);
  expect(provider.capabilities.teamLaunch).toBe(false);
});

it('only the explicit successful native V1 catalog retains the separate installer status', async () => {
  const resolveLatestOpenCodeVersion = vi.fn(async () => '1.19.5');
  const f = fixture({ generation: 'v1' }, { resolveLatestOpenCodeVersion });
  expect(await f.port.readOpenCodeRuntimeStatus!()).toBeNull();
  expect(f.request).toHaveBeenCalledExactlyOnceWith('catalog', {});
  expect(resolveLatestOpenCodeVersion).not.toHaveBeenCalled();
});

it('current source status accepts its first captured configuration and fences a concurrent source replacement', async () => {
  const f = fixture({ generation: 'v2', version: '2.1.4' });
  const selection = {
    sourceId: 'a'.repeat(64),
    revision: 'b'.repeat(64),
    profileId: 'TEST-profile',
    configRevision: 'TEST-config',
    sourceKind: 'app-managed' as const,
    nativeGeneration: 'v2' as const,
    cliVersion: '2.0.21',
    engineVersion: '2.1.4',
  };
  let selected = { ...selection, revision: '0'.repeat(64),
    profileId: 'TEST-before-configuration', configRevision: 'TEST-before-configuration' };
  const captureOriginal = f.capture.getMockImplementation()!;
  f.capture.mockImplementation(async () => {
    const target = await captureOriginal();
    selected = selection; // The original capture publishes its first configuration before returning.
    return target;
  });
  const current = vi.fn(async () => selected);
  const resolveLatestOpenCodeVersion = vi.fn(async () => '2.3.0');
  const port = createCapturedRuntimeProviderStatusClient({
    capture: f.capture,
    readHealth: f.readHealth,
    captureSources: async () => ({ current }),
    resolveLatestOpenCodeVersion,
    qualifiedOpenCodeV2Version: '2.1.4',
  });
  const status = await port.readOpenCodeRuntimeStatus!();
  expect(status).toEqual({
    installed: true,
    state: 'ready',
    source: 'app-managed',
    version: '2.0.21',
    latestVersion: '2.3.0',
    updateAvailable: true,
    engineVersion: '2.1.4',
    compatibleV2Version: '2.1.4',
    sourceRevision: selection.revision,
    v2Support: 'ready',
  });
  expect(f.capture).toHaveBeenCalledExactlyOnceWith(null);
  expect(f.request).toHaveBeenCalledExactlyOnceWith('catalog', {});
  expect(current).toHaveBeenCalledTimes(2);
  expect(resolveLatestOpenCodeVersion).toHaveBeenCalledExactlyOnceWith('2.0.21');
  expect(canManagedInstallChangeOpenCodeRuntime({ ...status!, source: 'captured-host' })).toBe(
    true
  );
  expect(
    resolveOpenCodeQuickConnectRuntimeRevision({ gate: 'ready', runtimeStatus: status })
  ).not.toBe(
    resolveOpenCodeQuickConnectRuntimeRevision({
      gate: 'ready',
      runtimeStatus: { ...status!, sourceRevision: 'c'.repeat(64) },
    })
  );
  current
    .mockResolvedValueOnce(selection)
    .mockResolvedValueOnce({ ...selection, revision: 'c'.repeat(64) });
  await expect(port.readOpenCodeRuntimeStatus!()).rejects.toThrow(
    'Native runtime selection changed'
  );
  resolveLatestOpenCodeVersion.mockRejectedValueOnce(new Error('TEST registry unavailable'));
  const offline = await port.readOpenCodeRuntimeStatus!();
  expect(offline).toMatchObject({
    installed: true,
    state: 'ready',
    version: '2.0.21',
    engineVersion: '2.1.4',
    compatibleV2Version: '2.1.4',
    sourceRevision: selection.revision,
  });
  expect(offline).not.toHaveProperty('latestVersion');
  expect(offline).not.toHaveProperty('updateAvailable');
  expect(console.warn).toHaveBeenCalledExactlyOnceWith(
    '[OpenCodeRuntimeInstallerService]', 'Failed to resolve latest OpenCode version:',
    'TEST registry unavailable'
  );
  vi.mocked(console.warn).mockClear();
});

it('a published V1 selection supplies its original CLI version without an ambient installer fallback', async () => {
  const f = fixture({ generation: 'v1' });
  const selection = {
    sourceId: 'a'.repeat(64),
    revision: 'b'.repeat(64),
    profileId: 'TEST-profile',
    configRevision: 'TEST-config',
    sourceKind: 'path' as const,
    nativeGeneration: 'v1' as const,
    cliVersion: '1.19.4',
  };
  let revision = selection.revision;
  const resolveLatestOpenCodeVersion = vi.fn(async () => '1.19.5');
  const port = createCapturedRuntimeProviderStatusClient({
    capture: f.capture,
    readHealth: f.readHealth,
    captureSources: async () => ({
      current: async () => ({ ...selection, revision }),
    }),
    resolveLatestOpenCodeVersion,
    qualifiedOpenCodeV2Version: '2.1.4',
  });
  const ready = {
    installed: true,
    state: 'ready',
    source: 'path',
    version: '1.19.4',
    sourceRevision: selection.revision,
  };
  expect(await port.readOpenCodeRuntimeStatus!()).toEqual({
    ...ready,
    latestVersion: '1.19.5',
    updateAvailable: true,
  });
  expect(resolveLatestOpenCodeVersion).toHaveBeenCalledExactlyOnceWith('1.19.4');
  resolveLatestOpenCodeVersion.mockRejectedValueOnce(new Error('TEST registry unavailable'));
  expect(await port.readOpenCodeRuntimeStatus!()).toEqual(ready);
  expect(f.request).toHaveBeenCalledTimes(2);

  const override = createCapturedRuntimeProviderStatusClient({
    capture: f.capture,
    readHealth: f.readHealth,
    captureSources: async () => ({
      current: async () => ({ ...selection, sourceKind: 'override' as const }),
    }),
    resolveLatestOpenCodeVersion,
  });
  expect(await override.readOpenCodeRuntimeStatus!()).toEqual({ ...ready, source: 'override' });
  expect(resolveLatestOpenCodeVersion).toHaveBeenCalledTimes(2);

  resolveLatestOpenCodeVersion.mockImplementationOnce(async () => {
    revision = 'c'.repeat(64);
    return '1.19.5';
  });
  await expect(port.readOpenCodeRuntimeStatus!()).rejects.toThrow(
    'Native runtime selection changed'
  );
  revision = selection.revision;
  resolveLatestOpenCodeVersion.mockImplementationOnce(async () => {
    f.stale();
    throw new Error('TEST registry unavailable after target revocation');
  });
  await expect(port.readOpenCodeRuntimeStatus!()).rejects.toThrow('Native status context changed');
  expect(vi.mocked(console.warn).mock.calls).toEqual([
    ['[OpenCodeRuntimeInstallerService]', 'Failed to resolve latest OpenCode version:',
      'TEST registry unavailable'],
    ['[OpenCodeRuntimeInstallerService]', 'Failed to resolve latest OpenCode version:',
      'TEST registry unavailable after target revocation'],
  ]);
  vi.mocked(console.warn).mockClear();
});

const INVALID_RUNTIME_EVIDENCE: (JsonValue | undefined)[] = [
  undefined,
  null,
  {},
  { generation: 'v2' },
  { generation: 'v2', version: '2.1.5' },
  { generation: 'v1', version: '2.1.4' },
  { generation: 'v3', version: '3.0.0' },
];
it.each(INVALID_RUNTIME_EVIDENCE)(
  'missing or invalid native runtime evidence cannot select the legacy status source: %j',
  async (runtime) => {
    const f = fixture(runtime);
    await expect(f.port.readOpenCodeRuntimeStatus!()).rejects.toThrow();
  }
);

it('a changed captured target or failed native read cannot publish engine readiness', async () => {
  const f = fixture({ generation: 'v2', version: '2.1.4' });
  f.request.mockRejectedValueOnce(new Error('TEST unavailable original child'));
  await expect(f.port.readOpenCodeRuntimeStatus!()).rejects.toThrow(
    'TEST unavailable original child'
  );
  f.stale();
  await expect(f.port.readOpenCodeRuntimeStatus!()).rejects.toThrow(
    'Native status context changed'
  );
});
