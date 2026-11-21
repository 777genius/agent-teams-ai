import {
  createProjectBoardReviewFlowSync,
  createReviewFlowFeature,
  type ProjectBoard,
  type ProjectTeamReviewFlowPorts,
  type ReviewFlowService,
} from '@features/review-flow/main';
import {
  classifyTeamKind,
  createTeamKindPorts,
  type OwnedExecutionAlias,
  readTeamProjectContextMode,
  TeamProjectContextRegistry,
} from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { TeamDataService } from '@main/services/team/TeamDataService';

const logger = createLogger('IPC:teams:reviewFlow');

type ReviewFlowData = Pick<TeamDataService, 'runConfigurationOperation' | 'setReviewFlowSettings'>;

/** Fail closed, in words that also make sense for an ordinary team. */
const UNREADABLE_TEAM_MESSAGE =
  'The saved settings of this team cannot be read, so its review flow is not changed (it is unknown whether the team keeps a separate history per project). Repair or restore its team.meta.json.';

/**
 * The project-context side of the review flow: what a team name is, the boards of its projects,
 * the setting saved with the team, and the logical-team lock (the one launch admission and
 * definition edits take). The board writes inside it take the board lock of each copy; a board
 * lock is synchronous and never waits for this lock, so the order cannot invert.
 */
function createProjectTeamReviewFlowPorts(
  data: () => Pick<ReviewFlowData, 'runConfigurationOperation'>
): ProjectTeamReviewFlowPorts {
  const metaStore = new TeamMetaStore();
  const getMode = (teamName: string) =>
    readTeamProjectContextMode(metaStore, teamName, UNREADABLE_TEAM_MESSAGE);
  return {
    async kindOf(teamName) {
      const registry = TeamProjectContextRegistry.fromCurrentApp();
      // The one classification; the owner it proves is kept, so the teams are scanned once.
      const proven: { owner: OwnedExecutionAlias | null } = { owner: null };
      const kind = await classifyTeamKind(
        createTeamKindPorts(
          { getMode },
          {
            isOwnedExecutionAlias: async (name) =>
              (proven.owner = await registry.resolveOwnedExecutionAlias(name)) !== null,
          }
        ),
        teamName
      );
      if (kind === 'logical') return 'project-team';
      const { owner } = proven;
      // A copy that an ordinary team kept from an earlier period is still a board of its own.
      return kind === 'alias' && owner && (await getMode(owner.logicalTeamName)) === 'per_project'
        ? 'project-copy'
        : 'board';
    },
    withTeamLock: (teamName, operation) => data().runConfigurationOperation(teamName, operation),
    async readProjectTeam(teamName) {
      const meta = await metaStore.getMeta(teamName);
      if (meta?.projectContextMode !== 'per_project') return undefined;
      const registry = TeamProjectContextRegistry.fromCurrentApp();
      const projects: ProjectBoard[] = [];
      for (const context of await registry.list(teamName)) {
        // A copy whose first launch has not finished has a board once its owned draft exists; a
        // bare reservation gets the setting when the launch creates the copy.
        if (
          context.state === 'reserved' &&
          !(await registry.assertReservedStopOwnership(teamName, context.executionTeamName).then(
            () => true,
            () => false
          ))
        ) {
          continue;
        }
        projects.push({
          executionTeamName: context.executionTeamName,
          projectPath: context.projectPath,
        });
      }
      return { saved: meta.reviewFlowSettings, projects };
    },
    async readTeamSetting(teamName) {
      const meta = await metaStore.getMeta(teamName);
      return meta?.projectContextMode === 'per_project' ? meta.reviewFlowSettings : undefined;
    },
    saveTeamSetting: (teamName, settings) =>
      metaStore.updateMeta(teamName, (current) => {
        if (!current) throw new Error(`Saved settings of team ${teamName} are missing`);
        return { ...current, reviewFlowSettings: settings };
      }),
  };
}

/** The review-flow settings of the app, routed by what a team name means. */
export function createTeamReviewFlowService(data: () => ReviewFlowData): ReviewFlowService {
  return createReviewFlowFeature({
    teamWriter: {
      setReviewFlowSettings: (teamName, settings) =>
        data().setReviewFlowSettings(teamName, settings),
    },
    getClaudeDir: getClaudeBasePath,
    getTeamsDir: getTeamsBasePath,
    projectTeams: createProjectTeamReviewFlowPorts(data),
  });
}

/**
 * Copies the review flow saved with a team into the board of the project copy a launch starts.
 * Best effort: a launch is not refused for it (an ordinary team's launch never depends on its
 * board either). The settings page then lists that project as not carrying the team's setting,
 * and the next save or launch repeats it.
 */
export function createLaunchReviewFlowProjection(
  data: ReviewFlowData
): (teamName: string, executionTeamName: string) => Promise<void> {
  const sync = createProjectBoardReviewFlowSync({
    teamWriter: data,
    getTeamsDir: getTeamsBasePath,
    projectTeams: createProjectTeamReviewFlowPorts(() => data),
  });
  return async (teamName, executionTeamName) => {
    try {
      await sync(teamName, executionTeamName);
    } catch (error) {
      logger.error(
        `Could not apply the review flow of ${teamName} to its project copy ${executionTeamName}: ${String(error)}`
      );
    }
  };
}
