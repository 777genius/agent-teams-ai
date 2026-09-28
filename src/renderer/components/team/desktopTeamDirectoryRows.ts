import { buildTeamDirectoryRows } from '@features/team-directory/renderer';
import { getCurrentProvisioningProgressForTeam } from '@renderer/store/slices/teamSlice';
import { isTeamListStatusRunning, resolveTeamStatus } from '@renderer/utils/teamListStatus';

import { teamMatchesProjectSelection } from './teamProjectSelection';

import type {
  DesktopTeamDirectoryRow,
  TeamDirectoryFilter,
} from '@features/team-directory/renderer';
import type { TeamStatus } from '@renderer/utils/teamListStatus';
import type { LeadActivityState, TeamProvisioningProgress, TeamSummary } from '@shared/types';

interface DesktopDirectoryFacts {
  readonly teams: readonly TeamSummary[];
  readonly scopeKey: string;
  readonly aliveTeams: string[];
  readonly aliveReadKnown: boolean;
  readonly provisioningState: {
    readonly currentProvisioningRunIdByTeam: Record<string, string | null>;
    readonly provisioningRuns: Record<string, TeamProvisioningProgress>;
  };
  readonly leadActivityByTeam: Partial<Record<string, LeadActivityState>>;
  readonly currentProjectPath: string | null;
  readonly filter: TeamDirectoryFilter;
  readonly nowMs: number;
}

export interface DesktopDirectoryView {
  readonly teams: TeamSummary[];
  readonly rows: readonly DesktopTeamDirectoryRow[];
  readonly rowByName: ReadonlyMap<string, DesktopTeamDirectoryRow>;
  readonly teamByName: ReadonlyMap<string, TeamSummary>;
  readonly statusByName: ReadonlyMap<string, TeamStatus>;
}

/** Adapts Desktop-only facts; the common directory never imports the store or TeamSummary. */
export function buildDesktopTeamDirectoryView(facts: DesktopDirectoryFacts): DesktopDirectoryView {
  const teamsByName = new Map(facts.teams.map((team) => [team.teamName, team]));
  const statusByName = new Map<string, TeamStatus>();
  const rows: DesktopTeamDirectoryRow[] = facts.teams.map((team) => {
    const status = resolveTeamStatus(
      team,
      team.teamName,
      facts.aliveTeams,
      getCurrentProvisioningProgressForTeam(facts.provisioningState, team.teamName),
      facts.leadActivityByTeam,
      facts.nowMs
    );
    statusByName.set(team.teamName, status);
    const hasIndependentRuntimeEvidence =
      status === 'provisioning' ||
      status === 'partial_skipped' ||
      status === 'partial_failure' ||
      status === 'partial_pending' ||
      facts.leadActivityByTeam[team.teamName] === 'offline';
    const runtime =
      !facts.aliveReadKnown && !hasIndependentRuntimeEvidence
        ? 'unknown'
        : isTeamListStatusRunning(status)
          ? 'running'
          : 'offline';
    const activity = team.lastActivity ? Date.parse(team.lastActivity) : NaN;
    return {
      source: 'desktop',
      scopeKey: facts.scopeKey,
      targetKey: team.teamName,
      teamName: team.teamName,
      displayName: team.displayName,
      description: team.description,
      runtime,
      matchesCurrentProject: facts.currentProjectPath
        ? teamMatchesProjectSelection(team, facts.currentProjectPath)
        : false,
      lastActivityMs: Number.isFinite(activity) ? activity : null,
    };
  });
  const filteredRows = buildTeamDirectoryRows(rows, facts.filter);
  const rowByName = new Map(rows.map((row) => [row.teamName, row]));
  const teams = filteredRows
    .map((row) => teamsByName.get(row.targetKey))
    .filter((team): team is TeamSummary => team !== undefined);
  return { teams, rows, rowByName, teamByName: teamsByName, statusByName };
}
