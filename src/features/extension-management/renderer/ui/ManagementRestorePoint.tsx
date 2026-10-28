import { useAppTranslation, useLocaleFormatters } from '@features/localization/renderer';

import type { ManagementEnvironment } from '../../contracts';

type RestorePoint = NonNullable<ManagementEnvironment['localSkillBackups']>[number];

export const ManagementRestorePoint = ({ backup }: { backup: RestorePoint }) => {
  const { t } = useAppTranslation('extensions');
  const { dateTime } = useLocaleFormatters();
  const recordedAt =
    backup.recordedAt && Number.isFinite(Date.parse(backup.recordedAt))
      ? backup.recordedAt
      : undefined;
  const actionLabel = () => {
    switch (backup.originalAction) {
      case 'upsert':
        return t('uap.restoreBeforeSave');
      case 'delete':
        return t('uap.restoreBeforeDelete');
      case 'restore':
        return t('uap.restoreBeforeRestore');
      default:
        return t('uap.restoreEarlierCopy');
    }
  };
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm font-medium">{backup.skillName}</p>
      <p className="text-xs text-text-muted">
        {actionLabel()} ·{' '}
        {recordedAt ? (
          <time dateTime={recordedAt}>
            {dateTime(recordedAt, { dateStyle: 'medium', timeStyle: 'medium' })}
          </time>
        ) : (
          <>
            {t('uap.restoreTimeUnknown')} ·{' '}
            <span className="font-mono">{backup.operationId.slice(-8)}</span>
          </>
        )}
      </p>
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer">{t('uap.details')}</summary>
        <p className="mt-2 break-all">
          {t('uap.restorePointId')}: {backup.operationId}
        </p>
        <p className="break-all">{backup.path}</p>
      </details>
    </div>
  );
};
