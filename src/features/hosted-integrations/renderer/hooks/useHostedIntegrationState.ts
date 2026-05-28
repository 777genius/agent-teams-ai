import { useCallback, useEffect, useMemo, useState } from 'react';

import type { HostedIntegrationsElectronApi, HostedIntegrationStateDto } from '../../contracts';

interface HostedIntegrationHookState {
  readonly state: HostedIntegrationStateDto | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
}

export function useHostedIntegrationState(
  api: HostedIntegrationsElectronApi | undefined = window.electronAPI?.hostedIntegrations
) {
  const [state, setState] = useState<HostedIntegrationHookState>({
    busy: false,
    error: null,
    loading: true,
    state: null,
  });

  const run = useCallback(
    async <T>(
      operation: () => Promise<T>,
      options: { refresh?: boolean } = {}
    ): Promise<T | null> => {
      if (!api) {
        setState((current) => ({
          ...current,
          busy: false,
          error: 'Hosted integrations are available only in the desktop app.',
          loading: false,
        }));
        return null;
      }
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const result = await operation();
        if (options.refresh !== false) {
          setState((current) => ({ ...current, state: null }));
          const nextState = await api.getState();
          setState({ busy: false, error: null, loading: false, state: nextState });
        } else {
          setState((current) => ({ ...current, busy: false, loading: false }));
        }
        return result;
      } catch (error) {
        setState((current) => ({
          ...current,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        }));
        return null;
      }
    },
    [api]
  );

  const refresh = useCallback(async () => {
    if (!api) {
      setState({
        busy: false,
        error: 'Hosted integrations are available only in the desktop app.',
        loading: false,
        state: null,
      });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const nextState = await api.getState();
      setState({ busy: false, error: null, loading: false, state: nextState });
    } catch (error) {
      setState((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      }));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const actions = useMemo(
    () => ({
      bootstrapWorkspace: (workspaceDisplayName?: string) =>
        run(() =>
          api!.bootstrapWorkspace({
            desktopDisplayName: 'Agent Teams Desktop',
            ...(workspaceDisplayName?.trim()
              ? { workspaceDisplayName: workspaceDisplayName.trim() }
              : {}),
          })
        ),
      configure: (controlPlaneBaseUrl: string) =>
        run(() => api!.configure({ controlPlaneBaseUrl })),
      completePairing: (pairingCode: string) =>
        run(() =>
          api!.completePairing({
            desktopDisplayName: 'Agent Teams Desktop',
            pairingCode,
          })
        ),
      disableTarget: (targetId: string) => run(() => api!.disableTarget({ targetId })),
      dismissSetup: (setupSessionId: string) =>
        run(() => api!.dismissGitHubSetup({ setupSessionId })),
      enableTarget: (connectionId: string, githubRepositoryId: string) =>
        run(() => api!.enableTarget({ connectionId, githubRepositoryId })),
      listAvailableRepositories: async (connectionId: string) =>
        run(() => api!.listAvailableRepositories({ connectionId }), { refresh: false }),
      openSetupUrl: (setupSessionId: string, setupUrl: string) =>
        run(() => api!.openSetupUrl({ setupSessionId, setupUrl }), { refresh: false }),
      refresh,
      refreshConnections: () => run(() => api!.refreshConnections()),
      refreshSetup: (setupSessionId: string) =>
        run(() => api!.refreshGitHubSetup({ setupSessionId })),
      refreshTargets: () => run(() => api!.listTargets()),
      rotateSessionToken: () => run(() => api!.rotateSessionToken()),
      revokeSession: () => run(() => api!.revokeSession()),
      startGitHubSetup: () => run(() => api!.startGitHubSetup()),
      startPairing: () => run(() => api!.startPairing(), { refresh: false }),
    }),
    [api, refresh, run]
  );

  return {
    ...state,
    actions,
    available: Boolean(api),
  };
}
