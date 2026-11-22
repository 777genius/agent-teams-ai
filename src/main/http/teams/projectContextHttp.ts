import {
  createProjectBoardPorts,
  createTeamTargetPorts,
  projectTeamSummaries,
  resolveProjectBoardTarget,
  resolveTeamTarget,
  TeamProjectContextRegistry,
} from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import type {
  ProjectBoardTarget,
  ResolvedTeamTarget,
  StopVerification,
  TeamModeMetaReader,
} from '@features/team-project-context/main';
import type { TeamSummary } from '@shared/types';

/**
 * Optional seam of the HTTP services: how routes read team metadata and the
 * project-context registry. Production leaves it unset (the real metadata store
 * and the registry of the running app); tests inject a temp-dir registry.
 */
export interface ProjectContextHttpHooks {
  meta?: TeamModeMetaReader;
  registry?: TeamProjectContextRegistry;
  /** How long a stop waits for a context to read as down; tests shorten it. */
  stopVerification?: StopVerification;
}

export interface ProjectContextHttp {
  registry: TeamProjectContextRegistry;
  resolve(teamName: string): Promise<ResolvedTeamTarget>;
  /** Folds project copies into their logical team, like the in-app team list. */
  projectTeams(teams: TeamSummary[]): Promise<TeamSummary[]>;
  /**
   * The team whose board the MCP board tools use for a team name and a project. `isLaunching`
   * tells a launch in flight from one that failed.
   */
  boardTarget(
    teamName: string,
    projectPath: string | undefined,
    isLaunching?: (teamName: string) => boolean
  ): Promise<ProjectBoardTarget>;
}

export function createProjectContextHttp(hooks?: ProjectContextHttpHooks): ProjectContextHttp {
  const meta = hooks?.meta ?? new TeamMetaStore();
  const registry = hooks?.registry ?? TeamProjectContextRegistry.fromCurrentApp();
  const ports = createTeamTargetPorts(meta, registry);
  return {
    registry,
    resolve: (teamName) => resolveTeamTarget(ports, teamName),
    projectTeams: (teams) => projectTeamSummaries(teams, meta, registry),
    boardTarget: (teamName, projectPath, isLaunching) =>
      resolveProjectBoardTarget(createProjectBoardPorts(meta, registry, isLaunching), {
        teamName,
        projectPath,
      }),
  };
}
