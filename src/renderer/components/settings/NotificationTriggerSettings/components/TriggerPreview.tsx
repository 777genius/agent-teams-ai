/**
 * TriggerPreview - Displays test results for a trigger.
 * Used by both TriggerCard and AddTriggerForm.
 */

import { useAppTranslation } from '@features/localization/renderer';
import { AlertTriangle, Loader2 } from 'lucide-react';

import type { PreviewResult } from '../types';
import type { TriggerTestResult } from '@renderer/types/data';

interface TriggerPreviewProps {
  previewResult: PreviewResult | null;
  loading?: boolean;
  onTest: () => void;
  onViewSession: (error: TriggerTestResult['errors'][0]) => void;
  /** Whether this is inside a form (affects button type) */
  isFormContext?: boolean;
}

export const TriggerPreview = ({
  previewResult,
  loading,
  onTest,
  onViewSession,
  isFormContext = false,
}: Readonly<TriggerPreviewProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const isLoading = loading ?? previewResult?.loading;

  // Safeguard: ensure count is at least the errors array length (handles edge cases where totalCount is 0 but errors exist)
  const effectiveCount = previewResult
    ? Math.max(previewResult.totalCount, previewResult.errors.length)
    : 0;

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-text-muted">
          {t('notificationTriggers.preview.title')}
        </span>
        <button
          type={isFormContext ? 'button' : undefined}
          onClick={onTest}
          disabled={isLoading}
          className={`rounded bg-surface-raised px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-overlay ${isLoading ? 'cursor-not-allowed opacity-50' : ''} `}
        >
          {isLoading ? (
            <span className="flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              {t('notificationTriggers.preview.testing')}
            </span>
          ) : (
            t('notificationTriggers.preview.testTrigger')
          )}
        </button>
      </div>

      {previewResult && !previewResult.loading && (
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">
            <span className="font-medium text-indigo-400">
              {previewResult.truncated && effectiveCount >= 10_000 ? '10,000+' : effectiveCount}
            </span>{' '}
            {t('notificationTriggers.preview.detectedSuffix')}
          </p>

          {/* Truncation warning - only shown when timeout or count limit hit */}
          {previewResult.truncated && (
            <div
              className="flex items-center gap-2 rounded border px-3 py-2 text-xs"
              style={{
                backgroundColor: 'var(--warning-bg)',
                borderColor: 'var(--warning-border)',
                color: 'var(--warning-text)',
              }}
            >
              <AlertTriangle className="size-4 shrink-0" />
              <span>{t('notificationTriggers.preview.truncatedWarning')}</span>
            </div>
          )}

          {previewResult.errors.slice(0, 10).map((error, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between border-b border-border-subtle py-2 text-xs"
            >
              <div className="mr-2 min-w-0 flex-1">
                <span className="text-text-muted">{error.context.projectName}</span>
                <span className="mx-1 text-text-muted">|</span>
                <span className="truncate text-text-secondary">
                  {error.message.length > 60 ? `${error.message.slice(0, 60)}...` : error.message}
                </span>
              </div>
              <button
                type={isFormContext ? 'button' : undefined}
                onClick={() => onViewSession(error)}
                className="shrink-0 rounded px-2 py-1 text-indigo-400 transition-colors hover:bg-indigo-500/10"
              >
                {t('notificationTriggers.preview.viewSession')}
              </button>
            </div>
          ))}

          {effectiveCount > 10 && (
            <p className="text-xs text-text-muted">
              {t('notificationTriggers.preview.more', { count: effectiveCount - 10 })}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
