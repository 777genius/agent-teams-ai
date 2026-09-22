import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
  selectTeamMessages,
} from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import type { TeamGraphData } from '../adapters/TeamGraphAdapter';
import type { TeamSummary } from '@shared/types/team';

export function useGraphActivityContext(teamName: string): {
  teamData: TeamGraphData | null;
  teams: TeamSummary[];
} {
  return useStore(
    useShallow((state) => {
      const snapshot = selectTeamDataForName(state, teamName);
      const members = selectResolvedMembersForTeamName(state, teamName);
      const messages = selectTeamMessages(state, teamName);

      return {
        teamData: snapshot
          ? {
              ...snapshot,
              members,
              messageFeed: messages,
            }
          : null,
        teams: state.teams,
      };
    })
  );
}
