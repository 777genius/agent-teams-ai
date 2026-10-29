import { describe, expect, it } from 'vitest';

import {
  canLoadOpenCodeDashboardCatalog,
  hasAvailableFreeOpenCodeDashboardModel,
} from './openCodeDashboardCatalogPolicy';

import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

describe('OpenCode dashboard catalog detection gate', () => {
  it('waits for V2 support even when a stale provider or native binary is detected', () => {
    const provider = {
      providerId: 'opencode',
      supported: true,
      externalRuntimeDiagnostics: [{ id: 'opencode-managed-runtime', detected: true }],
    } as unknown as CliProviderStatus;
    const runtime = {
      installed: true,
      state: 'idle',
      source: 'managed',
      version: '2.1.4',
      v2Support: 'required',
    } as OpenCodeRuntimeStatus;
    expect(canLoadOpenCodeDashboardCatalog(provider, runtime)).toBe(false);
    expect(
      canLoadOpenCodeDashboardCatalog(provider, { ...runtime, state: 'ready', v2Support: 'ready' })
    ).toBe(true);
  });
  it.each(['opencode-live-host', 'opencode-managed-runtime'])(
    'permits read-only catalogs with %s evidence despite passive missing metadata',
    (id) => {
      const provider = {
        providerId: 'opencode',
        supported: false,
        authenticated: false,
        capabilities: { teamLaunch: false },
        externalRuntimeDiagnostics: [{ id, detected: true }],
      } as unknown as CliProviderStatus;
      expect(canLoadOpenCodeDashboardCatalog(provider, null)).toBe(true);
      expect(provider.supported).toBe(false);
      expect(provider.capabilities.teamLaunch).toBe(false);
    }
  );
  it('does not treat unrelated or negative detection as permission to query', () => {
    const provider = {
      supported: false,
      externalRuntimeDiagnostics: [
        { id: 'opencode-live-host', detected: false },
        { id: 'codex', detected: true },
      ],
    } as unknown as CliProviderStatus;
    expect(canLoadOpenCodeDashboardCatalog(provider, null)).toBe(false);
    expect(canLoadOpenCodeDashboardCatalog(null, null)).toBe(false);
  });
});

describe('OpenCode V2 verified free availability', () => {
  const runtime = {
    installed: true,
    state: 'ready',
    source: 'managed',
    version: '2.1.4',
    v2Support: 'ready',
  } as OpenCodeRuntimeStatus;
  const provider = (proofState: 'verified' | 'needs_probe' | 'failed') =>
    ({
      providerId: 'opencode',
      supported: true,
      authenticated: false,
      models: ['opencode/big-pickle'],
      modelCatalog: {
        providerId: 'opencode',
        status: 'ready',
        models: [
          {
            id: 'opencode/big-pickle',
            launchModel: 'opencode/big-pickle',
            label: 'Big Pickle',
            metadata: {
              free: true,
              opencode: {
                providerId: 'opencode',
                modelId: 'big-pickle',
                routeKind: 'builtin_free',
                accessKind: 'builtin_free',
                requiresExecutionProof: true,
                proofState,
              },
            },
          },
        ],
      },
    }) as unknown as CliProviderStatus;

  it('shows a genuinely verified V2 free model without requiring a provider credential', () => {
    expect(hasAvailableFreeOpenCodeDashboardModel(provider('verified'), runtime)).toBe(true);
  });
  it('accepts a completed display-only catalog without promoting it to launch-ready', () => {
    const status = provider('verified');
    status.modelCatalog!.status = 'degraded';
    status.modelCatalogRefreshState = 'ready';
    expect(hasAvailableFreeOpenCodeDashboardModel(status, runtime)).toBe(true);
    expect(status.modelCatalog!.status).toBe('degraded');
  });
  it.each(['loading', 'error'] as const)(
    'rejects %s connected catalog reads even when a retained model was verified',
    (state) => {
      const status = provider('verified');
      status.modelCatalog!.status = 'degraded';
      status.modelCatalogRefreshState = state;
      expect(hasAvailableFreeOpenCodeDashboardModel(status, runtime)).toBe(false);
    }
  );
  it.each(['pending', 'transient_error'] as const)(
    'rejects retained proof from a %s status even after a model catalog reload',
    (state) => {
      const status = provider('verified');
      status.modelCatalog!.status = 'degraded';
      status.modelCatalogRefreshState = 'ready';
      status.statusCheckOutcome = state;
      expect(hasAvailableFreeOpenCodeDashboardModel(status, runtime)).toBe(false);
    }
  );
  it.each(['needs_probe', 'failed'] as const)(
    'does not turn %s pricing into confirmed availability',
    (state) => {
      expect(hasAvailableFreeOpenCodeDashboardModel(provider(state), runtime)).toBe(false);
    }
  );
  it('does not reuse a verified free model when the V2 support installation is missing', () => {
    expect(
      hasAvailableFreeOpenCodeDashboardModel(provider('verified'), {
        ...runtime,
        v2Support: 'required',
      })
    ).toBe(false);
  });
});
