import { useAppTranslation } from '@features/localization/renderer';

import type { JSX } from 'react';

/**
 * Empty state for ChatHistory when no conversation exists.
 */
export const ChatHistoryEmptyState = (): JSX.Element => {
  const { t } = useAppTranslation('common');
  return (
    <div className="flex flex-1 items-center justify-center overflow-hidden bg-surface">
      <div className="space-y-2 text-center text-text-muted">
        <div className="mb-4 text-6xl" aria-hidden="true">
          {t('chat.empty.icon')}
        </div>
        <div className="text-xl font-medium text-text-secondary">{t('chat.empty.title')}</div>
        <div className="text-sm">{t('chat.empty.description')}</div>
      </div>
    </div>
  );
};
