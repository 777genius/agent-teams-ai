/** Update details and recovery instructions for OTA updater failures. */
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import { useAppTranslation } from '@features/localization/renderer';
import { api, isElectronMode } from '@renderer/api';
import { markdownComponents } from '@renderer/components/chat/markdownComponents';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useStore } from '@renderer/store';
import { REHYPE_PLUGINS } from '@renderer/utils/markdownPlugins';
import { stripDownloadsSection } from '@shared/utils/releaseNotes';
import { APP_DOWNLOAD_URL, classifyUpdaterFailure } from '@shared/utils/updaterRecovery';
import { ExternalLink } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { useShallow } from 'zustand/react/shallow';

export const UpdateDialog = (): React.JSX.Element | null => {
  const { t } = useAppTranslation('common');
  const {
    showUpdateDialog,
    updateStatus,
    updateError,
    updateOperation,
    availableVersion,
    releaseNotes,
    downloadProgress,
    downloadUpdate,
    installUpdate,
    retryUpdate,
    closeUpdateDialog,
    dismissUpdateDialog,
  } = useStore(
    useShallow((s) => ({
      showUpdateDialog: s.showUpdateDialog,
      updateStatus: s.updateStatus,
      updateError: s.updateError,
      updateOperation: s.updateOperation,
      availableVersion: s.availableVersion,
      releaseNotes: s.releaseNotes,
      downloadProgress: s.downloadProgress,
      downloadUpdate: s.downloadUpdate,
      installUpdate: s.installUpdate,
      retryUpdate: s.retryUpdate,
      closeUpdateDialog: s.closeUpdateDialog,
      dismissUpdateDialog: s.dismissUpdateDialog,
    }))
  );
  const [linkError, setLinkError] = useState(false);
  useEffect(() => setLinkError(false), [showUpdateDialog, updateStatus]);

  if (!showUpdateDialog) return null;

  const isError = updateStatus === 'error' && !!updateError;
  const isDownloaded = updateStatus === 'downloaded' && !updateError;
  const isBusy = updateStatus === 'downloading' || updateStatus === 'checking';
  const failureKind = classifyUpdaterFailure(updateError ?? '');
  const isMac = /Mac/i.test(navigator.platform);
  const title = isError
    ? t('updateDialog.errorTitle')
    : isDownloaded
      ? t('updateDialog.updateReady')
      : t('updateDialog.updateAvailable');
  const filteredNotes = releaseNotes ? stripDownloadsSection(releaseNotes) : releaseNotes;
  const releaseUrl = availableVersion
    ? `https://github.com/777genius/agent-teams-ai/releases/tag/v${availableVersion}`
    : null;

  const openLink = async (url: string): Promise<void> => {
    setLinkError(false);
    try {
      if (isElectronMode()) {
        const result = await api.openExternal(url);
        if (!result.success) setLinkError(true);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch {
      setLinkError(true);
    }
  };

  return (
    <Dialog open={showUpdateDialog} onOpenChange={(open) => !open && closeUpdateDialog()}>
      <DialogContent
        data-testid="update-dialog"
        className="max-w-2xl gap-3 rounded-md p-5"
        style={{
          backgroundColor: 'var(--color-surface-overlay)',
          borderColor: 'var(--color-border-emphasis)',
        }}
      >
        <div className="pr-8">
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
          {availableVersion && (
            <div
              className="mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium"
              style={{
                backgroundColor: isDownloaded
                  ? 'rgba(34, 197, 94, 0.15)'
                  : 'rgba(59, 130, 246, 0.15)',
                color: isDownloaded ? 'var(--color-positive-text)' : '#60a5fa',
              }}
            >
              v{availableVersion}
            </div>
          )}
        </div>

        {isError ? (
          <div
            data-testid="update-error"
            role="alert"
            className="space-y-3 text-sm text-[var(--color-text-secondary)]"
          >
            <p>{t(`updateDialog.recovery.${failureKind}`)}</p>
            <p>{t(isMac ? 'updateDialog.manualMac' : 'updateDialog.manualOther')}</p>
            <p>{t('updateDialog.keepData')}</p>
            <details className="rounded border border-[var(--color-border)] p-3 text-xs">
              <summary className="cursor-pointer">{t('updateDialog.errorDetails')}</summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words">
                {updateError}
              </pre>
            </details>
          </div>
        ) : (
          <div
            className="prose prose-sm prose-invert max-h-[60vh] max-w-none overflow-y-auto rounded border p-3 text-xs"
            style={{
              backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {filteredNotes ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
              >
                {filteredNotes}
              </ReactMarkdown>
            ) : (
              <p className="italic text-[var(--color-text-muted)]">
                {t('updateDialog.noReleaseNotes')}
              </p>
            )}
          </div>
        )}

        {linkError && (
          <p role="alert" className="break-words text-sm text-[var(--color-text-secondary)]">
            {t('updateDialog.openLinkFailed')} {APP_DOWNLOAD_URL}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {releaseUrl && !isError && (
            <button
              onClick={() => void openLink(releaseUrl)}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-white/5"
            >
              <ExternalLink className="size-3" />
              {t('updateDialog.viewOnGitHub')}
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={isError ? closeUpdateDialog : dismissUpdateDialog}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-white/5"
          >
            {isError ? t('actions.close') : t('updateDialog.later')}
          </button>
          {isError ? (
            <>
              {failureKind === 'network' && (
                <button
                  data-testid="update-retry"
                  onClick={retryUpdate}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)]"
                >
                  {t('updateDialog.retry')}
                </button>
              )}
              <button
                data-testid="update-manual-download"
                onClick={() => void openLink(APP_DOWNLOAD_URL)}
                className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
              >
                <ExternalLink className="size-3.5" />
                {t('updateDialog.manualDownload')}
              </button>
            </>
          ) : isDownloaded ? (
            <button
              onClick={installUpdate}
              disabled={updateOperation === 'install'}
              className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:opacity-50"
            >
              {t('updateDialog.restartNow')}
            </button>
          ) : (
            <button
              onClick={downloadUpdate}
              disabled={isBusy || updateStatus !== 'available' || !availableVersion}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {updateStatus === 'downloading'
                ? `${t('updates.updatingApp')} ${Math.round(downloadProgress)}%`
                : updateStatus === 'checking'
                  ? t('updateDialog.checking')
                  : t('updateDialog.download')}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
