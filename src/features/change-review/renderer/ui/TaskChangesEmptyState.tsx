import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { cn } from '@renderer/lib/utils';
import { AlertTriangle, FileSearch, Info } from 'lucide-react';

import { buildTaskChangesEmptyStatePresentation } from '../view-models/changeReviewPresentation';

import type { TaskChangeSetV2 } from '@shared/types';

export interface TaskChangesEmptyStateProps {
  changeSet: TaskChangeSetV2 | null;
}

const ICONS = {
  alert: AlertTriangle,
  info: Info,
  'file-search': FileSearch,
} as const;

export const TaskChangesEmptyState = ({
  changeSet,
}: TaskChangesEmptyStateProps): React.ReactElement => {
  const { t } = useAppTranslation('team');
  const presentation = buildTaskChangesEmptyStatePresentation(changeSet);
  const Icon = ICONS[presentation.icon];
  const isAttention = presentation.tone === 'attention';

  return (
    <div className="flex w-full items-center justify-center px-6">
      <div className="max-w-xl rounded-lg border border-border bg-surface-sidebar px-5 py-4 text-center">
        <Icon
          className={cn('mx-auto mb-2 size-5', isAttention ? 'text-amber-300' : 'text-text-muted')}
        />
        <div className="text-sm font-medium text-text">{t(presentation.titleKey)}</div>
        <p className="mt-1 text-xs leading-5 text-text-muted">{t(presentation.descriptionKey)}</p>
        {presentation.messages.length > 0 && (
          <div
            className={cn(
              'mt-3 space-y-1 rounded border px-3 py-2 text-left text-xs',
              isAttention
                ? 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                : 'border-border bg-surface-raised text-text-muted'
            )}
          >
            {presentation.messages.map((message, index) => (
              <div key={`${message}:${index}`}>{message}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
