import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { createRetainedLegacyLaunchClient } from '@features/agent-backend/renderer';
import { TeamModelProviderActions } from '@renderer/components/team/dialogs/TeamModelProviderActions';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RetainedLegacyLaunchScope } from '../../../../../src/features/agent-backend/renderer/RetainedLegacyLaunchScope';
import { useRetainedLegacyAccount } from '../../../../../src/features/agent-backend/renderer/useRetainedLegacyRuntime';

import type {
  RetainedLegacyLaunchChoice,
  RetainedLegacyLaunchRequest,
  RetainedLegacyLaunchResult,
} from '@features/agent-backend/contracts/retainedLegacyLaunch';
import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CliInstallationStatus, CliProviderStatus, TeamProviderId } from '@shared/types';

const ambient = vi.hoisted(() => ({
  getCodexAccountSnapshot: vi.fn(),
  refreshCodexAccountSnapshot: vi.fn(),
  onCodexAccountSnapshotChanged: vi.fn(() => () => undefined),
}));
vi.mock('@renderer/api', () => ({ api: ambient, isElectronMode: () => true }));
vi.mock('@features/agent-backend/renderer', async () => ({
  ...await import('../../../../../src/features/agent-backend/renderer/RetainedLegacyLaunchContext'),
  ...await import('../../../../../src/features/agent-backend/renderer/useRetainedLegacyRuntime'),
  ...await import('../../../../../src/features/agent-backend/renderer/retainedLegacyLaunch'),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/components/team/dialogs/OpenCodeSourceDirectoryProvider', () => ({
  useOpenCodeSourceDirectory: () => null,
}));
const storeState = {
  appConfig: { general: { multimodelEnabled: true } },
  cliStatus: null as CliInstallationStatus | null,
  cliStatusLoading: false,
  cliStatusError: null,
  cliProviderStatusByScope: {} as Record<string, CliProviderStatus>,
  openCodeRuntimeError: null,
  codexRuntimeError: null,
  openSettingsTab: vi.fn(),
  invalidateCliStatus: vi.fn(async () => undefined),
  fetchCliStatus: vi.fn(async () => undefined),
  fetchCliProviderStatus: vi.fn(async () => true),
  invalidateOpenCodeRuntimeStatus: vi.fn(async () => undefined),
  fetchOpenCodeRuntimeStatus: vi.fn(async () => undefined),
  invalidateCodexRuntimeStatus: vi.fn(async () => undefined),
  fetchCodexRuntimeStatus: vi.fn(async () => undefined),
};
vi.mock('@renderer/store', () => ({
  useStore: Object.assign((selector: (state: typeof storeState) => unknown) => selector(storeState), {
    getState: () => storeState,
  }),
}));

type Transport = (request: RetainedLegacyLaunchRequest) => Promise<RetainedLegacyLaunchResult>;
const unmounts = new Set<() => void>();
let sequence = 0;
function account(): CodexAccountSnapshotDto {
  return {
    preferredAuthMode: 'chatgpt', effectiveAuthMode: 'chatgpt', launchAllowed: true,
    launchIssueMessage: null, launchReadinessState: 'ready_chatgpt', appServerState: 'healthy',
    appServerStatusMessage: null, managedAccount: { type: 'chatgpt', email: 'original@TEST.invalid', planType: 'pro' },
    apiKey: { available: false, source: null, sourceLabel: null }, requiresOpenaiAuth: false,
    login: { status: 'idle', error: null, startedAt: null }, rateLimits: null, updatedAt: new Date().toISOString(),
  };
}
function fixture(retained = true, loadAccount = async () => account()) {
  const id = ++sequence;
  const choice: RetainedLegacyLaunchChoice | undefined = retained ? {
    mode: 'original-runtime', teamName: `TEST-account-team-${id}`, scopeId: `TEST-account-scope-${id}`,
    projectPath: '/TEST/original-project', expiresAt: Date.now() + 600_000,
  } : undefined;
  const send = vi.fn<Transport>(async request => {
    if (request.action === 'status')
      return { ok: true, action: 'status', value: createLoadingMultimodelCliStatus() };
    if (request.action === 'account') return { ok: true, action: 'account', value: await loadAccount() };
    if (request.action === 'opencodeRuntime')
      return { ok: true, action: 'opencodeRuntime', value: { installed: false, source: 'missing', state: 'idle' } };
    if (request.action === 'codexRuntime')
      return { ok: true, action: 'codexRuntime', value: {
        installed: false, source: 'missing', state: 'idle', latestVersion: null, updateAvailable: false,
      } };
    if (request.action === 'close') return { ok: true, action: 'close', value: null };
    throw new Error('Unexpected TEST action ' + request.action);
  });
  if (choice) createRetainedLegacyLaunchClient(choice, send);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const unmount = () => { root.unmount(); host.remove(); unmounts.delete(unmount); };
  unmounts.add(unmount);
  return {
    host, send, choice,
    get accountReads() { return send.mock.calls.filter(([request]) => request.action === 'account'); },
    async render(children: React.ReactNode) {
      await act(async () => {
        root.render(<RetainedLegacyLaunchScope choice={choice}><TooltipProvider>{children}</TooltipProvider></RetainedLegacyLaunchScope>);
      });
    },
    async refresh() {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="team-model-selector-refresh-providers"]')!.click();
      });
    },
  };
}
function Toolbar({ providerId = 'anthropic' }: { providerId?: TeamProviderId }) {
  return <TeamModelProviderActions providerId={providerId} projectPath="/TEST/original-project" />;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  storeState.cliStatus = createLoadingMultimodelCliStatus();
  storeState.cliProviderStatusByScope = {};
  ambient.getCodexAccountSnapshot.mockResolvedValue(account());
  ambient.refreshCodexAccountSnapshot.mockResolvedValue(account());
  invalidateContextScopedRequestEpoch();
});
afterEach(async () => {
  await act(async () => { for (const unmount of unmounts) unmount(); });
  vi.unstubAllGlobals();
});

describe('retained provider actions account admission', () => {
  it.each(['anthropic', 'opencode'] as const)('does not read Codex account when the %s toolbar mounts', async providerId => {
    const view = fixture();
    await view.render(<Toolbar providerId={providerId} />);
    expect(view.accountReads).toHaveLength(0);
    expect(view.send.mock.calls.some(([request]) => request.action === 'status')).toBe(true);
    expect(ambient.getCodexAccountSnapshot).not.toHaveBeenCalled();
  });

  it('keeps explicit Refresh and publishes its account through the same original resource', async () => {
    const view = fixture();
    let observed!: ReturnType<typeof useRetainedLegacyAccount>;
    function PassiveAccount() {
      observed = useRetainedLegacyAccount(true, { loadOnMount: false });
      return <div>{observed.snapshot?.managedAccount?.email}</div>;
    }
    await view.render(<><Toolbar /><PassiveAccount /></>);
    expect(view.accountReads).toHaveLength(0);
    expect(observed.snapshot).toBeNull();
    await view.refresh();
    expect(view.accountReads).toEqual([[{ action: 'account', scopeId: view.choice!.scopeId }]]);
    expect(view.host.textContent).toContain('original@TEST.invalid');
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(ambient.getCodexAccountSnapshot).not.toHaveBeenCalled();
    expect(ambient.refreshCodexAccountSnapshot).not.toHaveBeenCalled();
    await view.refresh();
    expect(view.accountReads).toHaveLength(2);
    expect(view.accountReads.every(([request]) => 'scopeId' in request && request.scopeId === view.choice!.scopeId)).toBe(true);
  });

  it('loads Codex for the effective selected or inspected provider and reuses it when switching back', async () => {
    const view = fixture();
    function EffectiveProvider({ providerId }: { providerId: TeamProviderId }) {
      useEffectiveCliProviderStatus(providerId, { projectPath: '/TEST/original-project' });
      return null;
    }
    await view.render(<><Toolbar /><EffectiveProvider providerId="anthropic" /></>);
    expect(view.accountReads).toHaveLength(0);
    await view.render(<><Toolbar /><EffectiveProvider providerId="codex" /></>);
    expect(view.accountReads).toHaveLength(1);
    await view.render(<><Toolbar /><EffectiveProvider providerId="anthropic" /></>);
    await view.render(<><Toolbar /><EffectiveProvider providerId="codex" /></>);
    expect(view.accountReads).toHaveLength(1);
    expect(ambient.getCodexAccountSnapshot).not.toHaveBeenCalled();
  });

  it('preserves default eager account consumers when a passive subscription is already mounted', async () => {
    const view = fixture();
    function Account({ eager }: { eager: boolean }) {
      const value = useRetainedLegacyAccount(true, eager ? undefined : { loadOnMount: false });
      return <div>{value.snapshot?.managedAccount?.email}</div>;
    }
    await view.render(<Account eager={false} />);
    expect(view.accountReads).toHaveLength(0);
    await view.render(<Account eager />);
    expect(view.accountReads).toHaveLength(1);
    expect(view.host.textContent).toContain('original@TEST.invalid');
  });

  it('rejects a late explicit account result after scope revocation and sends no further reads', async () => {
    let resolve!: (value: CodexAccountSnapshotDto) => void;
    const pending = new Promise<CodexAccountSnapshotDto>(yes => { resolve = yes; });
    const view = fixture(true, () => pending);
    let observed!: ReturnType<typeof useRetainedLegacyAccount>;
    function PassiveAccount() {
      observed = useRetainedLegacyAccount(true, { loadOnMount: false });
      return <div>{observed.snapshot?.managedAccount?.email}</div>;
    }
    await view.render(<><Toolbar /><PassiveAccount /></>);
    expect(view.accountReads).toHaveLength(0);
    await view.refresh();
    expect(view.accountReads).toHaveLength(1);
    await act(async () => { invalidateContextScopedRequestEpoch(); resolve(account()); });
    expect(observed.snapshot).toBeNull();
    expect(view.host.textContent).not.toContain('original@TEST.invalid');
    await view.refresh();
    expect(view.accountReads).toHaveLength(1);
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(ambient.getCodexAccountSnapshot).not.toHaveBeenCalled();
    expect(ambient.refreshCodexAccountSnapshot).not.toHaveBeenCalled();
  });

  it('keeps nonretained Refresh on the existing provider and installer actions', async () => {
    const view = fixture(false);
    await view.render(<Toolbar providerId="codex" />);
    await view.refresh();
    expect(view.send).not.toHaveBeenCalled();
    expect(storeState.invalidateCliStatus).toHaveBeenCalledTimes(1);
    expect(storeState.fetchCliStatus).toHaveBeenCalledTimes(1);
    expect(storeState.fetchOpenCodeRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(storeState.fetchCodexRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('codex', { checkReason: 'manual_refresh' });
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
  });
});
