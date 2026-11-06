// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { createCapturedRuntimeProviderStatusClient } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient';
import { reconcileCliProviderSnapshot } from '../../../src/renderer/store/slices/cliInstallerStatusReconciliation';
import { getTeamEffortOptions } from '../../../src/renderer/utils/teamEffortOptions';
import { hasAuthoritativeProviderLaunchEvidence, isProviderModelCatalogExactReady } from '../../../src/shared/utils/providerStatusAuthority';

import type { CapturedProviderManagement } from '../../../src/features/agent-backend/main';

function fixture() {
  let current = true;
  const value = {
    profileId: 'TEST-claude',
    configRevision: 'TEST-config',
    account: {
      apiProvider: 'firstParty',
      tokenSource: null,
      apiKeySource: 'environment',
      subscriptionType: null,
    },
    models: [
      {
        modelId: 'opus',
        resolvedModel: 'claude-opus-4-6',
        displayName: 'TEST Opus',
        description: 'TEST metadata',
        supportedEffortLevels: ['low', 'medium', 'high'],
        supportsFastMode: false,
      },
    ],
  };
  const request = vi.fn<CapturedProviderManagement['request']>(async (operation): ReturnType<CapturedProviderManagement['request']> => {
    if (operation === 'claude.metadata') return { ok: true, value };
    if (operation === 'claude.auth' || operation === 'extension.capture')
      return { ok: false, code: 'unavailable' };
    throw new Error('TEST unexpected management request');
  });
  const target: CapturedProviderManagement = {
    targetId: 'a'.repeat(64),
    profileId: value.profileId,
    configRevision: value.configRevision,
    isCurrent: () => current,
    request,
  };
  const captureClaude = vi.fn(async () => target);
  const capture = vi.fn(async () => {
    throw new Error('Wrong runtime capture');
  });
  const now = Date.now();
  const port = createCapturedRuntimeProviderStatusClient({
    capture,
    captureClaude,
    readHealth: async () => ({ buildId: 'TEST-host' }),
    now: () => now,
    captureGuard: () => () => current,
  });
  return {
    port,
    request,
    capture,
    captureClaude,
    target,
    value,
    now,
    stale: () => {
      current = false;
    },
  };
}

it('the existing model/effort consumers receive native SDK metadata with no inferred auth, default or launch readiness', async () => {
  const f = fixture();
  const status = await f.port.getProviderStatus('anthropic', { projectPath: '/TEST-workspace' });
  expect(f.captureClaude).toHaveBeenCalledWith('/TEST-workspace');
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.request.mock.calls).toEqual([
    ['claude.metadata', {}],
    ['claude.auth', {}],
    ['extension.capture', { panel: 'plugins', scope: 'project' }],
    ['extension.capture', { panel: 'mcp', scope: 'project' }],
  ]);
  expect(status).toMatchObject({
    authenticated: false,
    authMethod: null,
    canLoginFromUi: false,
    statusCheckOutcome: 'model_only',
    verificationState: 'unknown',
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: {
        plugins: { status: 'unsupported' },
        mcp: { status: 'unsupported' },
      },
    },
    models: ['claude-opus-4-6'],
    modelCatalog: {
      source: 'claude-sdk',
      defaultModelId: null,
      defaultLaunchModel: null,
      models: [
        { id: 'opus', launchModel: 'claude-opus-4-6', supportsFastMode: false, isDefault: false },
      ],
    },
  });
  expect(isProviderModelCatalogExactReady(status, f.now)).toBe(true);
  expect(
    getTeamEffortOptions({
      providerId: 'anthropic',
      providerStatus: status,
      model: 'claude-opus-4-6',
    }).map((item) => item.value)
  ).toEqual(['', 'low', 'medium', 'high']);
  expect(status.catalogScope).toMatch(/^[a-f0-9]{64}$/);
  expect(status.catalogScope).not.toBe(f.target.targetId);
  expect(JSON.stringify(status)).not.toContain('TEST-config');
  expect(JSON.stringify(status)).not.toContain('environment');
});

it('wrong profile, duplicate model rows and late context results never enter the existing UI', async () => {
  const wrong = fixture();
  wrong.value.configRevision = 'TEST-other';
  const duplicate = fixture();
  duplicate.value.models.push({ ...duplicate.value.models[0]! });
  const late = fixture();
  late.request.mockImplementationOnce(async () => {
    late.stale();
    return { ok: true, value: late.value };
  });
  for (const f of [wrong, duplicate, late]) {
    const status = await f.port.getProviderStatus('anthropic');
    expect(status.statusCheckOutcome).toBe('transient_error');
    expect(status.models).toEqual([]);
    expect(status.authenticated).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.capture).not.toHaveBeenCalled();
  }
});

it('native default and named aliases of the same canonical model yield one existing selector option', async () => {
  const f = fixture();
  f.value.models.unshift({
    ...f.value.models[0]!,
    modelId: 'default',
    displayName: 'TEST default',
  });
  const status = await f.port.getProviderStatus('anthropic');
  expect(status.models).toEqual(['claude-opus-4-6']);
  expect(status.modelCatalog?.models).toHaveLength(1);
  expect(status.modelCatalog?.models[0]).toMatchObject({
    id: 'opus',
    displayName: 'TEST Opus',
    launchModel: 'claude-opus-4-6',
  });
  expect(
    getTeamEffortOptions({ providerId: 'anthropic', providerStatus: status, model: 'opus' }).map(
      (item) => item.value
    )
  ).toEqual(['', 'low', 'medium', 'high']);
});

it.each([true, false])('independent native auth loggedIn=%s survives existing renderer reconciliation without granting launch', async (loggedIn) => {
  const f = fixture();
  f.request.mockImplementation(async (operation): ReturnType<CapturedProviderManagement['request']> => {
    if (operation === 'claude.metadata') return { ok: true, value: f.value };
    if (operation === 'claude.auth') return { ok: true, value: {
      profileId: f.target.profileId, configRevision: f.target.configRevision,
      loggedIn, authMethod: loggedIn ? 'api_key' : 'none', canLogin: false, canLogout: false,
    } };
    if (operation === 'extension.capture') return { ok: false, code: 'unavailable' };
    throw new Error('TEST unexpected management request');
  });
  const status = await f.port.getProviderStatus('anthropic');
  expect(status.authenticated).toBe(loggedIn);
  const rendered = reconcileCliProviderSnapshot(undefined, status);
  expect(rendered.authenticated).toBe(loggedIn);
  expect(rendered.authMethod).toBe(loggedIn ? 'api_key' : null);
  expect(status).toMatchObject({ statusCheckOutcome: 'authoritative', verificationState: 'verified',
    capabilities: { teamLaunch: false, oneShot: false }, modelVerificationState: 'idle' });
  expect(status.statusCheckErrorCode).toBeUndefined();
  expect(hasAuthoritativeProviderLaunchEvidence(status)).toBe(false);
  expect(hasAuthoritativeProviderLaunchEvidence(rendered)).toBe(false);
  const refreshed = reconcileCliProviderSnapshot(rendered, status);
  expect(refreshed.authenticated).toBe(loggedIn);
  expect(refreshed.capabilities.teamLaunch).toBe(false);
});

it('wrong auth revision and a context change during auth cannot create authoritative authentication', async () => {
  for (const mode of ['wrong-revision', 'changed-context']) {
    const f = fixture();
    f.request.mockImplementation(async (operation): ReturnType<CapturedProviderManagement['request']> => {
      if (operation === 'claude.metadata') return { ok: true, value: f.value };
      if (operation === 'claude.auth') {
        if (mode === 'changed-context') f.stale();
        return { ok: true, value: {
          profileId: f.target.profileId, configRevision: mode === 'wrong-revision' ? 'TEST-other-config' : f.target.configRevision,
          loggedIn: true, authMethod: 'api_key', canLogin: false, canLogout: false,
        } };
      }
      if (operation === 'extension.capture') return { ok: false, code: 'unavailable' };
      throw new Error('TEST unexpected management request');
    });
    const status = await f.port.getProviderStatus('anthropic');
    expect(status.authenticated).toBe(false);
    expect(status.statusCheckOutcome).toBe(mode === 'wrong-revision' ? 'model_only' : 'transient_error');
    expect(reconcileCliProviderSnapshot(undefined, status).authenticated).toBe(false);
    expect(hasAuthoritativeProviderLaunchEvidence(status)).toBe(false);
  }
});
