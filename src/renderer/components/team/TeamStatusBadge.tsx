import { useAppTranslation } from '@features/localization/renderer';

import { useTeamStartupCopy } from './useTeamStartupCopy';

import type { TeamStatus } from '@renderer/utils/teamListStatus';

export const TeamStatusBadge = ({
  status,
  teamName,
}: {
  status: TeamStatus;
  teamName: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const startupCopy = useTeamStartupCopy(teamName);
  switch (status) {
    case 'active':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
          {t('list.status.active')}
        </span>
      );
    case 'idle':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          {t('list.status.running')}
        </span>
      );
    case 'provisioning':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
          {startupCopy.statusLabel}
        </span>
      );
    case 'offline':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/15 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
          <span className="size-1.5 rounded-full bg-zinc-500" />
          {t('list.status.offline')}
        </span>
      );
    case 'partial_failure':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
          <span className="size-1.5 rounded-full bg-amber-400" />
          {t('list.status.partialFailure')}
        </span>
      );
    case 'partial_skipped':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300">
          <span className="size-1.5 rounded-full bg-sky-300" />
          {t('list.status.partialSkipped')}
        </span>
      );
    case 'partial_pending':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          <span className="size-1.5 rounded-full bg-amber-300" />
          {t('list.status.partialPending')}
        </span>
      );
  }
};
