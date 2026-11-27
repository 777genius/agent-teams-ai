import { getTeamColorSet } from '@renderer/constants/teamColors';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { getBaseName } from '@renderer/utils/pathUtils';
import { FolderOpen } from 'lucide-react';

import { getRecentTeamProjects } from './teamProjectSelection';

import type { TeamStatus } from '@renderer/utils/teamListStatus';
import type { TeamSummary, TeamSummaryMember } from '@shared/types';
import type React from 'react';

export function folderName(fullPath: string): string {
  return getBaseName(fullPath) || fullPath;
}

export function renderMemberNames(members: TeamSummaryMember[]): React.JSX.Element {
  const teamColorMap = buildMemberColorMap(members);
  return (
    <>
      {members.map((m) => {
        const resolvedColor = teamColorMap.get(m.name);
        const memberColor = resolvedColor ? getTeamColorSet(resolvedColor) : null;
        return (
          <span key={m.name} className="inline-flex items-center gap-1">
            <span
              className="text-[10px] font-medium tracking-wide"
              style={memberColor ? { color: memberColor.text } : undefined}
            >
              {m.name}
            </span>
            {m.role ? (
              <span className="text-[9px] text-[var(--color-text-muted)]">{m.role}</span>
            ) : null}
          </span>
        );
      })}
    </>
  );
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
