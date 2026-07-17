/**
 * UpdateBanner - Slim top banner for download progress and restart prompt.
 *
 * Visible during download and after the update is ready to install.
 */

import { useAppTranslation } from '@features/localization/renderer';
import { isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';
import { CheckCircle, Loader2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

export const UpdateBanner = (): React.JSX.Element | null => {
  const { t } = useAppTranslation('common');
  const {
    showUpdateBanner,
    updateStatus,
    downloadProgress,
    availableVersion,
    installUpdate,
    dismissUpdateBanner,
  } = useStore(
    useShallow((s) => ({
      showUpdateBanner: s.showUpdateBanner,
      updateStatus: s.updateStatus,
      downloadProgress: s.downloadProgress,
      availableVersion: s.availableVersion,
      installUpdate: s.installUpdate,
      dismissUpdateBanner: s.dismissUpdateBanner,
    }))
  );

  if (!showUpdateBanner || (updateStatus !== 'downloading' && updateStatus !== 'downloaded')) {
    return null;
  }

  const isDownloading = updateStatus === 'downloading';
  const percent = Math.round(downloadProgress);
  const clampedPercent = Math.max(0, Math.min(percent, 100));
  const isMacElectron =
    isElectronMode() && window.navigator.userAgent.toLowerCase().includes('mac');

  return (
    <div
      className="relative border-b px-4 py-2.5"
      style={
        {
          backgroundColor: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
          paddingLeft: isMacElectron ? 'var(--macos-traffic-light-padding-left, 72px)' : undefined,
          WebkitAppRegion: isMacElectron ? 'drag' : undefined,
        } as React.CSSProperties
      }
    >
      {isDownloading ? (
        <div className="pr-8">
          <div
            className="mb-1.5 flex items-center gap-2 text-xs"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
            <span>{t('updates.updatingApp')}</span>
            <span className="tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
              {clampedPercent}%
            </span>
          </div>
          <div
            className="h-1 w-full overflow-hidden rounded-full"
            style={{ backgroundColor: 'var(--color-border)' }}
          >
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-300 ease-out dark:bg-blue-500"
              style={{ width: `${clampedPercent}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pr-8">
          <CheckCircle className="size-4 shrink-0 text-green-400" />
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {t('updates.updateReady')}
            {availableVersion ? (
              <span className="ml-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                v{availableVersion}
              </span>
            ) : null}
          </span>
          <button
            onClick={installUpdate}
            className="ml-auto rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/5"
            style={
              {
                borderColor: 'var(--color-border-emphasis)',
                color: 'var(--color-text)',
                WebkitAppRegion: isMacElectron ? 'no-drag' : undefined,
              } as React.CSSProperties
            }
          >
            {t('updates.restartNow')}
          </button>
        </div>
      )}

      {/* Dismiss */}
      <button
        onClick={dismissUpdateBanner}
        className="absolute right-3 top-1/2 shrink-0 -translate-y-1/2 rounded p-0.5 transition-colors hover:bg-white/10"
        style={
          {
            color: 'var(--color-text-muted)',
            WebkitAppRegion: isMacElectron ? 'no-drag' : undefined,
          } as React.CSSProperties
        }
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
};
