import { useMemo } from 'react';

import { useStore } from '@renderer/store';

import { namedTeamId } from '../../contracts';

import type { TokenUsageBudgetStatusDto } from '../../contracts';

/** Store adapter: keep the Budget UI presentation-only. */
export function useKnownBudgetTeams(): TokenUsageBudgetStatusDto['options'] {
  const teams = useStore((state) => state.teams);
  return useMemo(
    () => teams.filter((team) => !team.deletedAt).map((team) => ({
      scope: 'team' as const,
      id: namedTeamId(team.teamName),
      label: team.displayName,
    })),
    [teams]
  );
}
