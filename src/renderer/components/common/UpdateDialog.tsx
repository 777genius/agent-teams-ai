/**
 * UpdateDialog - Modal dialog shown when a new version is available.
 *
 * Prompts the user to download the update or dismiss it.
 * Release notes (markdown from GitHub) are rendered with ReactMarkdown.
 * Shows "Restart now" when the update has already been downloaded.
 */

import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';

import { isElectronMode } from '@renderer/api';
import { markdownComponents } from '@renderer/components/chat/markdownComponents';
import { useStore } from '@renderer/store';
import { REHYPE_PLUGINS } from '@renderer/utils/markdownPlugins';
import { ExternalLink, X } from 'lucide-react';
import remarkGfm from 'remark-gfm';

export const UpdateDialog = (): React.JSX.Element | null => {
  const showUpdateDialog = useStore((s) => s.showUpdateDialog);
  const updateStatus = useStore((s) => s.updateStatus);
  const availableVersion = useStore((s) => s.availableVersion);
  const releaseNotes = useStore((s) => s.releaseNotes);
  const downloadUpdate = useStore((s) => s.downloadUpdate);
  const installUpdate = useStore((s) => s.installUpdate);
  const dismissUpdateDialog = useStore((s) => s.dismissUpdateDialog);

  const dialogRef = useRef<HTMLDivElement>(null);

  // Handle ESC key to close dialog
  useEffect(() => {
    if (!showUpdateDialog) return;

    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        dismissUpdateDialog();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showUpdateDialog, dismissUpdateDialog]);

  // Focus trap: keep focus within dialog
  useEffect(() => {
    if (!showUpdateDialog || !dialogRef.current) return;

    const dialog = dialogRef.current;
    const focusableElements = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    // Focus first element when dialog opens
    firstElement?.focus();

    const handleTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        // Shift+Tab: if on first element, go to last
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        // Tab: if on last element, go to first
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    dialog.addEventListener('keydown', handleTab);
    return () => dialog.removeEventListener('keydown', handleTab);
  }, [showUpdateDialog]);

  if (!showUpdateDialog) return null;

  const isDownloaded = updateStatus === 'downloaded';

  // Strip "Downloads" section (and everything after it) from release notes
  const filteredNotes = releaseNotes
    ? releaseNotes.replace(/\n#{1,3}\s+Downloads[\s\S]*$/i, '').trimEnd()
    : releaseNotes;

  const releaseUrl = availableVersion
    ? `https://github.com/777genius/claude_agent_teams_ui/releases/tag/v${availableVersion}`
    : null;

  const openReleaseOnGitHub = (): void => {
    if (!releaseUrl) return;
    if (isElectronMode()) {
      void window.electronAPI.openExternal(releaseUrl);
    } else {
      window.open(releaseUrl, '_blank');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <button
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        onClick={dismissUpdateDialog}
        aria-label="Close dialog"
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="relative mx-4 w-full max-w-2xl rounded-md border p-5 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label="Update available"
        style={{
          backgroundColor: 'var(--color-surface-overlay)',
          borderColor: 'var(--color-border-emphasis)',
        }}
      >
        {/* Close button */}
        <button
          onClick={dismissUpdateDialog}
          className="absolute right-3 top-3 rounded p-1 transition-colors hover:bg-white/10"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <X className="size-4" />
        </button>

        <div className="mb-3 pr-8">
          <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
            {isDownloaded ? 'Update Ready' : 'Update Available'}
          </h2>
          {availableVersion && (
            <div
              className="mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium"
              style={{
                backgroundColor: isDownloaded
                  ? 'rgba(34, 197, 94, 0.15)'
                  : 'rgba(59, 130, 246, 0.15)',
                color: isDownloaded ? '#4ade80' : '#60a5fa',
              }}
            >
              v{availableVersion}
            </div>
          )}
        </div>

        {/* Release notes */}
        <div
          className="prose prose-sm prose-invert mb-4 max-h-[60vh] max-w-none overflow-y-auto rounded border p-3 text-xs"
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
            <p className="italic" style={{ color: 'var(--color-text-muted)' }}>
              No release notes available.
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {releaseUrl && (
            <button
              onClick={openReleaseOnGitHub}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-white/5"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <ExternalLink className="size-3" />
              View on GitHub
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={dismissUpdateDialog}
            className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/5"
            style={{
              borderColor: 'var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}
          >
            Later
          </button>
          {isDownloaded ? (
            <button
              onClick={installUpdate}
              className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-500"
            >
              Restart now
            </button>
          ) : (
            <button
              onClick={downloadUpdate}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Download
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
