import { useStore } from '@renderer/store';

import { findProjectCopyOwner, projectCopyLabel } from '../../core';

/**
 * How a physical team name is shown to a person. A project copy (`ptc-…`) of a
 * per-project team reads as the team and its project; any other name is shown
 * as is. Routing keeps the physical name: only the label changes.
 */
export function useTeamDisplayLabel(teamName: string): string {
  return useStore((state) => projectCopyLabel(state.teams, teamName) ?? teamName);
}

/** The per-project team a project copy belongs to, so a copy does not offer its own team. */
export function useProjectCopyOwnerName(teamName: string): string | undefined {
  return useStore((state) => {
    const owner = findProjectCopyOwner(state.teams, teamName);
    return owner?.perProject ? owner.logicalTeamName : undefined;
  });
}

/** The label of `useTeamDisplayLabel` as text, for places that render inside a loop. */
export const TeamDisplayLabel = ({ teamName }: { teamName: string }): React.JSX.Element => (
  <>{useTeamDisplayLabel(teamName)}</>
);
