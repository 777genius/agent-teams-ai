import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, expect, it, vi } from 'vitest';

import { useOpenCodePassiveStatusPrefetch } from './useOpenCodePassiveStatusPrefetch';

const storeSnapshot = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(storeSnapshot.current),
}));

afterEach(() => {
  storeSnapshot.current = {};
  vi.unstubAllGlobals();
});

interface CatalogRecovery {
  projectPath: string;
  freshUntil: string;
}

function recoveryFixture() {
  const projectPath = '/sandbox/opencode-picker-recovery-test';
  const failedStatus = {
    providerId: 'opencode',
    supported: false,
    authenticated: false,
    statusCheckOutcome: 'transient_error',
    statusCheckErrorCode: 'unavailable',
    modelCatalogRefreshState: 'idle',
    modelCatalog: null,
    capabilities: { teamLaunch: false },
  };
  const fetchCliProviderStatus = vi.fn(async () => false);
  storeSnapshot.current = {
    cliStatus: { flavor: 'agent_teams_orchestrator' },
    openCodeRuntimeStatus: { installed: true, state: 'ready' },
    cliProviderStatusScopeRevision: 0,
    cliProviderStatusByScope: {
      [getCliProviderStatusScopeKey('opencode', projectPath)]: failedStatus,
    },
    fetchCliProviderStatus,
  };
  return { projectPath, failedStatus, fetchCliProviderStatus };
}

it('rechecks a failed project status once after a fresh scoped catalog without granting launch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { projectPath, failedStatus, fetchCliProviderStatus } = recoveryFixture();
  const root = createRoot(document.createElement('div'));
  const Probe = ({ receipt }: { receipt: CatalogRecovery | null }): null => {
    useOpenCodePassiveStatusPrefetch({ enabled: true, projectPath, catalogRecovery: receipt });
    return null;
  };
  try {
    await act(async () => root.render(<Probe receipt={null} />));
    expect(fetchCliProviderStatus).not.toHaveBeenCalled();

    const receipt = { projectPath, freshUntil: new Date(Date.now() + 60_000).toISOString() };
    await act(async () => root.render(<Probe receipt={receipt} />));
    expect(fetchCliProviderStatus).toHaveBeenCalledExactlyOnceWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath,
    });
    expect(failedStatus.capabilities.teamLaunch).toBe(false);
    expect(failedStatus.statusCheckOutcome).toBe('transient_error');

    // Another successful catalog while the retry still fails must not start a loop.
    await act(async () =>
      root.render(
        <Probe receipt={{ ...receipt, freshUntil: new Date(Date.now() + 120_000).toISOString() }} />
      )
    );
    expect(fetchCliProviderStatus).toHaveBeenCalledTimes(1);

    storeSnapshot.current.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', projectPath)]: {
        ...failedStatus,
        statusCheckOutcome: 'authoritative',
        statusCheckErrorCode: undefined,
      },
    };
    await act(async () => root.render(<Probe receipt={receipt} />));
    storeSnapshot.current.cliProviderStatusByScope = {
      [getCliProviderStatusScopeKey('opencode', projectPath)]: failedStatus,
    };
    await act(async () => root.render(<Probe receipt={receipt} />));
    expect(fetchCliProviderStatus).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(['expired', 'other-project', 'runtime-failed', 'project-missing', 'disabled'])(
  'does not authorize a recovery retry for %s evidence',
  async (scenario) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const { projectPath, failedStatus, fetchCliProviderStatus } = recoveryFixture();
    const receipt = {
      projectPath: scenario === 'other-project' ? '/sandbox/another-project' : projectPath,
      freshUntil: new Date(Date.now() + (scenario === 'expired' ? -1_000 : 60_000)).toISOString(),
    };
    if (scenario === 'runtime-failed')
      storeSnapshot.current.openCodeRuntimeStatus = { installed: true, state: 'failed' };
    if (scenario === 'project-missing') failedStatus.statusCheckErrorCode = 'project_missing';
    const root = createRoot(document.createElement('div'));
    const Probe = (): null => {
      useOpenCodePassiveStatusPrefetch({
        enabled: scenario !== 'disabled',
        projectPath,
        catalogRecovery: receipt,
      });
      return null;
    };
    try {
      await act(async () => root.render(<Probe />));
      expect(fetchCliProviderStatus).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  }
);

it('recovers a stored partial OpenCode status left behind by an interrupted request', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const projectPath = '/sandbox/opencode-picker-prefetch-test';
  const fetchCliProviderStatus = vi.fn(async () => false);
  storeSnapshot.current = {
    cliStatus: { flavor: 'agent_teams_orchestrator' },
    cliProviderStatusScopeRevision: 0,
    cliProviderStatusByScope: {
      [getCliProviderStatusScopeKey('opencode', projectPath)]: {
        providerId: 'opencode',
        statusCheckOutcome: 'pending',
        statusCheckErrorCode: 'partial_response',
        modelCatalogRefreshState: 'idle',
        modelCatalog: null,
      },
    },
    fetchCliProviderStatus,
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  const Probe = (): null => {
    useOpenCodePassiveStatusPrefetch({ enabled: true, projectPath });
    return null;
  };
  try {
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    expect(fetchCliProviderStatus).toHaveBeenCalledExactlyOnceWith('opencode', {
      silent: true,
      checkReason: 'launch_preflight',
      projectPath,
    });
  } finally {
    await act(async () => root.unmount());
  }
});
