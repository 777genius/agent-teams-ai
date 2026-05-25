import { useAppTranslation } from '@features/localization/renderer';

import { toMemberWorkSyncStatusViewModel } from '../adapters/memberWorkSyncStatusViewModel';

import { MemberWorkSyncBadge } from './MemberWorkSyncBadge';

import type { MemberWorkSyncStatus } from '../../contracts';
import type React from 'react';

type MemberWorkSyncDetailsProps = Readonly<{
  status: MemberWorkSyncStatus | null;
  showDiagnostics?: boolean;
}>;

function shortFingerprint(fingerprint?: string): string {
  if (!fingerprint) {
    return 'unknown';
  }
  const suffix = fingerprint.split(':').at(-1) ?? fingerprint;
  return suffix.length > 12 ? `${suffix.slice(0, 12)}...` : suffix;
}

export function MemberWorkSyncDetails({
  status,
  showDiagnostics = false,
}: MemberWorkSyncDetailsProps): React.ReactElement {
  const { t } = useAppTranslation('team');
  const viewModel = toMemberWorkSyncStatusViewModel(status);
  const agendaItems = status?.agenda.items ?? [];

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-text)]">
            {t('memberWorkSync.details.title')}
          </h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{viewModel.tooltip}</p>
        </div>
        <MemberWorkSyncBadge viewModel={viewModel} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-[var(--color-text-muted)]">
            {t('memberWorkSync.details.actionableItems')}
          </dt>
          <dd className="font-medium text-[var(--color-text)]">{viewModel.actionableCount}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-text-muted)]">
            {t('memberWorkSync.details.fingerprint')}
          </dt>
          <dd className="font-mono text-[var(--color-text)]">
            {shortFingerprint(viewModel.fingerprint)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--color-text-muted)]">{t('memberWorkSync.details.report')}</dt>
          <dd className="font-medium text-[var(--color-text)]">
            {viewModel.reportState ?? t('memberWorkSync.details.none')}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--color-text-muted)]">
            {t('memberWorkSync.details.shadowWouldNudge')}
          </dt>
          <dd className="font-medium text-[var(--color-text)]">
            {viewModel.wouldNudge
              ? t('memberWorkSync.details.yes')
              : t('memberWorkSync.details.no')}
          </dd>
        </div>
      </dl>

      {agendaItems.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-[var(--color-text-secondary)]">
          {agendaItems.slice(0, 3).map((item) => (
            <li key={`${item.kind}:${item.taskId}`} className="truncate">
              #{item.displayId ?? item.taskId.slice(0, 8)} - {item.kind} - {item.subject}
            </li>
          ))}
          {agendaItems.length > 3 ? (
            <li className="text-[var(--color-text-muted)]">
              {t('memberWorkSync.details.moreActionableItems', { count: agendaItems.length - 3 })}
            </li>
          ) : null}
        </ul>
      ) : null}

      {showDiagnostics && status?.diagnostics.length ? (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          {t('memberWorkSync.details.diagnostics', { diagnostics: status.diagnostics.join(', ') })}
        </p>
      ) : null}
    </section>
  );
}
