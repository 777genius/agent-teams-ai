/**
 * DashboardUpdateBanner - Compact banner on the dashboard when a new app version is available.
 *
 * Single-line banner: icon + "New version available vX.Y.Z" + action button + dismiss X.
 * Dismissible with localStorage persistence keyed by version —
 * dismissed for v1.3.0 won't suppress the banner when v1.4.0 arrives.
 */

import { useEffect, useState } from 'react';

import { useStore } from '@renderer/store';
import { ArrowUpCircle, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

const DISMISSED_KEY = 'update:dashboard-dismissed-version';

export const DashboardUpdateBanner = (): React.JSX.Element | null => {
  const { updateStatus, availableVersion, openUpdateDialog, installUpdate } = useStore(
    useShallow((s) => ({
      updateStatus: s.updateStatus,
      availableVersion: s.availableVersion,
      openUpdateDialog: s.openUpdateDialog,
      installUpdate: s.installUpdate,
    }))
  );

  const [dismissed, setDismissed] = useState(() => {
    const saved = localStorage.getItem(DISMISSED_KEY);
    return saved === availableVersion;
  });

  // Reset dismissed state when a new version becomes available
  useEffect(() => {
    const saved = localStorage.getItem(DISMISSED_KEY);
    setDismissed(saved === availableVersion);
  }, [availableVersion]);

  if (dismissed) return null;
  if (updateStatus !== 'available' && updateStatus !== 'downloaded') return null;

  const handleDismiss = (): void => {
    if (availableVersion) {
      localStorage.setItem(DISMISSED_KEY, availableVersion);
    }
    setDismissed(true);
  };

  const isDownloaded = updateStatus === 'downloaded';

  return (
    <div
      className="mb-6 flex items-center gap-3 rounded-lg border px-4 py-3"
      style={{
        borderColor: 'rgba(34, 197, 94, 0.3)',
        backgroundColor: 'rgba(34, 197, 94, 0.04)',
      }}
    >
      <ArrowUpCircle className="size-4 shrink-0 text-green-400" />
      <span className="flex-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        New version available{' '}
        {availableVersion && (
          <span className="font-medium text-green-400">v{availableVersion}</span>
        )}
      </span>
      <button
        onClick={isDownloaded ? installUpdate : openUpdateDialog}
        className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/5"
        style={{
          borderColor: 'rgba(34, 197, 94, 0.3)',
          color: '#4ade80',
        }}
      >
        {isDownloaded ? 'Restart now' : 'View details'}
      </button>
      <button
        onClick={handleDismiss}
        className="shrink-0 rounded p-0.5 transition-colors hover:bg-white/10"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
};
