/**
 * useCliInstaller — shared hook for CLI installer state.
 *
 * Centralizes all store selectors and computed state for CLI installation.
 * Used by both CliStatusBanner (Dashboard) and CliStatusSection (Settings).
 */

import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { CliProviderStatusFetchOptions } from '@renderer/store/slices/cliInstallerSlice';
import type {
  CliInstallationStatus,
  CliInstallerProviderStatusMode,
  CliProviderId,
  OpenCodeRuntimeStatus,
} from '@shared/types';

export function useCliInstaller(): {
  cliStatus: CliInstallationStatus | null;
  cliStatusLoading: boolean;
  cliProviderStatusLoading: Partial<Record<CliProviderId, boolean>>;
  cliStatusError: string | null;
  installerState:
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'verifying'
    | 'installing'
    | 'completed'
    | 'error';
  downloadProgress: number;
  downloadTransferred: number;
  downloadTotal: number;
  installerError: string | null;
  installerDetail: string | null;
  installerRawChunks: string[];
  completedVersion: string | null;
  openCodeRuntimeStatus: OpenCodeRuntimeStatus | null;
  openCodeRuntimeStatusLoading: boolean;
  openCodeRuntimeError: string | null;
  codexRuntimeStatus: CodexRuntimeStatus | null;
  codexRuntimeStatusLoading: boolean;
  codexRuntimeError: string | null;
  bootstrapCliStatus: (options?: {
    multimodelEnabled?: boolean;
    providerStatusMode?: CliInstallerProviderStatusMode;
  }) => Promise<void>;
  fetchCliStatus: () => Promise<void>;
  fetchCliProviderStatus: (
    providerId: CliProviderId,
    options?: CliProviderStatusFetchOptions
  ) => Promise<boolean>;
  invalidateCliStatus: () => Promise<void>;
  installCli: () => void;
  fetchOpenCodeRuntimeStatus: () => Promise<void>;
  installOpenCodeRuntime: () => Promise<void>;
  invalidateOpenCodeRuntimeStatus: () => Promise<void>;
  fetchCodexRuntimeStatus: () => Promise<void>;
  installCodexRuntime: () => Promise<void>;
  invalidateCodexRuntimeStatus: () => Promise<void>;
  isBusy: boolean;
} {
  const {
    cliStatus,
    cliStatusLoading,
    cliProviderStatusLoading,
    cliStatusError,
    installerState,
    downloadProgress,
    downloadTransferred,
    downloadTotal,
    installerError,
    installerDetail,
    installerRawChunks,
    completedVersion,
    openCodeRuntimeStatus,
    openCodeRuntimeStatusLoading,
    openCodeRuntimeError,
    codexRuntimeStatus,
    codexRuntimeStatusLoading,
    codexRuntimeError,
    bootstrapCliStatus,
    fetchCliStatus,
    fetchCliProviderStatus,
    invalidateCliStatus,
    installCli,
    fetchOpenCodeRuntimeStatus,
    installOpenCodeRuntime,
    invalidateOpenCodeRuntimeStatus,
    fetchCodexRuntimeStatus,
    installCodexRuntime,
    invalidateCodexRuntimeStatus,
  } = useStore(
    useShallow((s) => ({
      cliStatus: s.cliStatus,
      cliStatusLoading: s.cliStatusLoading,
      cliProviderStatusLoading: s.cliProviderStatusLoading,
      cliStatusError: s.cliStatusError,
      installerState: s.cliInstallerState,
      downloadProgress: s.cliDownloadProgress,
      downloadTransferred: s.cliDownloadTransferred,
      downloadTotal: s.cliDownloadTotal,
      installerError: s.cliInstallerError,
      installerDetail: s.cliInstallerDetail,
      installerRawChunks: s.cliInstallerRawChunks,
      completedVersion: s.cliCompletedVersion,
      openCodeRuntimeStatus: s.openCodeRuntimeStatus,
      openCodeRuntimeStatusLoading: s.openCodeRuntimeStatusLoading,
      openCodeRuntimeError: s.openCodeRuntimeError,
      codexRuntimeStatus: s.codexRuntimeStatus,
      codexRuntimeStatusLoading: s.codexRuntimeStatusLoading,
      codexRuntimeError: s.codexRuntimeError,
      bootstrapCliStatus: s.bootstrapCliStatus,
      fetchCliStatus: s.fetchCliStatus,
      fetchCliProviderStatus: s.fetchCliProviderStatus,
      invalidateCliStatus: s.invalidateCliStatus,
      installCli: s.installCli,
      fetchOpenCodeRuntimeStatus: s.fetchOpenCodeRuntimeStatus,
      installOpenCodeRuntime: s.installOpenCodeRuntime,
      invalidateOpenCodeRuntimeStatus: s.invalidateOpenCodeRuntimeStatus,
      fetchCodexRuntimeStatus: s.fetchCodexRuntimeStatus,
      installCodexRuntime: s.installCodexRuntime,
      invalidateCodexRuntimeStatus: s.invalidateCodexRuntimeStatus,
    }))
  );

  const isBusy =
    installerState !== 'idle' && installerState !== 'error' && installerState !== 'completed';

  return {
    cliStatus,
    cliStatusLoading,
    cliProviderStatusLoading,
    cliStatusError,
    installerState,
    downloadProgress,
    downloadTransferred,
    downloadTotal,
    installerError,
    installerDetail,
    installerRawChunks,
    completedVersion,
    openCodeRuntimeStatus,
    openCodeRuntimeStatusLoading,
    openCodeRuntimeError,
    codexRuntimeStatus,
    codexRuntimeStatusLoading,
    codexRuntimeError,
    bootstrapCliStatus,
    fetchCliStatus,
    fetchCliProviderStatus,
    invalidateCliStatus,
    installCli,
    fetchOpenCodeRuntimeStatus,
    installOpenCodeRuntime,
    invalidateOpenCodeRuntimeStatus,
    fetchCodexRuntimeStatus,
    installCodexRuntime,
    invalidateCodexRuntimeStatus,
    isBusy,
  };
}
