// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createCapturedRuntimeProviderStatusClient } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient';
import type { CapturedProviderManagement } from '../../../src/features/agent-backend/main';

function fixture() {
  let current = true;
  const request = vi.fn(async () => ({
    ok: true,
    value: {
      profileId: 'TEST-profile',
      configRevision: 'TEST-config',
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
  expect(f.request.mock.calls).toHaveLength(1);
  expect(status.catalogScope).toMatch(/^[a-f0-9]{64}$/);
  expect(status.catalogScope).not.toBe('a'.repeat(64));
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
