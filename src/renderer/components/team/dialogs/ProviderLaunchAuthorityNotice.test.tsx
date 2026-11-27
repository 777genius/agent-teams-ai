import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import * as runtimeLoading from '@renderer/utils/teamProviderRuntimeStatusLoading';
import {
  createProviderLaunchAuthorityMarker,
  PROVIDER_LAUNCH_AUTHORITY_MARKER_ATTRIBUTE,
  PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT,
  readProviderLaunchAuthorityMarker,
  UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER,
} from '@shared/utils/providerLaunchAuthorityMarker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLaunchGuard } from './providerLaunchAuthority';
import { ProviderLaunchAuthorityNotice } from './ProviderLaunchAuthorityNotice';

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

function markerInputs() {
  const status = {
    providerId: 'anthropic',
    supported: true,
    authenticated: false,
    verificationState: 'unknown',
    statusCheckOutcome: 'pending',
    statusCheckErrorCode: 'partial_response',
    modelCatalogRefreshState: 'loading',
    modelVerificationState: 'verifying',
    capabilities: { teamLaunch: false },
    modelCatalog: { schemaVersion: 1, providerId: 'anthropic', status: 'stale' },
  };
  const blockers = [{ providerId: 'anthropic', providerStatus: status }];
  const checks = [{ providerId: 'anthropic', status: 'checking' }];
  const loading = { anthropic: true };
  return { status, blockers, checks, loading };
}

describe('closed provider notice marker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('projects the original checking render without another authority/status calculation', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div'),
      root = createRoot(host);
    const provider = scopedRefresh('anthropic');
    const guard = createLaunchGuard(['anthropic'], new Map([['anthropic', provider]]));
    const blockers = guard.blockers(true);
    const originalCheck = vi.spyOn(runtimeLoading, 'isTeamProviderRuntimeStatusLoading');
    const settings = vi.fn();
    try {
      act(() =>
        root.render(
          <ProviderLaunchAuthorityNotice
            id="provider-notice"
            action="launch"
            blockers={blockers}
            providerLoading={{ anthropic: true }}
            onOpenProviderSettings={settings}
          />
        )
      );
      const notice = host.querySelector('#provider-notice');
      expect(notice?.getAttribute('role')).toBe('status');
      expect(notice?.textContent).toBe('launch.prepare.checkingProviders');
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(originalCheck).toHaveBeenCalledTimes(1);
      expect(settings).not.toHaveBeenCalled();
      const marker = notice?.getAttribute(PROVIDER_LAUNCH_AUTHORITY_MARKER_ATTRIBUTE);
      expect(readProviderLaunchAuthorityMarker(marker)).toBe(marker);
      expect(JSON.parse(marker!).providers[0]).toEqual({
        provider: 'anthropic',
        check: 'checking',
        loading: true,
        supported: true,
        authenticated: false,
        teamLaunch: provider.capabilities.teamLaunch,
        outcome: 'pending',
        error: 'partial_response',
        verification: 'unknown',
        refresh: 'loading',
        modelCheck: provider.modelVerificationState ?? null,
        catalog: provider.modelCatalog?.status ?? null,
      });
      expect(guard.blocked(true)).toBe(true); // The marker never admits Create.
      expect(originalCheck).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('copies only closed own data and never reads raw details, models, credentials or a clock', () => {
    const input = markerInputs();
    let privateReads = 0;
    for (const value of [
      input.blockers[0],
      input.checks[0],
      input.status,
      input.status.modelCatalog,
    ]) {
      for (const key of [
        'details',
        'detail',
        'message',
        'models',
        'account',
        'path',
        'fetchedAt',
        'staleAt',
        'toJSON',
        'canSkipPreflight',
        'permits',
        'readiness',
      ]) {
        Object.defineProperty(value, key, {
          get() {
            privateReads++;
            throw new Error('PRIVATE');
          },
        });
      }
    }
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('no diagnostic clock');
    });
    const marker = createProviderLaunchAuthorityMarker(input.blockers, input.checks, input.loading);
    expect(marker).not.toBe(UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER);
    expect(readProviderLaunchAuthorityMarker(marker)).toBe(marker);
    expect(JSON.parse(marker)).toEqual({
      v: 1,
      state: 'observed',
      providers: [
        {
          provider: 'anthropic',
          check: 'checking',
          loading: true,
          supported: true,
          authenticated: false,
          teamLaunch: false,
          outcome: 'pending',
          error: 'partial_response',
          verification: 'unknown',
          refresh: 'loading',
          modelCheck: 'verifying',
          catalog: 'stale',
        },
      ],
    });
    expect(privateReads).toBe(0);
    expect(marker).not.toMatch(
      /PRIVATE|details|models|account|path|fetchedAt|staleAt|permits|readiness/
    );
    expect(marker).toMatch(/^[\x20-\x7e]+$/);
    expect(marker.length).toBeLessThanOrEqual(PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT);
  });

  it('retains an absent status as unknown fields, never fabricated launch readiness', () => {
    const marker = createProviderLaunchAuthorityMarker(
      [{ providerId: 'codex', providerStatus: null }],
      [{ providerId: 'codex', status: 'failed' }],
      {}
    );
    expect(JSON.parse(marker)).toEqual({
      v: 1,
      state: 'observed',
      providers: [
        {
          provider: 'codex',
          check: 'failed',
          loading: null,
          supported: null,
          authenticated: null,
          teamLaunch: null,
          outcome: null,
          error: null,
          verification: null,
          refresh: null,
          modelCheck: null,
          catalog: null,
        },
      ],
    });
  });

  it('refuses accessors and thrown descriptors without invoking or forwarding them', () => {
    for (const location of [
      'blocker',
      'check',
      'loading',
      'status',
      'capabilities',
      'catalog',
      'index',
    ] as const) {
      const input = markerInputs();
      let reads = 0;
      const [target, key]: [object, string] =
        location === 'blocker'
          ? [input.blockers[0], 'providerStatus']
          : location === 'check'
            ? [input.checks[0], 'status']
            : location === 'loading'
              ? [input.loading, 'anthropic']
              : location === 'status'
                ? [input.status, 'authenticated']
                : location === 'capabilities'
                  ? [input.status.capabilities, 'teamLaunch']
                  : location === 'catalog'
                    ? [input.status.modelCatalog, 'status']
                    : [input.blockers, '0'];
      Object.defineProperty(target, key, {
        get() {
          reads++;
          throw new Error('PRIVATE-accessor');
        },
      });
      expect(createProviderLaunchAuthorityMarker(input.blockers, input.checks, input.loading)).toBe(
        UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER
      );
      expect(reads).toBe(0);
    }
    const input = markerInputs();
    const broken = new Proxy(input.loading, {
      getOwnPropertyDescriptor() {
        throw new Error('PRIVATE-descriptor');
      },
    });
    expect(createProviderLaunchAuthorityMarker(input.blockers, input.checks, broken)).toBe(
      UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER
    );
  });

  it('refuses mismatched identities, duplicate providers, malformed values and overflow', () => {
    for (const mutate of [
      (value: ReturnType<typeof markerInputs>) => {
        value.checks[0].providerId = 'codex';
      },
      (value: ReturnType<typeof markerInputs>) => {
        value.status.providerId = 'codex';
      },
      (value: ReturnType<typeof markerInputs>) => {
        value.status.statusCheckOutcome = 'PRIVATE';
      },
      (value: ReturnType<typeof markerInputs>) => {
        value.status.statusCheckErrorCode = 'PRIVATE';
      },
      (value: ReturnType<typeof markerInputs>) => {
        value.status.modelCatalog.status = 'PRIVATE';
      },
      (value: ReturnType<typeof markerInputs>) => {
        value.status.modelCatalog.providerId = 'codex';
      },
      (value: ReturnType<typeof markerInputs>) => {
        value.status.modelCatalog.schemaVersion = 2;
      },
      (value: ReturnType<typeof markerInputs>) => {
        value.checks[0].status = 'ready';
      },
      (value: ReturnType<typeof markerInputs>) => {
        value.blockers.push(value.blockers[0]);
        value.checks.push(value.checks[0]);
      },
    ]) {
      const input = markerInputs();
      mutate(input);
      expect(createProviderLaunchAuthorityMarker(input.blockers, input.checks, input.loading)).toBe(
        UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER
      );
    }
    const input = markerInputs();
    for (const blockers of [[], new Array(5), null, {}, Object.create(input.blockers)]) {
      expect(createProviderLaunchAuthorityMarker(blockers, input.checks, input.loading)).toBe(
        UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER
      );
    }
  });

  it('accepts four distinct closed providers and rejects malformed transport without echoing it', () => {
    const providers = ['anthropic', 'codex', 'gemini', 'opencode'];
    const marker = createProviderLaunchAuthorityMarker(
      providers.map((providerId) => ({ providerId, providerStatus: null })),
      providers.map((providerId) => ({ providerId, status: 'checking' })),
      {}
    );
    expect(marker.length).toBeLessThanOrEqual(PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT);
    expect(JSON.parse(marker).providers).toHaveLength(4);
    expect(readProviderLaunchAuthorityMarker(marker)).toBe(marker);
    for (const value of [
      undefined,
      null,
      {},
      '',
      'PRIVATE',
      'é',
      marker + ' ',
      marker.replace('"v":1', '"v":1,"v":1'),
      marker.replace('"check":"checking"', '"check":"ready"'),
      marker.replace('"state":"observed"', '"state":"observed","path":"PRIVATE"'),
      'x'.repeat(PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT + 1),
    ]) {
      expect(readProviderLaunchAuthorityMarker(value)).toBe(
        UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER
      );
    }
  });
});
