/**
 * Error state for file read failures (EACCES, ENOENT, etc.).
 */

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
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
  const { t } = useAppTranslation('team');
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
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('editor.actions.retry')}
          </Button>
        )}
        {onClose && (
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('editor.actions.closeTab')}
          </Button>
        )}
      </div>
    </div>
  );
};
