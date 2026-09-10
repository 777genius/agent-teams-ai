import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';

import { CatalogFailureError, catalogFailure, mainCatalogFailure, type OpenCodeCatalogFailure } from './catalogFailure';
import { loadOpenCodeScopedCatalog } from './loadOpenCodeScopedCatalog';
import { mapCatalogModel } from './useOpenCodeProviderModelCatalog';

import type { RuntimeProviderDirectoryEntryDto, RuntimeProviderModelDto } from '../../contracts';
import type { CliProviderStatus } from '@shared/types';

const CONCURRENT_SOURCE_LOADS = 1;
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
  ].sort((left, right) => {
    if (left === 'opencode') return -1;
    if (right === 'opencode') return 1;
    return left.localeCompare(right);
  });
}

interface CatalogState {
  scope: string;
  loading: boolean;
  models: RuntimeProviderModelDto[];
  errors: OpenCodeCatalogFailure[];
}

/** Dashboard display only: connected sources, never a full model inventory or launch proof. */
export function useOpenCodeConnectedModelCatalog(input: {
  enabled: boolean;
  statusChecking?: boolean;
  projectPath: string | null;
  passiveProviderStatus: CliProviderStatus | null;
  refreshRevision?: number;
}) {
  const [revision, setRevision] = useState(0);
  const lastRefresh = useRef({ revision, external: input.refreshRevision });
  const scope = JSON.stringify([input.projectPath]);
  const [state, setState] = useState<CatalogState>({
    scope: '',
    loading: false,
    models: [],
    errors: [],
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const sequence = useRef(0);
  const statusChecking = useRef(input.statusChecking === true);
  const statusWaiter = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    statusChecking.current = input.statusChecking === true;
    if (input.statusChecking !== true) {
      statusWaiter.current?.();
      statusWaiter.current = null;
    }
  }, [input.statusChecking]);

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
    // One sequential catalog lane: status checks pause its next read without
    // aborting the current source or discarding already collected models.
    const waitForStatus = async () => {
      while (current() && statusChecking.current) {
        await new Promise<void>((resolve) => {
          statusWaiter.current = resolve;
        });
      }
      return current();
    };
    const retainedModels = stateRef.current.scope === scope ? stateRef.current.models : [];
    setState({ scope, loading: true, models: retainedModels, errors: [] });
    void (async () => {
      const validationError = (message: string) => new CatalogFailureError(
        catalogFailure('provider_directory', null, 'client_validation', message)
      );
      const loadedModels: RuntimeProviderModelDto[] = [];
      const loadErrors: OpenCodeCatalogFailure[] = [];
      const entries: RuntimeProviderDirectoryEntryDto[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      let total: number | null = null;
      for (let page = 0; page < 20; page += 1) {
        if (!(await waitForStatus())) return;
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
        if (response.schemaVersion !== 1 || response.runtimeId !== 'opencode')
          throw validationError('Invalid provider directory response.');
        if (response.error) throw mainCatalogFailure('provider_directory', null, response.error);
        const directory = response.directory;
        if (
          response.schemaVersion !== 1 ||
          response.runtimeId !== 'opencode' ||
          !directory ||
          directory.runtimeId !== 'opencode'
        )
          throw validationError('Invalid provider directory response.');
        if (
          directory.cursor !== cursor ||
          directory.returnedCount !== directory.entries.length ||
          !Number.isInteger(directory.totalCount) ||
          directory.totalCount < 0 ||
          (total !== null && total !== directory.totalCount)
        )
          throw validationError('Invalid provider directory pagination.');
        total = directory.totalCount;
        entries.push(...directory.entries);
        cursor = directory.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor) || page === 19) throw validationError('Incomplete provider directory.');
        cursors.add(cursor);
      }
      if (entries.length !== total) throw validationError('Incomplete provider directory.');
      const sources = connectedCatalogSourceIds(entries);
      let sourceIndex = 0;
      const loadNext = async () => {
        while (current() && sourceIndex < sources.length) {
          if (!(await waitForStatus())) return;
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
            loadedModels.push(...catalog.models);
            if (catalog.catalogState === 'stale') {
              loadErrors.push(catalogFailure('provider_models', source, 'stale', 'Cached models are stale.'));
            }
            if (retainedModels.length === 0 && current()) {
              setState({
                scope,
                loading: true,
                models: [...loadedModels],
                errors: [...loadErrors],
              });
            }
          } catch (error) {
            if (!current()) return;
            loadErrors.push(
              catalogFailure('provider_models', source, 'transport', error)
            );
          } finally {
            activeGroups.delete(sourceRequestGroup);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENT_SOURCE_LOADS, sources.length) }, loadNext)
      );
      if (current()) {
        setState({
          scope,
          loading: true,
          models:
            loadedModels.length > 0 || loadErrors.length === 0 ? loadedModels : retainedModels,
          errors: loadErrors,
        });
      }
    })()
      .catch((error: unknown) => {
        if (current())
          setState((previous) => ({
            ...previous,
            errors: [
              ...previous.errors,
              catalogFailure('provider_directory', null, 'transport', error),
            ],
          }));
      })
      .finally(() => {
        if (current()) setState((previous) => ({ ...previous, loading: false }));
      });
    return () => {
      cancelled = true;
      statusWaiter.current?.();
      statusWaiter.current = null;
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
    const hasScopedState = state.scope === scope;
    if (!passive || (!input.enabled && !hasScopedState)) return passive;
    // Keep the last-good catalog for this scope while reads or status checks
    // are in flight. Catalog discovery never grants launch authority.
    const active = hasScopedState ? state : { loading: true, models: [], errors: [] };
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
          message: active.errors.map((error) => `${error.sourceProviderId ? `${error.sourceProviderId}: ` : ''}${error.message}`).join(' - ') || null,
        },
      },
    };
  }, [input.enabled, input.passiveProviderStatus, scope, state]);
  return { providerStatus, refresh, failures: state.scope === scope ? state.errors : [] };
}
