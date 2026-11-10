import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderLaunchAuthorityNotice } from './ProviderLaunchAuthorityNotice';
import { createLaunchGuard } from './providerLaunchAuthority';

import type { CliProviderStatus } from '@shared/types';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

function scopedRefresh(providerId: 'anthropic' | 'codex'): CliProviderStatus {
  return {
    ...createLoadingMultimodelCliStatus().providers.find(
      (provider) => provider.providerId === providerId
    )!,
    supported: true,
    authenticated: false,
    verificationState: 'unknown',
    statusCheckOutcome: 'pending',
    statusCheckErrorCode: 'partial_response',
    modelCatalogRefreshState: 'loading',
  };
}

describe('provider launch authority refresh presentation', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a scoped refresh as Checking while launch remains blocked, then exposes a settled failure', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (
      providers: CliProviderStatus[],
      providerLoading: Partial<Record<CliProviderStatus['providerId'], boolean>> = {}
    ): void => {
      const guard = createLaunchGuard(
        providers.map((provider) => provider.providerId),
        new Map(providers.map((provider) => [provider.providerId, provider]))
      );
      expect(guard.blocked(true)).toBe(true);
      act(() =>
        root.render(
          <ProviderLaunchAuthorityNotice
            id="provider-notice"
            action="launch"
            blockers={guard.blockers(true)}
            onOpenProviderSettings={() => undefined}
            providerLoading={providerLoading}
          />
        )
      );
    };
    try {
      render([scopedRefresh('anthropic')]);
      expect(host.querySelector('[role="status"]')?.textContent).toContain(
        'launch.prepare.checkingProviders'
      );
      expect(host.querySelector('[role="status"] svg')).not.toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.textContent).not.toContain('launch.prepare.blocked');

      const now = Date.now();
      const freshButGated: CliProviderStatus = {
        ...scopedRefresh('anthropic'),
        authenticated: true,
        verificationState: 'verified',
        statusCheckOutcome: 'authoritative',
        statusCheckErrorCode: undefined,
        modelCatalogRefreshState: 'ready',
        // The strict launch gate may still be settling while another real check
        // owns loading. Fresh display evidence does not bypass that gate.
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'anthropic',
          source: 'app-server',
          status: 'ready',
          fetchedAt: new Date(now - 1000).toISOString(),
          staleAt: new Date(now + 60_000).toISOString(),
          defaultModelId: 'opus',
          defaultLaunchModel: 'opus',
          diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
          models: [
            {
              id: 'opus',
              launchModel: 'opus',
              displayName: 'Opus',
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              inputModalities: ['text'],
              supportsPersonality: false,
              isDefault: true,
              upgrade: false,
              source: 'app-server',
            },
          ],
        },
      };
      render([freshButGated], { anthropic: true });
      expect(host.querySelector('[role="status"]')).not.toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      render([freshButGated], { anthropic: false });
      expect(host.querySelector('[role="alert"]')).not.toBeNull();

      const failure: CliProviderStatus = {
        ...scopedRefresh('codex'),
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'unavailable',
        modelCatalogRefreshState: 'error',
      };
      render([failure]);
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      expect(host.textContent).toContain('launch.prepare.blocked');

      // One active refresh must not conceal another selected provider's failure.
      render([scopedRefresh('anthropic'), failure]);
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      expect(host.textContent).toContain('launch.prepare.someProvidersNeedAttention');
    } finally {
      act(() => root.unmount());
    }
  });
});
