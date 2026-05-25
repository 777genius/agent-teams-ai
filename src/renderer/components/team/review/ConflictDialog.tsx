import { useCallback, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { cn } from '@renderer/lib/utils';
import { AlertTriangle, X } from 'lucide-react';

interface ConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  conflictContent: string;
  onResolveKeepCurrent: () => void;
  onResolveUseOriginal: () => void;
  onResolveManual: (content: string) => void;
}

export const ConflictDialog = ({
  open,
  onOpenChange,
  filePath,
  conflictContent,
  onResolveKeepCurrent,
  onResolveUseOriginal,
  onResolveManual,
}: ConflictDialogProps) => {
  const { t } = useAppTranslation('team');
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState(conflictContent);

  const handleManualSave = useCallback(() => {
    onResolveManual(editContent);
    setEditMode(false);
  }, [editContent, onResolveManual]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <AlertTriangle className="size-4 text-yellow-400" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-text">{t('review.conflict.title')}</h3>
            <p className="text-xs text-text-muted">{t('review.conflict.description')}</p>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* File path */}
        <div className="border-b border-border bg-surface-raised px-4 py-2">
          <span className="font-mono text-xs text-text-secondary">{filePath}</span>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {editMode ? (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="h-64 w-full resize-y rounded border border-border bg-surface p-3 font-mono text-xs text-text focus:border-blue-500/50 focus:outline-none"
              spellCheck={false}
            />
          ) : (
            <div className="max-h-64 overflow-auto rounded border border-border bg-surface font-mono text-xs leading-5">
              {conflictContent.split('\n').map((line, i) => {
                const isMarker =
                  line.startsWith('<<<<<<<') ||
                  line.startsWith('=======') ||
                  line.startsWith('>>>>>>>');
                const lineClass = isMarker
                  ? 'px-3 bg-yellow-500/10 text-yellow-400 font-medium'
                  : 'px-3 text-text-secondary';

                return (
                  <div key={i} className={lineClass}>
                    <span className="mr-3 inline-block w-8 text-right text-text-muted opacity-50">
                      {i + 1}
                    </span>
                    <span className="whitespace-pre">{line}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {editMode ? (
            <>
              <button
                onClick={() => setEditMode(false)}
                className="rounded px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
              >
                {t('review.conflict.cancel')}
              </button>
              <button
                onClick={handleManualSave}
                className="rounded bg-blue-500/20 px-3 py-1.5 text-xs text-blue-400 transition-colors hover:bg-blue-500/30"
              >
                {t('review.conflict.saveResolution')}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setEditContent(conflictContent);
                  setEditMode(true);
                }}
                className="rounded px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
              >
                {t('review.conflict.editManually')}
              </button>
              <button
                onClick={onResolveUseOriginal}
                className={cn(
                  'rounded px-3 py-1.5 text-xs transition-colors',
                  'bg-red-500/15 text-red-400 hover:bg-red-500/25'
                )}
              >
                {t('review.conflict.useOriginal')}
              </button>
              <button
                onClick={onResolveKeepCurrent}
                className={cn(
                  'rounded px-3 py-1.5 text-xs transition-colors',
                  'bg-green-500/15 text-green-400 hover:bg-green-500/25'
                )}
              >
                {t('review.conflict.keepCurrent')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
