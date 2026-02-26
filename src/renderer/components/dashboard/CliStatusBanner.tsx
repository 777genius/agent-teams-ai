/**
 * CliStatusBanner — CLI installation status banner for the Dashboard.
 *
 * Shown on the main screen before project search.
 * Displays CLI version/path when installed, or a red error with install button when not.
 * Shows live detail text for every phase and a mini log panel during installation.
 * Only rendered in Electron mode.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { useCliInstaller } from '@renderer/hooks/useCliInstaller';
import { formatBytes } from '@renderer/utils/formatters';
import { AlertTriangle, CheckCircle, Download, Loader2, RefreshCw, Terminal } from 'lucide-react';

// =============================================================================
// Border color by state
// =============================================================================

type BannerVariant = 'loading' | 'error' | 'success' | 'info';

const VARIANT_STYLES: Record<BannerVariant, { border: string; bg: string }> = {
  loading: { border: 'var(--color-border)', bg: 'transparent' },
  error: { border: '#ef4444', bg: 'rgba(239, 68, 68, 0.06)' },
  success: { border: '#22c55e', bg: 'rgba(34, 197, 94, 0.04)' },
  info: { border: '#3b82f6', bg: 'rgba(59, 130, 246, 0.04)' },
};

// =============================================================================
// Sub-components
// =============================================================================

/** Detail text shown under the main status line */
const DetailLine = ({ text }: { text: string | null }): React.JSX.Element | null => {
  if (!text) return null;
  return (
    <p className="mt-1 truncate font-mono text-xs" style={{ color: 'var(--color-text-muted)' }}>
      {text}
    </p>
  );
};

/** Mini log panel shown during the installing phase */
const LogPanel = ({ logs }: { logs: string[] }): React.JSX.Element | null => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  if (logs.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="mt-2 max-h-24 overflow-y-auto rounded border font-mono text-xs leading-relaxed"
      style={{
        borderColor: 'var(--color-border)',
        backgroundColor: 'var(--color-surface)',
        padding: '6px 8px',
        color: 'var(--color-text-muted)',
      }}
    >
      {logs.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all">
          <span style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>&rsaquo;</span> {line}
        </div>
      ))}
    </div>
  );
};

/** Error display with multi-line support */
const ErrorDisplay = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}): React.JSX.Element => {
  const lines = error.split('\n');
  const title = lines[0];
  const details = lines.slice(1).filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: '#f87171' }} />
          <div className="min-w-0">
            <p className="text-sm font-medium" style={{ color: '#f87171' }}>
              {title}
            </p>
            {details.length > 0 && (
              <div
                className="mt-1.5 rounded border px-2 py-1.5 font-mono text-xs leading-relaxed"
                style={{
                  borderColor: 'rgba(239, 68, 68, 0.2)',
                  backgroundColor: 'rgba(239, 68, 68, 0.04)',
                  color: 'var(--color-text-muted)',
                }}
              >
                {details.map((line, i) => (
                  <div key={i} className="break-all">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <button
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
        >
          <RefreshCw className="size-3.5" />
          Retry
        </button>
      </div>
    </div>
  );
};

// =============================================================================
// Main Component
// =============================================================================

export const CliStatusBanner = (): React.JSX.Element | null => {
  const isElectron = useMemo(() => isElectronMode(), []);
  const {
    cliStatus,
    cliStatusLoading,
    cliStatusError,
    installerState,
    downloadProgress,
    downloadTransferred,
    downloadTotal,
    installerError,
    installerDetail,
    installerLogs,
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

  // Determine variant for styling
  const getVariant = (): BannerVariant => {
    if (installerState === 'error') return 'error';
    if (installerState === 'completed') return 'success';
    if (installerState !== 'idle') return 'info';
    if (!cliStatus) return 'loading';
    if (!cliStatus.installed) return 'error';
    if (cliStatus.updateAvailable) return 'info';
    return 'success';
  };

  const variant = getVariant();
  const styles = VARIANT_STYLES[variant];

  // ── Loading / fetch error state ────────────────────────────────────────
  if (!cliStatus && installerState === 'idle') {
    // Fetch failed — show error with retry
    if (cliStatusError && !cliStatusLoading) {
      return (
        <div
          className="mb-6 rounded-lg border-l-4 px-4 py-3"
          style={{
            borderColor: VARIANT_STYLES.error.border,
            backgroundColor: VARIANT_STYLES.error.bg,
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" style={{ color: '#f87171' }} />
              <span className="text-sm" style={{ color: '#f87171' }}>
                Failed to check CLI status
              </span>
            </div>
            <button
              onClick={handleRefresh}
              className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              <RefreshCw className="size-3.5" />
              Retry
            </button>
          </div>
        </div>
      );
    }
    // Still loading or initial render
    return (
      <div
        className="mb-6 flex items-center gap-3 rounded-lg border-l-4 px-4 py-3"
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <Loader2
          className="size-4 shrink-0 animate-spin"
          style={{ color: 'var(--color-text-muted)' }}
        />
        <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Checking Claude CLI...
        </span>
      </div>
    );
  }

  // ── Downloading ────────────────────────────────────────────────────────
  if (installerState === 'downloading') {
    return (
      <div
        className="mb-6 space-y-2 rounded-lg border-l-4 px-4 py-3"
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Loader2 className="size-4 shrink-0 animate-spin text-blue-400" />
            <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Downloading Claude CLI...
            </span>
          </div>
          <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
            {downloadTotal > 0
              ? `${formatBytes(downloadTransferred)} / ${formatBytes(downloadTotal)} (${downloadProgress}%)`
              : formatBytes(downloadTransferred)}
          </span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full"
          style={{ backgroundColor: 'var(--color-surface-raised)' }}
        >
          {downloadTotal > 0 ? (
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${downloadProgress}%`, backgroundColor: '#3b82f6' }}
            />
          ) : (
            <div
              className="h-full w-1/3 animate-pulse rounded-full"
              style={{ backgroundColor: '#3b82f6' }}
            />
          )}
        </div>
      </div>
    );
  }

  // ── Checking / Verifying ───────────────────────────────────────────────
  if (installerState === 'checking' || installerState === 'verifying') {
    const label =
      installerState === 'checking' ? 'Checking latest version...' : 'Verifying checksum...';
    return (
      <div
        className="mb-6 rounded-lg border-l-4 px-4 py-3"
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <div className="flex items-center gap-3">
          <Loader2 className="size-4 shrink-0 animate-spin text-blue-400" />
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {label}
          </span>
        </div>
        <DetailLine text={installerDetail} />
      </div>
    );
  }

  // ── Installing (with log panel) ────────────────────────────────────────
  if (installerState === 'installing') {
    return (
      <div
        className="mb-6 rounded-lg border-l-4 px-4 py-3"
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <div className="flex items-center gap-3">
          <Loader2 className="size-4 shrink-0 animate-spin text-blue-400" />
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Installing Claude CLI...
          </span>
        </div>
        <LogPanel logs={installerLogs} />
      </div>
    );
  }

  // ── Completed ──────────────────────────────────────────────────────────
  if (installerState === 'completed') {
    return (
      <div
        className="mb-6 flex items-center gap-3 rounded-lg border-l-4 px-4 py-3"
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <CheckCircle className="size-4 shrink-0" style={{ color: '#4ade80' }} />
        <span className="text-sm" style={{ color: '#4ade80' }}>
          Successfully installed Claude CLI v{completedVersion ?? 'latest'}
        </span>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────
  if (installerState === 'error') {
    return (
      <div
        className="mb-6 rounded-lg border-l-4 px-4 py-3"
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <ErrorDisplay error={installerError ?? 'Installation failed'} onRetry={handleInstall} />
      </div>
    );
  }

  // ── Idle state with status ─────────────────────────────────────────────
  if (!cliStatus) return null;

  // Not installed — red error banner
  if (!cliStatus.installed) {
    return (
      <div
        className="mb-6 rounded-lg border-l-4 p-4"
        style={{ borderColor: styles.border, backgroundColor: styles.bg }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0" style={{ color: '#ef4444' }} />
            <div>
              <p className="text-sm font-medium" style={{ color: '#f87171' }}>
                Claude CLI is required
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Claude CLI is required for team provisioning and session management. Install it to
                get started.
              </p>
            </div>
          </div>
          <button
            onClick={handleInstall}
            disabled={isBusy}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
            style={{ backgroundColor: '#3b82f6' }}
          >
            <Download className="size-4" />
            Install Claude CLI
          </button>
        </div>
      </div>
    );
  }

  // Installed — show version, path, update info
  return (
    <div
      className="mb-6 rounded-lg border-l-4 px-4 py-3"
      style={{ borderColor: styles.border, backgroundColor: styles.bg }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Terminal className="size-4 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: 'var(--color-text)' }}>
                Claude CLI v{cliStatus.installedVersion ?? 'unknown'}
              </span>
              {cliStatus.updateAvailable && cliStatus.latestVersion && (
                <span className="text-xs" style={{ color: '#60a5fa' }}>
                  &rarr; v{cliStatus.latestVersion}
                </span>
              )}
            </div>
            {cliStatus.binaryPath && (
              <button
                className="truncate font-mono text-xs hover:underline"
                style={{ color: 'var(--color-text-muted)' }}
                title={`Reveal in file manager: ${cliStatus.binaryPath}`}
                onClick={() => void api.showInFolder(cliStatus.binaryPath!)}
              >
                {cliStatus.binaryPath}
              </button>
            )}
          </div>
        </div>

        {/* Action button */}
        {cliStatus.updateAvailable ? (
          <button
            onClick={handleInstall}
            disabled={isBusy}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
            style={{ backgroundColor: '#3b82f6' }}
          >
            <Download className="size-3.5" />
            Update
          </button>
        ) : (
          <button
            onClick={handleRefresh}
            disabled={cliStatusLoading}
            className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            <RefreshCw className={cliStatusLoading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {cliStatusLoading ? 'Checking...' : 'Check for Updates'}
          </button>
        )}
      </div>
      {cliStatusError && !cliStatusLoading && (
        <p className="mt-2 text-xs" style={{ color: '#f87171' }}>
          Failed to check for updates. Check your network connection and try again.
        </p>
      )}
    </div>
  );
};
