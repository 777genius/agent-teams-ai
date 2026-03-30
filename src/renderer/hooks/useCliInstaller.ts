/**
 * useCliInstaller — shared hook for CLI installer state.
 *
 * Centralizes all store selectors and computed state for CLI installation.
 * Used by both CliStatusBanner (Dashboard) and CliStatusSection (Settings).
 */

import { useStore } from '@renderer/store';

import type { CliInstallationStatus } from '@shared/types';

export function useCliInstaller(): {
  cliStatus: CliInstallationStatus | null;
  cliStatusLoading: boolean;
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
  fetchCliStatus: () => Promise<void>;
  invalidateCliStatus: () => Promise<void>;
  installCli: () => void;
  isBusy: boolean;
} {
  const cliStatus = useStore((s) => s.cliStatus);
  const cliStatusLoading = useStore((s) => s.cliStatusLoading);
  const cliStatusError = useStore((s) => s.cliStatusError);
  const installerState = useStore((s) => s.cliInstallerState);
  const downloadProgress = useStore((s) => s.cliDownloadProgress);
  const downloadTransferred = useStore((s) => s.cliDownloadTransferred);
  const downloadTotal = useStore((s) => s.cliDownloadTotal);
  const installerError = useStore((s) => s.cliInstallerError);
  const installerDetail = useStore((s) => s.cliInstallerDetail);
  const installerRawChunks = useStore((s) => s.cliInstallerRawChunks);
  const completedVersion = useStore((s) => s.cliCompletedVersion);
  const fetchCliStatus = useStore((s) => s.fetchCliStatus);
  const invalidateCliStatus = useStore((s) => s.invalidateCliStatus);
  const installCli = useStore((s) => s.installCli);

  const isBusy = installerState !== 'idle' && installerState !== 'error';

  return {
    cliStatus,
    cliStatusLoading,
    cliStatusError,
    installerState,
    downloadProgress,
    downloadTransferred,
    downloadTotal,
    installerError,
    installerDetail,
    installerRawChunks,
    completedVersion,
    fetchCliStatus,
    invalidateCliStatus,
    installCli,
    isBusy,
  };
}
