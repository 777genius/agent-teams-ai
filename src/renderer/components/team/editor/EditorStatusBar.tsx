/**
 * Status bar: cursor position, language, encoding, indent style, git branch.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { GitBranch } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

interface EditorStatusBarProps {
  line: number;
  col: number;
  language: string;
}

export const EditorStatusBar = React.memo(function EditorStatusBar({
  line,
  col,
  language,
}: EditorStatusBarProps): React.ReactElement {
  const { t } = useAppTranslation('team');
  const { gitBranch, isGitRepo, watcherEnabled } = useStore(
    useShallow((s) => ({
      gitBranch: s.editorGitBranch,
      isGitRepo: s.editorIsGitRepo,
      watcherEnabled: s.editorWatcherEnabled,
    }))
  );
  const toggleWatcher = useStore((s) => s.toggleWatcher);

  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-surface-sidebar px-3 text-[11px] text-text-muted">
      <div className="flex items-center gap-4">
        <span>{t('editor.statusBar.position', { line, col })}</span>
        {isGitRepo && gitBranch && (
          <span className="flex items-center gap-1">
            <GitBranch className="size-3" />
            {gitBranch}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void toggleWatcher(!watcherEnabled)}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                watcherEnabled
                  ? 'bg-green-500/15 text-green-400 hover:bg-green-500/20'
                  : 'text-text-muted hover:bg-surface-raised hover:text-text-secondary'
              }`}
              aria-label={
                watcherEnabled
                  ? t('editor.statusBar.disableWatcher')
                  : t('editor.statusBar.enableWatcher')
              }
              aria-pressed={watcherEnabled}
            >
              {watcherEnabled ? t('editor.statusBar.watching') : t('editor.statusBar.watch')}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {watcherEnabled
              ? t('editor.statusBar.disableExternalWatcher')
              : t('editor.statusBar.watchExternalChanges')}
          </TooltipContent>
        </Tooltip>
        <span>{language}</span>
        <span>{t('editor.statusBar.encodingUtf8')}</span>
        <span>{t('editor.statusBar.spaces', { count: 2 })}</span>
      </div>
    </div>
  );
});
