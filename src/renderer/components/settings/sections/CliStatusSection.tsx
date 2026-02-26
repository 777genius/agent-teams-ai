/**
 * CliStatusSection — CLI installation status and install/update controls.
 *
 * Displayed in Settings → Advanced, only in Electron mode.
 * Shows detection status, version info, download progress, and error states.
 */

import { useCallback, useEffect, useMemo } from 'react';

import { isElectronMode } from '@renderer/api';
import { useCliInstaller } from '@renderer/hooks/useCliInstaller';
import { formatBytes } from '@renderer/utils/formatters';
import { AlertTriangle, CheckCircle, Download, Loader2, RefreshCw, Terminal } from 'lucide-react';

import { SettingsSectionHeader } from '../components';

export const CliStatusSection = (): React.JSX.Element | null => {
  const isElectron = useMemo(() => isElectronMode(), []);
  const {
    cliStatus,
    installerState,
    downloadProgress,
    downloadTransferred,
    downloadTotal,
    installerError,
    completedVersion,
    fetchCliStatus,
    installCli,
    isBusy,
  } = useCliInstaller();

  useEffect(() => {
    if (isElectron) {
      void fetchCliStatus();
    }
  }, [isElectron, fetchCliStatus]);

  const handleInstall = useCallback(() => {
    installCli();
  }, [installCli]);

  const handleRefresh = useCallback(() => {
    void fetchCliStatus();
  }, [fetchCliStatus]);

  if (!isElectron) return null;

  return (
    <div className="mb-2">
      <SettingsSectionHeader title="Claude CLI" />
      <div className="space-y-3 py-2">
        {/* Loading status */}
        {!cliStatus && installerState === 'idle' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            Checking CLI...
          </div>
        )}

        {/* Status display */}
        {cliStatus && installerState === 'idle' && (
          <div className="space-y-2">
            {cliStatus.installed ? (
              <div className="space-y-1">
                <div
                  className="flex items-center gap-2 text-sm"
                  style={{ color: 'var(--color-text)' }}
                >
                  <Terminal
                    className="size-4 shrink-0"
                    style={{ color: 'var(--color-text-muted)' }}
                  />
                  <span>Claude CLI v{cliStatus.installedVersion ?? 'unknown'}</span>
                </div>
                {cliStatus.binaryPath && (
                  <p
                    className="ml-6 truncate text-xs"
                    style={{ color: 'var(--color-text-muted)' }}
                    title={cliStatus.binaryPath}
                  >
                    {cliStatus.binaryPath}
                  </p>
                )}
                {cliStatus.updateAvailable && cliStatus.latestVersion && (
                  <div className="ml-6 flex items-center gap-2">
                    <span className="text-xs" style={{ color: '#60a5fa' }}>
                      v{cliStatus.installedVersion} &rarr; v{cliStatus.latestVersion}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div
                className="flex items-center gap-2 text-sm"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                <AlertTriangle className="size-4 shrink-0" style={{ color: '#fbbf24' }} />
                Claude CLI not installed
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
              {!cliStatus.installed && (
                <button
                  onClick={handleInstall}
                  disabled={isBusy}
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
                  style={{ backgroundColor: '#3b82f6' }}
                >
                  <Download className="size-3.5" />
                  Install Claude CLI
                </button>
              )}
              {cliStatus.installed && cliStatus.updateAvailable && (
                <button
                  onClick={handleInstall}
                  disabled={isBusy}
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
                  style={{ backgroundColor: '#3b82f6' }}
                >
                  <Download className="size-3.5" />
                  Update
                </button>
              )}
              {cliStatus.installed && !cliStatus.updateAvailable && (
                <button
                  onClick={handleRefresh}
                  className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
                  style={{
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  <RefreshCw className="size-3.5" />
                  Check for Updates
                </button>
              )}
            </div>
          </div>
        )}

        {/* Downloading */}
        {installerState === 'downloading' && (
          <div className="space-y-2">
            <div
              className="flex items-center justify-between text-xs"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <span>Downloading...</span>
              <span>
                {downloadTotal > 0
                  ? `${formatBytes(downloadTransferred)} / ${formatBytes(downloadTotal)} (${downloadProgress}%)`
                  : `${formatBytes(downloadTransferred)}`}
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: 'var(--color-surface-raised)' }}
            >
              {downloadTotal > 0 ? (
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${downloadProgress}%`,
                    backgroundColor: '#3b82f6',
                  }}
                />
              ) : (
                <div
                  className="h-full w-1/3 animate-pulse rounded-full"
                  style={{ backgroundColor: '#3b82f6' }}
                />
              )}
            </div>
          </div>
        )}

        {/* Checking */}
        {installerState === 'checking' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            Checking latest version...
          </div>
        )}

        {/* Verifying */}
        {installerState === 'verifying' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            Verifying checksum...
          </div>
        )}

        {/* Installing */}
        {installerState === 'installing' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            Installing...
          </div>
        )}

        {/* Completed */}
        {installerState === 'completed' && (
          <div className="flex items-center gap-2 text-sm" style={{ color: '#4ade80' }}>
            <CheckCircle className="size-4" />
            Installed v{completedVersion ?? 'latest'}
          </div>
        )}

        {/* Error */}
        {installerState === 'error' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm" style={{ color: '#f87171' }}>
              <AlertTriangle className="size-4" />
              {installerError ?? 'Installation failed'}
            </div>
            <button
              onClick={handleInstall}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <RefreshCw className="size-3.5" />
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
