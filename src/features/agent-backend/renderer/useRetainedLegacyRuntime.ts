import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { useRetainedLegacyLaunch } from './RetainedLegacyLaunchContext';

import type { RetainedLegacyLaunchClient } from './retainedLegacyLaunch';
import type { RetainedLegacyResourceState } from './retainedLegacyResource';

const EMPTY = { value: null, loading: false, error: null };
const emptySnapshot = () => EMPTY;
const noSubscription = () => () => undefined;

function useOriginalResource<T>(
  key: string,
  load: (client: RetainedLegacyLaunchClient) => Promise<T>,
  enabled = true
) {
  const client = useRetainedLegacyLaunch();
  const resource = client && enabled ? client.resource(key, () => load(client)) : null;
  const state: RetainedLegacyResourceState<T> = useSyncExternalStore(
    resource?.subscribe ?? noSubscription,
    resource?.getSnapshot ?? emptySnapshot,
    resource?.getSnapshot ?? emptySnapshot
  );
  useEffect(() => {
    void resource?.ensure();
  }, [resource]);
  const refresh = useCallback(() => resource?.refresh() ?? Promise.resolve(false), [resource]);
  return { ...state, refresh, resource };
}

/** All consumers of one original choice observe the same invalidation and fresh read. */
export function useRetainedLegacyRuntimeStatus(
  projectPath: string | null | undefined,
  enabled = true
) {
  const client = useRetainedLegacyLaunch();
  const path = projectPath?.trim() || client?.choice.projectPath || '';
  const {
    value: status,
    resource,
    ...state
  } = useOriginalResource('status:' + path, (client) => client.status(path), enabled);
  const expired = useRef(new Set<string>());
  useEffect(() => {
    expired.current.clear();
  }, [resource]);
  useEffect(() => {
    if (!resource || !status) return;
    const next = status.providers
      .map((provider) => provider.modelCatalog?.staleAt)
      .filter(
        (value): value is string =>
          !!value && Number.isFinite(Date.parse(value)) && !expired.current.has(value)
      )
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    if (!next) return;
    const timer = setTimeout(
      () => {
        expired.current.add(next);
        void resource.refresh();
      },
      Math.min(Math.max(0, Date.parse(next) - Date.now()), 2_147_483_647)
    );
    return () => clearTimeout(timer);
  }, [resource, status]);
  return { status, ...state };
}

export function useRetainedLegacyAccount(enabled: boolean) {
  const {
    value: snapshot,
    resource: _resource,
    ...state
  } = useOriginalResource('account', (client) => client.account(), enabled);
  return { snapshot, ...state };
}

export function useRetainedLegacyInstallers() {
  const {
    value,
    resource: _resource,
    ...state
  } = useOriginalResource('installers', async (client) => {
    const [opencode, codex] = await Promise.all([client.opencodeRuntime(), client.codexRuntime()]);
    return { opencode, codex };
  });
  return { opencode: value?.opencode ?? null, codex: value?.codex ?? null, ...state };
}
