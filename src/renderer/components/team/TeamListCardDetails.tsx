import { normalizePath } from '@renderer/utils/pathNormalize';
import { getBaseName } from '@renderer/utils/pathUtils';
import { buildPendingRuntimeSummaryCopy } from '@renderer/utils/teamLaunchSummaryCopy';
import { FolderOpen } from 'lucide-react';

import { getRecentTeamProjects } from './teamProjectSelection';

import type { useAppTranslation } from '@features/localization/renderer';
import type { TeamStatus } from '@renderer/utils/teamListStatus';
import type { TeamSummary } from '@shared/types';
import type React from 'react';

export function folderName(fullPath: string): string {
  return getBaseName(fullPath) || fullPath;
}

export { renderMemberNames } from './teamListMemberNames';

export function renderTeamLaunchSummary(
  team: TeamSummary,
  t: ReturnType<typeof useAppTranslation>['t']
): React.JSX.Element | null {
  return team.teamLaunchState === 'partial_pending' ? (
    <p className="mt-2 text-[11px] text-amber-300">
      {team.runtimeProcessPendingCount && team.runtimeProcessPendingCount > 0
        ? buildPendingRuntimeSummaryCopy({
            confirmedCount: team.confirmedCount,
            expectedMemberCount: team.expectedMemberCount,
            memberCount: team.memberCount,
            runtimeProcessPendingCount: team.runtimeProcessPendingCount,
            includePeriod: true,
          })
        : t('list.partial.pending')}
    </p>
  ) : team.partialLaunchFailure || team.teamLaunchState === 'partial_failure' ? (
    <p className="mt-2 text-[11px] text-amber-400">
      {team.missingMembers?.length
        ? t('detail.offline.partialMissing', {
            missing: team.missingMembers.length,
            expected: team.expectedMemberCount ?? team.missingMembers.length,
          })
        : t('detail.offline.partialFailed')}
    </p>
  ) : team.teamLaunchState === 'partial_skipped' ? (
    <p className="mt-2 text-[11px] text-sky-300">
      {team.skippedMembers?.length
        ? t('list.partial.skippedWithCount', {
            count: team.skippedMembers.length,
            expected: team.expectedMemberCount ?? team.skippedMembers.length,
          })
        : t('list.partial.skipped')}
    </p>
  ) : null;
}

export function renderTeamRecentPaths(
  team: TeamSummary,
  status: TeamStatus,
  matchesCurrentProject: boolean,
  isLight: boolean,
  selectedProjectPath: string | null
): React.JSX.Element | null {
  const recentPaths = getRecentTeamProjects(team);
  const visibleRecentPaths =
    matchesCurrentProject && selectedProjectPath
      ? recentPaths.filter((path) => normalizePath(path) !== normalizePath(selectedProjectPath))
      : recentPaths;
  if (visibleRecentPaths.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
      {matchesCurrentProject && !selectedProjectPath ? (
        <span
          className={`inline-flex items-center gap-1 truncate rounded-full px-2 py-0.5 text-[12px] font-medium ${
            isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-500/15 text-emerald-400'
          }`}
        >
          <FolderOpen size={12} className="shrink-0" />
          {visibleRecentPaths.map((p, i) => (
            <span key={p} title={p}>
              {folderName(p)}
              {i < visibleRecentPaths.length - 1 ? ', ' : ''}
            </span>
          ))}
        </span>
      ) : (
        <>
          <FolderOpen size={10} className="shrink-0" />
          <span className="truncate">
            {visibleRecentPaths.map((p, i) => (
              <span key={p} title={p}>
                {i === 0 && (status === 'active' || status === 'idle') ? (
                  <span className="text-emerald-400">{folderName(p)}</span>
                ) : (
                  folderName(p)
                )}
                {i < visibleRecentPaths.length - 1 ? ', ' : ''}
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}
