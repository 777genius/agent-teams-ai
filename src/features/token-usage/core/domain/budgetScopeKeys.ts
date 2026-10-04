import { teamIdentityLabel,teamIdForName } from '../../contracts';

import type { TokenUsageRunDto } from '../../contracts';

export function runTeamKey(run: TokenUsageRunDto): {
  id: string;
  label: string;
  teamName?: string;
} {
  return {
    id: teamIdForName(run.teamName),
    label: teamIdentityLabel(teamIdForName(run.teamName)),
    teamName: run.teamName,
  };
}

export function runProjectKey(run: TokenUsageRunDto): {
  id: string;
  label: string;
  teamName?: string;
} {
  const id = run.workspacePathHash ? `project:${run.workspacePathHash}` : 'unknown-project';
  const label =
    run.workspaceLabel ??
    (run.workspacePathHash ? `Project ${run.workspacePathHash.slice(0, 12)}` : 'Unknown project');
  return {
    id,
    label,
    teamName: run.teamName,
  };
}
