import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  RuntimeLocalProviderListEntryDto,
  RuntimeLocalProviderListResponse,
  RuntimeLocalProviderProbeDto,
  RuntimeLocalProviderScanResponse,
} from '@features/runtime-provider-management/contracts';

interface OpenCodeLocalProviderSnapshot {
  scopeKey: string;
  providers: readonly RuntimeLocalProviderListEntryDto[];
  authoritative: boolean;
  error: string | null;
}

export interface UseOpenCodeLocalProvidersResult {
  providers: readonly RuntimeLocalProviderListEntryDto[];
  loading: boolean;
  lookupEnabled: boolean;
  authoritative: boolean;
  error: string | null;
  refresh: () => void;
}

export interface OpenCodeLocalProviderLookupResolution {
  providers: readonly RuntimeLocalProviderListEntryDto[];
  authoritative: boolean;
  error: string | null;
}

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

export function mergeOpenCodeLocalProviders(
  globalProviders: readonly RuntimeLocalProviderListEntryDto[],
  projectProviders: readonly RuntimeLocalProviderListEntryDto[],
  discoveredProviders: readonly RuntimeLocalProviderProbeDto[] = []
): readonly RuntimeLocalProviderListEntryDto[] {
  const providerById = new Map<string, RuntimeLocalProviderListEntryDto>();

  for (const provider of globalProviders) {
    const providerId = normalizeProviderId(provider.providerId);
    if (providerId) {
      providerById.set(providerId, {
        ...provider,
        // Approval is bound to the global config path and cannot authorize a new project config.
        privateNetworkApproved: false,
      });
    }
  }

  for (const provider of projectProviders) {
    const providerId = normalizeProviderId(provider.providerId);
    if (providerId) {
      // Project entries override global entries and carry approval for this exact project target.
      providerById.set(providerId, provider);
    }
  }

  for (const probe of discoveredProviders) {
    const providerId = normalizeProviderId(probe.providerId);
    if (
      !providerId ||
      providerById.has(providerId) ||
      probe.state !== 'available' ||
      probe.models.length === 0
    ) {
      continue;
    }
    providerById.set(providerId, {
      preset: probe.preset,
      providerId: probe.providerId,
      baseUrl: probe.baseUrl,
      configuredModelIds: [],
      defaultModelId: null,
      isDefault: false,
      state: probe.state,
      liveModels: probe.models,
      latencyMs: probe.latencyMs,
      message: probe.message,
    });
  }

  return Array.from(providerById.values());
}

export function resolveOpenCodeLocalProviderLookup(
  responses: readonly PromiseSettledResult<RuntimeLocalProviderListResponse>[],
  scanResponse: PromiseSettledResult<RuntimeLocalProviderScanResponse> | null = null
): OpenCodeLocalProviderLookupResolution {
  const errors: string[] = [];
  const providersByScope = responses.map((response) => {
    if (response.status === 'rejected') {
      errors.push('Could not read the OpenCode provider config.');
      return [];
    }
    if (response.value.error) {
      errors.push(response.value.error.message || 'Could not read the OpenCode provider config.');
      return [];
    }
    return response.value.providers ?? [];
  });
  const discoveredProviders =
    scanResponse?.status === 'fulfilled' && !scanResponse.value.error
      ? (scanResponse.value.probes ?? [])
      : [];
  if (scanResponse?.status === 'rejected') {
    errors.push('Could not scan local model servers.');
  } else if (scanResponse?.status === 'fulfilled' && scanResponse.value.error) {
    errors.push(scanResponse.value.error.message || 'Could not scan local model servers.');
  }

  return {
    providers: mergeOpenCodeLocalProviders(
      providersByScope[0] ?? [],
      providersByScope[1] ?? [],
      discoveredProviders
    ),
    authoritative: errors.length === 0,
    error: errors.length > 0 ? Array.from(new Set(errors)).join(' ') : null,
  };
}

export function useOpenCodeLocalProviders({
  enabled,
  projectPath,
}: {
  enabled: boolean;
  projectPath?: string | null;
}): UseOpenCodeLocalProvidersResult {
  const scopeKey = projectPath?.trim() ?? '';
  const apiAvailable = Boolean(window.electronAPI) || typeof EventSource !== 'undefined';
  const requestIdRef = useRef(0);
  const [snapshot, setSnapshot] = useState<OpenCodeLocalProviderSnapshot | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => {
    setSnapshot(null);
    setRefreshKey((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !apiAvailable) {
      requestIdRef.current += 1;
      return;
    }

    const requestId = ++requestIdRef.current;
    const loadProviders = async (): Promise<void> => {
      try {
        const requests = [
          api.runtimeProviderManagement.listLocalProviders({
            runtimeId: 'opencode',
            scope: 'global',
            projectPath: null,
          }),
          ...(scopeKey
            ? [
                api.runtimeProviderManagement.listLocalProviders({
                  runtimeId: 'opencode' as const,
                  scope: 'project' as const,
                  projectPath: scopeKey,
                }),
              ]
            : []),
        ];

        const [responses, scanResponse] = await Promise.all([
          Promise.allSettled(requests),
          typeof api.runtimeProviderManagement.scanLocalProviders === 'function'
            ? Promise.allSettled([
                api.runtimeProviderManagement.scanLocalProviders({ runtimeId: 'opencode' }),
              ]).then((results) => results[0] ?? null)
            : Promise.resolve(null),
        ]);
        if (requestIdRef.current !== requestId) {
          return;
        }

        const resolution = resolveOpenCodeLocalProviderLookup(responses, scanResponse);

        setSnapshot({
          scopeKey,
          ...resolution,
        });
      } catch {
        if (requestIdRef.current === requestId) {
          setSnapshot({
            scopeKey,
            providers: [],
            authoritative: false,
            error: 'Could not read the OpenCode provider config.',
          });
        }
      }
    };

    void loadProviders();
  }, [apiAvailable, enabled, refreshKey, scopeKey]);

  return useMemo(() => {
    if (!enabled || !apiAvailable) {
      return {
        providers: [],
        loading: false,
        lookupEnabled: false,
        authoritative: false,
        error: null,
        refresh,
      };
    }
    if (snapshot?.scopeKey !== scopeKey) {
      return {
        providers: [],
        loading: true,
        lookupEnabled: true,
        authoritative: false,
        error: null,
        refresh,
      };
    }
    return {
      providers: snapshot.providers,
      loading: false,
      lookupEnabled: true,
      authoritative: snapshot.authoritative,
      error: snapshot.error,
      refresh,
    };
  }, [apiAvailable, enabled, refresh, scopeKey, snapshot]);
}
