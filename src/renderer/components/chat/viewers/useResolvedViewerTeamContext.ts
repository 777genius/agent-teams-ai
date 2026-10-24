import React from 'react';

import { useTaskDetailFileLink } from '@features/team-task-detail/renderer';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

const EMPTY_TEAMS: { teamName?: string; displayName?: string; color?: string }[] = [];
const EMPTY_TEAM_COLOR_MAP = new Map<string, string>();
const NOOP_TEAM_CLICK = (): void => undefined;

export function useResolvedViewerTeamContext(
  providedTeamColorByName?: ReadonlyMap<string, string>,
  providedOnTeamClick?: (teamName: string) => void,
  providedTaskOriginTeamName?: string
): {
  teamColorByName: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
  taskOriginTeamName?: string;
  taskOriginContextId?: string;
} {
  const taskOrigin = useTaskDetailFileLink();
  const teams = useStore(useShallow((s) => (providedTeamColorByName ? EMPTY_TEAMS : s.teams)));
  const openTeamTab = useStore((s) => (providedOnTeamClick ? NOOP_TEAM_CLICK : s.openTeamTab));

  const fallbackTeamColorByName = React.useMemo(() => {
    const result = new Map<string, string>();
    for (const team of teams) {
      if (team.teamName) {
        result.set(team.teamName, team.color ?? '');
      }
      if (team.displayName) {
        result.set(team.displayName, team.color ?? '');
      }
    }
    return result;
  }, [teams]);

  return {
    teamColorByName: providedTeamColorByName ?? fallbackTeamColorByName ?? EMPTY_TEAM_COLOR_MAP,
    onTeamClick: providedOnTeamClick ?? openTeamTab,
    taskOriginTeamName: providedTaskOriginTeamName ?? taskOrigin?.teamName,
    taskOriginContextId: taskOrigin?.contextId,
  };
}
