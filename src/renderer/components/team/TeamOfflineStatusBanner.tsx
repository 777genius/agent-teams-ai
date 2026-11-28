import { memo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { buildPendingRuntimeSummaryCopy } from '@renderer/utils/teamLaunchSummaryCopy';
import { Play, Power } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

export const TeamOfflineStatusBanner = memo(function TeamOfflineStatusBanner({
  teamName,
  onLaunch,
}: {
  teamName: string;
  onLaunch: () => void;
}): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const summary = useStore(
    useShallow((s) => {
      const team = s.teamByName[teamName];
      if (!team) {
        return null;
      }

      return {
        memberCount: team.memberCount,
        expectedMemberCount: team.expectedMemberCount,
        confirmedCount: team.confirmedCount,
        runtimeProcessPendingCount: team.runtimeProcessPendingCount,
        teamLaunchState: team.teamLaunchState,
        partialLaunchFailure: team.partialLaunchFailure,
        missingMemberCount: team.missingMembers?.length ?? 0,
      };
    })
  );
  const message =
    summary?.teamLaunchState === 'partial_pending'
      ? summary.runtimeProcessPendingCount != null && summary.runtimeProcessPendingCount > 0
        ? buildPendingRuntimeSummaryCopy({
            confirmedCount: summary.confirmedCount,
            expectedMemberCount: summary.expectedMemberCount,
            memberCount: summary.memberCount,
            runtimeProcessPendingCount: summary.runtimeProcessPendingCount,
          })
        : t('detail.offline.reconciling')
      : summary?.partialLaunchFailure
        ? summary.missingMemberCount > 0
          ? t('detail.offline.partialMissing', {
              missing: summary.missingMemberCount,
              expected: summary.expectedMemberCount ?? summary.missingMemberCount,
            })
          : t('detail.offline.partialFailed')
        : t('detail.offline.offline');
  return (
    <div
      role="status"
      className="relative mb-2.5 flex min-h-11 items-center gap-2.5 overflow-hidden rounded-md border border-amber-500/20 bg-amber-500/[0.055] py-2 pl-3 pr-2.5"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300">
        <Power size={14} />
      </span>
      <span className="min-w-0 flex-1 text-xs font-medium text-[var(--color-text-secondary)]">
        {message}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-700 hover:border-emerald-500/40 hover:bg-emerald-500/15 hover:text-emerald-700 dark:text-emerald-300 dark:hover:text-emerald-200"
        onClick={onLaunch}
      >
        <Play size={12} />
        {t('detail.actions.launch')}
      </Button>
    </div>
  );
});
