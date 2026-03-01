/**
 * Error state for file read failures (EACCES, ENOENT, etc.).
 */

import { AlertTriangle } from 'lucide-react';

interface EditorErrorStateProps {
  error: string;
  onRetry?: () => void;
  onClose?: () => void;
}

export const EditorErrorState = ({
  error,
  onRetry,
  onClose,
}: EditorErrorStateProps): React.ReactElement => {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex h-full flex-col items-center justify-center gap-3 text-text-muted"
    >
      <AlertTriangle aria-hidden="true" className="size-12 text-yellow-500 opacity-50" />
      <p className="max-w-md text-center text-sm text-text-secondary">{error}</p>
      <div className="flex gap-2">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised"
          >
            Retry
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised"
          >
            Close Tab
          </button>
        )}
      </div>
    </div>
  );
};
