import {
  createTeamTargetPorts,
  projectTeamSummaries,
  resolveTeamTarget,
  TeamProjectContextRegistry,
} from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import type { ResolvedTeamTarget, StopVerification } from '@features/team-project-context/main';
import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamSummary } from '@shared/types';

/**
 * Optional seam of the HTTP services: how routes read team metadata and the
 * project-context registry. Production leaves it unset (the real metadata store
 * and the registry of the running app); tests inject a temp-dir registry.
 */
export interface ProjectContextHttpHooks {
  meta?: {
    getMeta(teamName: string): Promise<TeamMetaFile | null>;
    metadataFileExists(teamName: string): Promise<boolean>;
  };
  registry?: TeamProjectContextRegistry;
  /** How long a stop waits for a context to read as down; tests shorten it. */
  stopVerification?: StopVerification;
}

export interface ProjectContextHttp {
  registry: TeamProjectContextRegistry;
  resolve(teamName: string): Promise<ResolvedTeamTarget>;
  /** Folds project copies into their logical team, like the in-app team list. */
  projectTeams(teams: TeamSummary[]): Promise<TeamSummary[]>;
}

export function createProjectContextHttp(hooks?: ProjectContextHttpHooks): ProjectContextHttp {
  const meta = hooks?.meta ?? new TeamMetaStore();
  const registry = hooks?.registry ?? TeamProjectContextRegistry.fromCurrentApp();
  const ports = createTeamTargetPorts(meta, registry);
  return {
    registry,
    resolve: (teamName) => resolveTeamTarget(ports, teamName),
    projectTeams: (teams) => projectTeamSummaries(teams, meta, registry),
  };
}
