import { useAppTranslation } from '@features/localization/renderer';

import { useMemberWorkSyncStatus } from '../hooks/useMemberWorkSyncStatus';

import { MemberWorkSyncBadge } from './MemberWorkSyncBadge';
import { MemberWorkSyncDetails } from './MemberWorkSyncDetails';

import type React from 'react';

type MemberWorkSyncStatusPanelProps = Readonly<{
  teamName: string;
  memberName: string;
  enabled?: boolean;
  showDiagnostics?: boolean;
}>;

export function MemberWorkSyncStatusPanel({
  teamName,
  memberName,
  enabled = true,
  showDiagnostics = false,
}: MemberWorkSyncStatusPanelProps): React.ReactElement | null {
  const { t } = useAppTranslation('team');
  const { status, viewModel, loading, error } = useMemberWorkSyncStatus({
    teamName,
    memberName,
    enabled,
  });

  if (!enabled) {
    return null;
  }

  if (status) {
    return <MemberWorkSyncDetails status={status} showDiagnostics={showDiagnostics} />;
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-text)]">
            {t('memberWorkSync.title')}
          </h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {loading
              ? t('memberWorkSync.loadingDiagnostics')
              : error
                ? t('memberWorkSync.diagnosticsUnavailable')
                : viewModel.tooltip}
          </p>
        </div>
        <MemberWorkSyncBadge viewModel={viewModel} />
      </div>
    </section>
  );
}
