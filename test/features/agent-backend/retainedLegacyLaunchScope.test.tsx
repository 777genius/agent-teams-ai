import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRetainedLegacyLaunchClient } from '../../../src/features/agent-backend/renderer/retainedLegacyLaunch';
import {
  useRetainedLegacyLaunch,
  useRetainedLegacyProjectRebind,
} from '../../../src/features/agent-backend/renderer/RetainedLegacyLaunchContext';
import { RetainedLegacyLaunchScope } from '../../../src/features/agent-backend/renderer/RetainedLegacyLaunchScope';
import { useRetainedLegacyRuntimeStatus } from '../../../src/features/agent-backend/renderer/useRetainedLegacyRuntime';
import { useCodexAccountSnapshot } from '../../../src/features/codex-account/renderer/hooks/useCodexAccountSnapshot';
import { useEffectiveCliProviderStatus } from '../../../src/renderer/hooks/useEffectiveCliProviderStatus';
import { createLoadingMultimodelCliStatus, getCliProviderStatusScopeKey } from '../../../src/renderer/store/slices/cliInstallerSlice';
import { invalidateContextScopedRequestEpoch } from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import type {
  RetainedLegacyLaunchChoice,
  RetainedLegacyLaunchRequest,
  RetainedLegacyLaunchResult,
} from '../../../src/features/agent-backend/contracts/retainedLegacyLaunch';
import type { CodexAccountSnapshotDto } from '../../../src/features/codex-account/contracts';
import type { CliInstallationStatus, CliProviderStatus } from '../../../src/shared/types';

const ambient = vi.hoisted(() => ({
  agentBackend: undefined as unknown,
  getCodexAccountSnapshot: vi.fn(),
  refreshCodexAccountSnapshot: vi.fn(),
  onCodexAccountSnapshotChanged: vi.fn(() => () => undefined),
}));
vi.mock('@renderer/api', () => ({ api: ambient, isElectronMode: () => true }));
vi.mock('@features/agent-backend/renderer', async () => ({
  ...await import('../../../src/features/agent-backend/renderer/RetainedLegacyLaunchContext'),
  ...await import('../../../src/features/agent-backend/renderer/useRetainedLegacyRuntime'),
  ...await import('../../../src/features/agent-backend/renderer/retainedLegacyLaunch'),
}));
const storeState = {
  appConfig: { general: { multimodelEnabled: true } },
  cliStatus: null as CliInstallationStatus | null,
  cliStatusLoading: false,
  cliProviderStatusByScope: {} as Record<string, CliProviderStatus>,
};
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
type Transport = (request: RetainedLegacyLaunchRequest) => Promise<RetainedLegacyLaunchResult>;
const unknown = { ok: false, reason: 'outcome-unknown', outcome: 'unknown' } as const;
const unmounts = new Set<() => void>();
let sequence = 0;
function choice(): RetainedLegacyLaunchChoice {
  const id = ++sequence;
  return { mode: 'original-runtime', teamName: `TEST-scope-team-${id}`, scopeId: `TEST-dialog-${id}`,
    projectPath: '/TEST/original-project', expiresAt: Date.now() + 600_000 };
}
function cleanup(request: RetainedLegacyLaunchRequest): RetainedLegacyLaunchResult {
  if (request.action === 'close' || request.action === 'closeIntent')
    return { ok: true, action: request.action, value: null };
  throw new Error('Unexpected TEST action ' + request.action);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(selected: RetainedLegacyLaunchChoice, send: Transport, strict = false) {
  createRetainedLegacyLaunchClient(selected, send);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let client!: NonNullable<ReturnType<typeof useRetainedLegacyLaunch>>;
  let rebind!: NonNullable<ReturnType<typeof useRetainedLegacyProjectRebind>>;
  function Observer() {
    client = useRetainedLegacyLaunch()!;
    rebind = useRetainedLegacyProjectRebind()!;
    return null;
  }
  const unmount = () => { root.unmount(); host.remove(); unmounts.delete(unmount); };
  unmounts.add(unmount);
  return {
    host,
    get client() { return client; },
    get rebind() { return rebind; },
    async render(next = selected, child?: React.ReactNode) {
      await act(async () => {
        const content = <RetainedLegacyLaunchScope choice={next}><Observer />{child}</RetainedLegacyLaunchScope>;
        root.render(strict ? <StrictMode>{content}</StrictMode> : content);
      });
    },
    async unmount() { await act(async () => { unmount(); }); },
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  ambient.agentBackend = undefined;
  storeState.cliStatus = null;
  storeState.cliProviderStatusByScope = {};
  invalidateContextScopedRequestEpoch();
});
afterEach(async () => {
  await act(async () => { for (const unmount of unmounts) unmount(); });
  vi.unstubAllGlobals();
});

describe('original runtime React scope', () => {
  it('keeps its captured choice through effect replay and closes it on real unmount', async () => {
    const selected = choice(), send = vi.fn<Transport>(async request => cleanup(request));
    const view = fixture(selected, send, true);
    await view.render();
    expect(view.client.choice).toBe(selected);
    expect(send).not.toHaveBeenCalled();
    const replacement = vi.fn<Transport>(async () => unknown);
    ambient.agentBackend = { retainedLegacyLaunch: replacement };
    await view.unmount();
    expect(send).toHaveBeenCalledExactlyOnceWith({ action: 'close', scopeId: selected.scopeId });
    expect(replacement).not.toHaveBeenCalled();
  });

  it('closes the previous choice without closing its replacement and revokes the active context', async () => {
    const first = choice(), second = choice();
    const firstSend = vi.fn<Transport>(async request => cleanup(request));
    const secondSend = vi.fn<Transport>(async request => cleanup(request));
    const view = fixture(first, firstSend);
    await view.render();
    createRetainedLegacyLaunchClient(second, secondSend);
    await view.render(second);
    expect(firstSend).toHaveBeenCalledExactlyOnceWith({ action: 'close', scopeId: first.scopeId });
    expect(secondSend).not.toHaveBeenCalled();
    expect(view.client.choice).toBe(second);
    await act(async () => { invalidateContextScopedRequestEpoch(); });
    expect(secondSend).toHaveBeenCalledExactlyOnceWith({ action: 'close', scopeId: second.scopeId });
    await expect(view.client.read()).rejects.toMatchObject({ outcome: 'not-dispatched' });
  });

  it('adopts the Main-normalized project and gives its replacement the exact rebind intent', async () => {
    const selected = choice(), next = { ...selected, scopeId: selected.scopeId + '-next', projectPath: '/TEST/canonical-project' };
    const send = vi.fn<Transport>(async request => request.action === 'rebind'
      ? { ok: true, action: 'rebind', value: next } : cleanup(request));
    const view = fixture(selected, send), apply = vi.fn();
    await view.render();
    await act(async () => { await view.rebind(' /TEST/project-alias ', apply); });
    const request = send.mock.calls[0]![0];
    expect(request).toMatchObject({ action: 'rebind', scopeId: selected.scopeId, projectPath: '/TEST/project-alias' });
    if (request.action !== 'rebind') throw new Error('Missing original rebind');
    expect(apply).toHaveBeenCalledExactlyOnceWith(next.projectPath);
    expect(view.client.choice).toEqual(next);
    expect(send).toHaveBeenCalledWith({ action: 'close', scopeId: selected.scopeId });
    expect(send.mock.calls.filter(([value]) => value.action === 'closeIntent')).toHaveLength(0);
    await view.unmount();
    expect(send).toHaveBeenLastCalledWith({ action: 'closeIntent', teamName: selected.teamName, intentId: request.intentId });
  });

  it('recovers an unknown project change with the same intent and refuses another project', async () => {
    const selected = choice(), next = { ...selected, scopeId: selected.scopeId + '-next', projectPath: '/TEST/next' };
    let rebinds = 0;
    const send = vi.fn<Transport>(async request => request.action === 'rebind'
      ? (++rebinds === 1 ? unknown : { ok: true, action: 'rebind', value: next }) : cleanup(request));
    const view = fixture(selected, send), apply = vi.fn();
    await view.render();
    await expect(view.rebind(next.projectPath, apply)).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(view.rebind('/TEST/different', apply)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(rebinds).toBe(1);
    expect(apply).not.toHaveBeenCalled();
    await act(async () => { await view.rebind(next.projectPath, apply); });
    const requests = send.mock.calls.filter(([request]) => request.action === 'rebind');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(apply).toHaveBeenCalledExactlyOnceWith(next.projectPath);
  });

  it('closes a pending exact project intent and does not apply its late successful response', async () => {
    const selected = choice(), response = deferred<RetainedLegacyLaunchResult>();
    const send = vi.fn<Transport>(request => request.action === 'rebind' ? response.promise : Promise.resolve(cleanup(request)));
    const view = fixture(selected, send), apply = vi.fn();
    await view.render();
    const pending = view.rebind('/TEST/next', apply), rejected = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(view.rebind('/TEST/next', apply)).rejects.toMatchObject({ outcome: 'unknown' });
    const request = send.mock.calls[0]![0];
    if (request.action !== 'rebind') throw new Error('Missing original rebind');
    await view.unmount();
    expect(send).toHaveBeenCalledWith({ action: 'closeIntent', teamName: selected.teamName, intentId: request.intentId });
    response.resolve({ ok: true, action: 'rebind', value: { ...selected, scopeId: selected.scopeId + '-late', projectPath: '/TEST/next' } });
    await rejected;
    expect(apply).not.toHaveBeenCalled();
    expect(send.mock.calls.filter(([value]) => value.action === 'rebind')).toHaveLength(1);
    expect(send.mock.calls.filter(([value]) => value.action === 'closeIntent').every(([value]) =>
      value.action === 'closeIntent' && value.intentId === request.intentId)).toBe(true);
  });

  it('does not let an old pending completion clear a replacement choice recovery intent', async () => {
    const old = choice(), current = choice(), oldResponse = deferred<RetainedLegacyLaunchResult>();
    const oldSend = vi.fn<Transport>(request => request.action === 'rebind' ? oldResponse.promise : Promise.resolve(cleanup(request)));
    const next = { ...current, scopeId: current.scopeId + '-next', projectPath: '/TEST/new-next' };
    let attempts = 0;
    const currentSend = vi.fn<Transport>(async request => request.action === 'rebind'
      ? (++attempts === 1 ? unknown : { ok: true, action: 'rebind', value: next }) : cleanup(request));
    const view = fixture(old, oldSend), oldApply = vi.fn(), currentApply = vi.fn();
    await view.render();
    const pending = view.rebind('/TEST/old-next', oldApply), rejected = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    createRetainedLegacyLaunchClient(current, currentSend);
    await view.render(current);
    await expect(view.rebind(next.projectPath, currentApply)).rejects.toMatchObject({ outcome: 'unknown' });
    oldResponse.resolve({ ok: true, action: 'rebind', value: { ...old, scopeId: old.scopeId + '-late', projectPath: '/TEST/old-next' } });
    await rejected;
    await act(async () => { await view.rebind(next.projectPath, currentApply); });
    const requests = currentSend.mock.calls.filter(([request]) => request.action === 'rebind');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(oldApply).not.toHaveBeenCalled();
    expect(currentApply).toHaveBeenCalledExactlyOnceWith(next.projectPath);
    expect(view.client.choice).toEqual(next);
  });
});

function provider(model: string): CliProviderStatus {
  return {
    providerId: 'codex', displayName: 'TEST Codex', supported: true, authenticated: true,
    authMethod: 'chatgpt', verificationState: 'verified', statusCheckOutcome: 'authoritative',
    modelVerificationState: 'idle', modelCatalogRefreshState: 'ready', statusMessage: null, detailMessage: null,
    models: [model], modelAvailability: [], canLoginFromUi: false,
    capabilities: { teamLaunch: true, oneShot: false, extensions: {
      plugins: { status: 'unsupported', ownership: 'provider-scoped' },
      mcp: { status: 'supported', ownership: 'provider-scoped' },
      skills: { status: 'supported', ownership: 'provider-scoped' },
      apiKeys: { status: 'supported', ownership: 'provider-scoped' },
    } },
    selectedBackendId: 'codex-native', resolvedBackendId: 'codex-native', availableBackends: [],
    externalRuntimeDiagnostics: [], backend: { kind: 'codex-native', label: 'TEST Codex' }, connection: null,
    modelCatalog: { schemaVersion: 1, providerId: 'codex', source: 'static-fallback', status: 'ready',
      fetchedAt: new Date().toISOString(), staleAt: new Date(Date.now() + 600_000).toISOString(),
      defaultModelId: model, defaultLaunchModel: model,
      models: [{ id: model, launchModel: model, displayName: model, hidden: false, supportedReasoningEfforts: [],
        defaultReasoningEffort: null, inputModalities: ['text'], supportsPersonality: false, isDefault: true,
        upgrade: false, source: 'static-fallback' }], diagnostics: { configReadState: 'ready', appServerState: 'healthy' } },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } }, subscriptionRateLimits: null,
  };
}
function account(email: string): CodexAccountSnapshotDto {
  return { preferredAuthMode: 'chatgpt', effectiveAuthMode: 'chatgpt', launchAllowed: true,
    launchIssueMessage: null, launchReadinessState: 'ready_chatgpt', appServerState: 'healthy', appServerStatusMessage: null,
    managedAccount: { type: 'chatgpt', email, planType: 'pro' },
    apiKey: { available: false, source: null, sourceLabel: null }, requiresOpenaiAuth: false,
    login: { status: 'idle', error: null, startedAt: null }, rateLimits: null, updatedAt: new Date().toISOString() };
}

describe('original runtime effective provider and account hook integration', () => {
  it('shows only original models/account and clears status authority after its refresh fails', async () => {
    const selected = choice(), originalProvider = provider('TEST/original-model'), hostProvider = provider('TEST/host-model');
    const originalStatus = { ...createLoadingMultimodelCliStatus(), providers: [originalProvider] };
    const hostStatus = { ...createLoadingMultimodelCliStatus(), providers: [hostProvider] };
    const originalAccount = account('original@TEST.invalid'), hostAccount = account('host@TEST.invalid');
    storeState.cliStatus = hostStatus;
    storeState.cliProviderStatusByScope[getCliProviderStatusScopeKey('codex', selected.projectPath)] = hostProvider;
    ambient.getCodexAccountSnapshot.mockResolvedValue(hostAccount);
    ambient.refreshCodexAccountSnapshot.mockResolvedValue(hostAccount);
    let failStatus = false;
    const send = vi.fn<Transport>(async request => {
      if (request.action === 'status') {
        if (failStatus) throw new Error('TEST-original-status-unavailable');
        return { ok: true, action: 'status', value: originalStatus };
      }
      if (request.action === 'account') return { ok: true, action: 'account', value: originalAccount };
      return cleanup(request);
    });
    let effective!: ReturnType<typeof useEffectiveCliProviderStatus>;
    let original!: ReturnType<typeof useRetainedLegacyRuntimeStatus>;
    let codexAccount!: ReturnType<typeof useCodexAccountSnapshot>;
    function ActualHooks() {
      effective = useEffectiveCliProviderStatus('codex', { projectPath: selected.projectPath });
      original = useRetainedLegacyRuntimeStatus(selected.projectPath);
      codexAccount = useCodexAccountSnapshot({ enabled: true });
      return <div>{effective.providerStatus?.models.join(',')} {codexAccount.snapshot?.managedAccount?.email}</div>;
    }
    const view = fixture(selected, send);
    await view.render(selected, <ActualHooks />);
    expect(effective.providerStatus?.models).toEqual(['TEST/original-model']);
    expect(effective.providerStatus?.capabilities.teamLaunch).toBe(true);
    expect(effective.providerStatus?.connection?.codex?.managedAccount?.email).toBe('original@TEST.invalid');
    expect(codexAccount.snapshot).toBe(originalAccount);
    expect(view.host.textContent).toContain('TEST/original-model original@TEST.invalid');
    expect(view.host.textContent).not.toContain('TEST/host-model');
    expect(send.mock.calls.filter(([request]) => request.action === 'status')).toHaveLength(1);
    expect(send.mock.calls.filter(([request]) => request.action === 'account')).toHaveLength(1);
    failStatus = true;
    await act(async () => { expect(await original.refresh()).toBe(false); });
    expect(original.status).toBeNull();
    expect(original.error).toBeTruthy();
    expect(effective.sourceCliStatus).toBeNull();
    expect(effective.providerStatus).toBeNull();
    expect(view.host.textContent).not.toContain('TEST/host-model');
    expect(codexAccount.snapshot).toBe(originalAccount);
    expect(storeState.cliStatus).toBe(hostStatus);
    expect(ambient.getCodexAccountSnapshot).not.toHaveBeenCalled();
    expect(ambient.refreshCodexAccountSnapshot).not.toHaveBeenCalled();
    expect(ambient.onCodexAccountSnapshotChanged).not.toHaveBeenCalled();
  });
});
