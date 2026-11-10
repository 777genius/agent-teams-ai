import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';

import { TmuxInstallerBannerViewModelBuilder } from '../view-models/TmuxInstallerBannerViewModelBuilder';

import type { TmuxInstallerSnapshot, TmuxStatus } from '@features/tmux-installer/contracts';

const IDLE_SNAPSHOT: TmuxInstallerSnapshot = {
  phase: 'idle',
  strategy: null,
  message: null,
  detail: null,
  error: null,
  canCancel: false,
  acceptsInput: false,
  inputPrompt: null,
  inputSecret: false,
  logs: [],
  updatedAt: new Date(0).toISOString(),
};

function getIsoTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function useTmuxInstallerBanner(): {
  viewModel: ReturnType<TmuxInstallerBannerViewModelBuilder['build']>;
  install: () => Promise<void>;
  cancel: () => Promise<void>;
  submitInput: (input: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  toggleDetails: () => void;
  openExternal: (url: string) => Promise<void>;
} {
  const electronMode = isElectronMode();
  const viewModelBuilder = useMemo(() => TmuxInstallerBannerViewModelBuilder.create(), []);
  const [status, setStatus] = useState<TmuxStatus | null>(null);
  const [snapshot, setSnapshot] = useState<TmuxInstallerSnapshot>(IDLE_SNAPSHOT);
  const [loading, setLoading] = useState(electronMode);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasLoadedRef = useRef(!electronMode);

  const getErrorMessage = useCallback((value: unknown, fallback: string): string => {
    return value instanceof Error ? value.message : fallback;
  }, []);

  const refresh = useCallback(
    async (options?: { background?: boolean }) => {
      if (!electronMode) {
        setLoading(false);
        return;
      }

      const background = options?.background ?? hasLoadedRef.current;
      if (!background) {
        setLoading(true);
      }
      setError(null);
      try {
        const [nextStatus, nextSnapshot] = await Promise.all([
          api.tmux.getStatus(),
          api.tmux.getInstallerSnapshot(),
        ]);
        setStatus((current) =>
          getIsoTimestamp(nextStatus.checkedAt) >= getIsoTimestamp(current?.checkedAt)
            ? nextStatus
            : current
        );
        setSnapshot((current) =>
          getIsoTimestamp(nextSnapshot.updatedAt) >= getIsoTimestamp(current.updatedAt)
            ? nextSnapshot
            : current
        );
        hasLoadedRef.current = true;
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Failed to load tmux state');
      } finally {
        if (!background) {
          setLoading(false);
        }
      }
    },
    [electronMode]
  );

  useEffect(() => {
    if (!electronMode) {
      setLoading(false);
      return;
    }

    void refresh({ background: false });

    return api.tmux.onProgress((_event, progress) => {
      setSnapshot((current) =>
        getIsoTimestamp(progress.updatedAt) >= getIsoTimestamp(current.updatedAt)
          ? progress
          : current
      );
      if (
        progress.phase === 'completed' ||
        progress.phase === 'needs_manual_step' ||
        progress.phase === 'waiting_for_external_step' ||
        progress.phase === 'needs_restart' ||
        progress.phase === 'error' ||
        progress.phase === 'cancelled'
      ) {
        void refresh({ background: true });
      }
    });
  }, [electronMode, refresh]);

  const install = useCallback(async () => {
    if (!electronMode) {
      return;
    }

    setError(null);
    try {
      await api.tmux.install();
    } catch (nextError) {
      setError(getErrorMessage(nextError, 'Failed to start tmux installation'));
    }
  }, [electronMode, getErrorMessage]);

  const cancel = useCallback(async () => {
    if (!electronMode) {
      return;
    }

    setError(null);
    try {
      await api.tmux.cancelInstall();
    } catch (nextError) {
      setError(getErrorMessage(nextError, 'Failed to cancel tmux installation'));
    }
  }, [electronMode, getErrorMessage]);

  const submitInput = useCallback(
    async (input: string) => {
      if (!electronMode) {
        return false;
      }

      setError(null);
      try {
        await api.tmux.submitInstallerInput(input);
        return true;
      } catch (nextError) {
        setError(getErrorMessage(nextError, 'Failed to send installer input'));
        return false;
      }
    },
    [electronMode, getErrorMessage]
  );

  const toggleDetails = useCallback(() => {
    setDetailsOpen((current) => !current);
  }, []);

  const openExternal = useCallback(
    async (url: string) => {
      if (!electronMode) {
        return;
      }

      setError(null);
      try {
        await api.openExternal(url);
      } catch (nextError) {
        setError(getErrorMessage(nextError, 'Failed to open the external guide'));
      }
    },
    [electronMode, getErrorMessage]
  );

  const viewModel = useMemo(
    () =>
      viewModelBuilder.build({
        status,
        snapshot,
        loading,
        error,
        detailsOpen,
      }),
    [viewModelBuilder, detailsOpen, error, loading, snapshot, status]
  );

  return {
    viewModel: electronMode ? viewModel : { ...viewModel, visible: false },
    install,
    cancel,
    submitInput,
    refresh,
    toggleDetails,
    openExternal,
  };
}
