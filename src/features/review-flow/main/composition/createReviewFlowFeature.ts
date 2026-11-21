import { ReviewFlowService } from '../../core/application';
import { ControllerReviewFlowDefaultsStore } from '../adapters/output/ControllerReviewFlowDefaultsStore';
import { syncProjectBoardReviewFlow } from '../adapters/output/projectTeamReviewFlow';
import {
  TeamKanbanReviewFlowGateway,
  type TeamReviewFlowWriter,
} from '../adapters/output/TeamKanbanReviewFlowGateway';
import { readBoardReviewFlow } from '../infrastructure/scanTeamReviewFlowOverrides';

import type { ReviewFlowSettings } from '../../contracts/types';
import type { ProjectTeamReviewFlowPorts } from '../adapters/output/projectTeamReviewFlow';

export interface ReviewFlowFeatureDeps {
  teamWriter: TeamReviewFlowWriter;
  getClaudeDir: () => string;
  getTeamsDir: () => string;
  /** Where a team with separate history per project keeps its one review flow. */
  projectTeams: ProjectTeamReviewFlowPorts;
}

export function createReviewFlowFeature(deps: ReviewFlowFeatureDeps): ReviewFlowService {
  return new ReviewFlowService({
    defaults: new ControllerReviewFlowDefaultsStore(deps.getClaudeDir),
    teams: new TeamKanbanReviewFlowGateway(deps.teamWriter, deps.getTeamsDir, deps.projectTeams),
  });
}

/**
 * Brings the board of one project copy to the review flow saved with its team (a launch calls it
 * for the copy it starts). Resolves to whether the board was written.
 */
export function createProjectBoardReviewFlowSync(deps: {
  teamWriter: TeamReviewFlowWriter;
  getTeamsDir: () => string;
  projectTeams: Pick<ProjectTeamReviewFlowPorts, 'readTeamSetting'>;
}): (teamName: string, executionTeamName: string) => Promise<boolean> {
  const board = {
    read: async (teamName: string) => {
      const state = await readBoardReviewFlow(deps.getTeamsDir(), teamName);
      if (state.kind === 'override') return state.settings;
      return state.kind === 'follows-default' ? null : ('unknown' as const);
    },
    write: (teamName: string, settings: ReviewFlowSettings | null) =>
      deps.teamWriter.setReviewFlowSettings(teamName, settings),
  };
  return (teamName, executionTeamName) =>
    syncProjectBoardReviewFlow(deps.projectTeams, board, teamName, executionTeamName);
}
