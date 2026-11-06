import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { cn } from '@renderer/lib/utils';
import { classifyTaskChangeReviewability } from '@shared/utils/taskChangeReviewability';
import { AlertTriangle, FileSearch, Info } from 'lucide-react';

import type { TaskChangeSetV2 } from '@shared/types';

export const TaskChangesEmptyState = ({
  changeSet,
}: {
  changeSet: TaskChangeSetV2 | null;
}): React.ReactElement => {
  const { t } = useAppTranslation('team');
  const status = changeSet ? classifyTaskChangeReviewability(changeSet) : null;
  const diagnosticMessages =
    status && status.diagnostics.length > 0
      ? status.diagnostics.map((diagnostic) => diagnostic.message)
      : (changeSet?.warnings ?? []);
  const uniqueMessages = [
    ...new Set(diagnosticMessages.filter((message) => message.trim().length > 0)),
  ];
  const isAttention = status?.reviewability === 'attention_required';
  const isDiagnosticOnly = status?.reviewability === 'diagnostic_only';
  const isNoSafeDiff = isAttention || isDiagnosticOnly;
  const hasDiagnosticContext = uniqueMessages.length > 0;
  const Icon = isAttention ? AlertTriangle : hasDiagnosticContext ? Info : FileSearch;
  const title = isDiagnosticOnly
    ? t('review.empty.noSafeDiff')
    : isAttention
      ? t('review.continuousScroll.empty')
      : t('review.empty.noFileChangesRecorded');
  const description = isNoSafeDiff
    ? isDiagnosticOnly
      ? t('review.empty.noSafeDiffDescription')
      : t('review.empty.noSafeDiffDiagnosticsDescription')
    : hasDiagnosticContext
      ? t('review.empty.noFileEventsYet')
      : t('review.empty.noFileEvents');

  return (
    <div className="flex w-full items-center justify-center px-6">
      <div className="max-w-xl rounded-lg border border-border bg-surface-sidebar px-5 py-4 text-center">
        <Icon
          className={cn('mx-auto mb-2 size-5', isAttention ? 'text-amber-300' : 'text-text-muted')}
        />
        <div className="text-sm font-medium text-text">{title}</div>
        <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
        {uniqueMessages.length > 0 && (
          <div
            className={cn(
              'mt-3 space-y-1 rounded border px-3 py-2 text-left text-xs',
              isAttention
                ? 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                : 'border-border bg-surface-raised text-text-muted'
            )}
          >
            {uniqueMessages.map((message, index) => (
              <div key={`${message}:${index}`}>{message}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
