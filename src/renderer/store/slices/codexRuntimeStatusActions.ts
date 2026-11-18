import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import type { CliInstallerSlice } from './cliInstallerSlice';

const logger = createLogger('Store:codexRuntimeStatus');

type CodexRuntimeReadState = Pick<
  CliInstallerSlice,
  'codexRuntimeStatus' | 'codexRuntimeStatusLoading' | 'codexRuntimeError'
>;
type CodexRuntimeStatusActions = Pick<
  CliInstallerSlice,
  'fetchCodexRuntimeStatus' | 'invalidateCodexRuntimeStatus'
>;

/** Keep the Codex runtime snapshot fresh even when an older native read is pending. */
export function createCodexRuntimeStatusActions(
  set: (state: Partial<CodexRuntimeReadState>) => void
): CodexRuntimeStatusActions {
  let inFlight: Promise<void> | null = null;
  let revision = 0;

  return {
    fetchCodexRuntimeStatus: async () => {
      if (!api.codexRuntime) return;
      if (inFlight) return inFlight;

      const current = ++revision;
      let request!: Promise<void>;
      // eslint-disable-next-line prefer-const
      request = (async () => {
        set({ codexRuntimeStatusLoading: true, codexRuntimeError: null });
        try {
          const status = await api.codexRuntime.getStatus();
          if (current === revision) {
            set({ codexRuntimeStatus: status, codexRuntimeError: status.error ?? null });
          }
        } catch (error) {
          if (current === revision) {
            const message =
              error instanceof Error ? error.message : 'Failed to check Codex runtime status';
            logger.error('Failed to fetch Codex runtime status:', error);
            set({ codexRuntimeError: message });
          }
        } finally {
          if (current === revision) set({ codexRuntimeStatusLoading: false });
          if (inFlight === request) inFlight = null;
        }
      })();
      inFlight = request;
      return request;
    },

    invalidateCodexRuntimeStatus: async () => {
      // Retire old reads before invalidating the native cache so that the
      // next refresh cannot join them or publish an obsolete runtime version.
      const current = ++revision;
      inFlight = null;
      set({ codexRuntimeStatusLoading: false });
      await api.codexRuntime?.invalidateStatus();
      if (current === revision) set({ codexRuntimeStatus: null });
    },
  };
}
