import {
  classifyAnalyticsError,
  elapsedMsSince,
  recordRuntimeInstallEnd,
} from '@renderer/analytics/productAnalytics';
import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import { revokeProviderLaunchAuthority } from './cliInstallerStatusReconciliation';
import { beginOpenCodeRuntimeReplacement } from './openCodeMetadataPublication';

import type { CliInstallerSlice } from './cliInstallerSlice';
import type { OpenCodeRuntimeStatus } from '@shared/types';

type RuntimeState = Pick<
  CliInstallerSlice,
  | 'openCodeRuntimeStatus'
  | 'openCodeRuntimeStatusLoading'
  | 'openCodeRuntimeError'
  | 'cliStatus'
  | 'cliProviderStatusByScope'
  | 'cliProviderStatusScopeRevision'
  | 'cliProviderStatusLoading'
>;
type RuntimeActions = Pick<
  CliInstallerSlice,
  | 'fetchOpenCodeRuntimeStatus'
  | 'installOpenCodeRuntime'
  | 'invalidateOpenCodeRuntimeStatus'
  | 'applyOpenCodeRuntimeProgress'
>;
const logger = createLogger('Store:openCodeRuntime');

function isInstalling(status: OpenCodeRuntimeStatus | null): boolean {
  return (
    status?.state === 'checking' ||
    status?.state === 'downloading' ||
    status?.state === 'installing'
  );
}

function failedStatus(
  previous: OpenCodeRuntimeStatus | null,
  message: string
): OpenCodeRuntimeStatus {
  return {
    ...previous,
    installed: previous?.installed ?? false,
    source: previous?.source ?? 'missing',
    state: 'failed',
    progress: { phase: 'failed', detail: message },
    error: message,
  };
}

/** Install/progress observations supersede reads begun under the previous runtime state. */
export function createOpenCodeRuntimeActions(
  set: (state: Partial<RuntimeState>) => void,
  get: () => RuntimeState,
  refreshProviderStatus: () => Promise<void>,
  detachProviderReads: () => void
): RuntimeActions {
  let revision = 0;
  let statusInFlight: Promise<void> | null = null;
  let installInFlight: Promise<void> | null = null;
  const invalidateReads = (): number => {
    statusInFlight = null;
    return ++revision;
  };
  const invalidateProjectScopes = (notify: boolean): void => {
    detachProviderReads();
    const state = get();
    set({
      cliProviderStatusByScope: Object.fromEntries(
        Object.entries(state.cliProviderStatusByScope).filter(
          ([key]) => !key.startsWith('opencode\0')
        )
      ),
      cliProviderStatusLoading: { ...state.cliProviderStatusLoading, opencode: false },
      cliProviderStatusScopeRevision: state.cliProviderStatusScopeRevision + (notify ? 1 : 0),
    });
  };
  const applyProgress = (status: OpenCodeRuntimeStatus): void => {
    invalidateReads();
    set({
      openCodeRuntimeStatus: status,
      openCodeRuntimeError: status.error ?? null,
      openCodeRuntimeStatusLoading: isInstalling(status),
    });
  };
  return {
    applyOpenCodeRuntimeProgress: applyProgress,
    fetchOpenCodeRuntimeStatus: async () => {
      if (!api.openCodeRuntime) return;
      if (installInFlight) return installInFlight;
      if (statusInFlight) return statusInFlight;
      const current = ++revision;
      set({ openCodeRuntimeStatusLoading: true, openCodeRuntimeError: null });
      const request = Promise.resolve().then(async () => {
        try {
          const status = await api.openCodeRuntime.getStatus();
          if (current !== revision) return;
          set({ openCodeRuntimeStatus: status, openCodeRuntimeError: status.error ?? null });
        } catch (error) {
          if (current !== revision) return;
          const message =
            error instanceof Error ? error.message : 'Failed to check OpenCode runtime status';
          logger.error('Failed to fetch OpenCode runtime status:', error);
          set({
            openCodeRuntimeStatus: failedStatus(get().openCodeRuntimeStatus, message),
            openCodeRuntimeError: message,
          });
        } finally {
          if (current === revision)
            set({ openCodeRuntimeStatusLoading: isInstalling(get().openCodeRuntimeStatus) });
          if (statusInFlight === request) statusInFlight = null;
        }
      });
      statusInFlight = request;
      return request;
    },
    installOpenCodeRuntime: async (options) => {
      if (!api.openCodeRuntime) return;
      // One UI operation owns installation and its follow-up refresh.
      if (installInFlight) return installInFlight;
      const startedAt = Date.now();
      const previous = get().openCodeRuntimeStatus;
      const finishReplacement = beginOpenCodeRuntimeReplacement(get);
      // Both project and global launch evidence belongs to the previous executable.
      invalidateProjectScopes(false);
      const cliStatus = get().cliStatus;
      if (cliStatus) {
        set({
          cliStatus: {
            ...cliStatus,
            providers: cliStatus.providers.map((provider) =>
              provider.providerId === 'opencode'
                ? revokeProviderLaunchAuthority(provider)
                : provider
            ),
          },
        });
      }
      applyProgress({
        ...previous,
        installed: previous?.installed ?? false,
        source: previous?.source ?? 'missing',
        state: 'checking',
        error: undefined,
        progress: { phase: 'checking', detail: 'Resolving latest OpenCode package...' },
      });
      const request = (async () => {
        let status: OpenCodeRuntimeStatus;
        try {
          status = await api.openCodeRuntime.install(options);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to install OpenCode runtime';
          logger.error('Failed to install OpenCode runtime:', error);
          status = failedStatus(get().openCodeRuntimeStatus, message);
        }
        applyProgress(status);
        const success = status.installed && status.state === 'ready';
        recordRuntimeInstallEnd({
          runtime: 'opencode',
          success,
          source: status.source,
          errorClass: success ? 'none' : classifyAnalyticsError(status.error),
          durationMs: elapsedMsSince(startedAt),
        });
        if (status.installed) {
          try {
            await api.openCodeRuntime.invalidateStatus();
            await refreshProviderStatus();
          } catch (error) {
            // A catalog refresh cannot turn a completed native installation into a failure.
            logger.warn('OpenCode provider refresh after installation failed:', error);
          }
        }
      })().finally(() => {
        if (installInFlight === request) installInFlight = null;
        finishReplacement();
        // The unscoped follow-up can advance its epoch several times. Notify once after it
        // settles, including failure, so selected projects read under the final epoch.
        invalidateProjectScopes(true);
        set({ openCodeRuntimeStatusLoading: isInstalling(get().openCodeRuntimeStatus) });
      });
      installInFlight = request;
      return request;
    },
    invalidateOpenCodeRuntimeStatus: async () => {
      const current = invalidateReads();
      await api.openCodeRuntime?.invalidateStatus();
      if (current === revision && !installInFlight)
        set({ openCodeRuntimeStatus: null, openCodeRuntimeStatusLoading: false });
    },
  };
}
