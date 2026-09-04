import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';

import { loadOpenCodeScopedCatalog } from './loadOpenCodeScopedCatalog';
import { mapCatalogModel } from './useOpenCodeProviderModelCatalog';

import type { RuntimeProviderDirectoryEntryDto, RuntimeProviderModelDto } from '../../contracts';
import type { CliProviderStatus } from '@shared/types';

const CONCURRENT_SOURCE_LOADS = 3;
let nextRequest = 0;

export function connectedCatalogSourceIds(
  entries: readonly RuntimeProviderDirectoryEntryDto[]
): string[] {
  return [
    ...new Set(
      entries
        .filter(
          (entry) =>
            entry.providerId.trim().toLowerCase() === 'opencode' ||
            (entry.state !== 'ignored' &&
              (entry.state === 'connected' || entry.metadata.configuredAuthless))
        )
        .map((entry) => entry.providerId.trim().toLowerCase())
        .filter(Boolean)
    ),
  ].sort();
}

interface CatalogState {
  scope: string;
  loading: boolean;
  models: RuntimeProviderModelDto[];
  errors: string[];
}

/** Dashboard display only: connected sources, never a full model inventory or launch proof. */
export function useOpenCodeConnectedModelCatalog(input: {
  enabled: boolean;
  projectPath: string | null;
  passiveProviderStatus: CliProviderStatus | null;
  refreshRevision?: number;
}) {
  const [revision, setRevision] = useState(0);
  const lastRefresh = useRef({ revision, external: input.refreshRevision });
  const scope = JSON.stringify([input.projectPath, revision, input.refreshRevision]);
  const [state, setState] = useState<CatalogState>({
    scope: '',
    loading: false,
    models: [],
    errors: [],
  });
  const sequence = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!input.enabled) return;
    const refreshRequested =
      lastRefresh.current.revision !== revision ||
      lastRefresh.current.external !== input.refreshRevision;
    lastRefresh.current = { revision, external: input.refreshRevision };
    const request = ++sequence.current;
    const requestGroupId = `dashboard-connected-catalog:${++nextRequest}`;
    const activeGroups = new Set<string>();
    let cancelled = false;
    const current = () => !cancelled && request === sequence.current;
    setState({ scope, loading: true, models: [], errors: [] });
    void (async () => {
      const entries: RuntimeProviderDirectoryEntryDto[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      let total: number | null = null;
      for (let page = 0; page < 20; page += 1) {
        const response = await api.runtimeProviderManagement.loadProviderDirectory({
          runtimeId: 'opencode',
          projectPath: input.projectPath,
          summary: true,
          filter: 'all',
          query: null,
          limit: 100,
          cursor,
          refresh: refreshRequested,
        });
        if (!current()) return;
        if (response.error) throw new Error(response.error.message);
        const directory = response.directory;
        if (
          response.schemaVersion !== 1 ||
          response.runtimeId !== 'opencode' ||
          !directory ||
          directory.runtimeId !== 'opencode'
        )
          throw new Error('Invalid provider directory response.');
        if (
          directory.cursor !== cursor ||
          directory.returnedCount !== directory.entries.length ||
          !Number.isInteger(directory.totalCount) ||
          directory.totalCount < 0 ||
          (total !== null && total !== directory.totalCount)
        )
          throw new Error('Invalid provider directory pagination.');
        total = directory.totalCount;
        entries.push(...directory.entries);
        cursor = directory.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor) || page === 19) throw new Error('Incomplete provider directory.');
        cursors.add(cursor);
      }
      if (entries.length !== total) throw new Error('Incomplete provider directory.');
      const sources = connectedCatalogSourceIds(entries);
      let sourceIndex = 0;
      const loadNext = async () => {
        while (current() && sourceIndex < sources.length) {
          const source = sources[sourceIndex++];
          const sourceRequestGroup = `${requestGroupId}:${source}`;
          activeGroups.add(sourceRequestGroup);
          try {
            const catalog = await loadOpenCodeScopedCatalog(
              source,
              input.projectPath,
              sourceRequestGroup,
              current,
              refreshRequested
            );
            if (!current()) return;
            setState((previous) => ({
              ...previous,
              models: [...previous.models, ...catalog.models],
              errors:
                catalog.catalogState === 'stale'
                  ? [...previous.errors, `${source}: cached models are stale.`]
                  : previous.errors,
            }));
          } catch (error) {
            if (!current()) return;
            setState((previous) => ({
              ...previous,
              errors: [
                ...previous.errors,
                `${source}: ${error instanceof Error ? error.message : 'Model catalog request failed.'}`,
              ],
            }));
          } finally {
            activeGroups.delete(sourceRequestGroup);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENT_SOURCE_LOADS, sources.length) }, loadNext)
      );
    })()
      .catch((error: unknown) => {
        if (current())
          setState((previous) => ({
            ...previous,
            errors: [
              ...previous.errors,
              error instanceof Error ? error.message : 'Provider directory request failed.',
            ],
          }));
      })
      .finally(() => {
        if (current()) setState((previous) => ({ ...previous, loading: false }));
      });
    return () => {
      cancelled = true;
      if (isElectronMode()) {
        for (const group of activeGroups)
          void api.runtimeProviderManagement
            .cancelModelLoad?.({ requestGroupId: group })
            .catch(() => undefined);
      }
    };
  }, [input.enabled, input.projectPath, input.refreshRevision, revision, scope]);

  const providerStatus = useMemo(() => {
    const passive = input.passiveProviderStatus;
    if (!passive || !input.enabled) return passive;
    const active = state.scope === scope ? state : { loading: true, models: [], errors: [] };
    const models = [
      ...new Map(
        active.models.flatMap((model) => {
          const mapped = mapCatalogModel(model, passive);
          return mapped ? [[mapped.launchModel, mapped] as const] : [];
        })
      ).values(),
    ].sort((a, b) => a.launchModel.localeCompare(b.launchModel));
    return {
      ...passive,
      models: models.map((model) => model.launchModel),
      modelAvailability: [],
      modelCatalogRefreshState: active.loading
        ? ('loading' as const)
        : active.errors.length
          ? ('error' as const)
          : ('ready' as const),
      modelCatalog: {
        schemaVersion: 1 as const,
        providerId: 'opencode' as const,
        source: 'app-server' as const,
        status: 'degraded' as const,
        fetchedAt: new Date(0).toISOString(),
        staleAt: new Date(0).toISOString(),
        defaultModelId: null,
        defaultLaunchModel: null,
        models,
        diagnostics: {
          configReadState: 'ready' as const,
          appServerState: 'degraded' as const,
          message: active.errors.join(' - ') || null,
        },
      },
    };
  }, [input.enabled, input.passiveProviderStatus, scope, state]);
  return { providerStatus, refresh };
}
