import { readTeamProjectContextMode } from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import { ReviewFlowService } from '../../core/application';
import { ControllerReviewFlowDefaultsStore } from '../adapters/output/ControllerReviewFlowDefaultsStore';
import {
  TeamKanbanReviewFlowGateway,
  type TeamReviewFlowWriter,
} from '../adapters/output/TeamKanbanReviewFlowGateway';

export interface ReviewFlowFeatureDeps {
  teamWriter: TeamReviewFlowWriter;
  getClaudeDir: () => string;
  getTeamsDir: () => string;
}

export function createReviewFlowFeature(deps: ReviewFlowFeatureDeps): ReviewFlowService {
  return new ReviewFlowService({
    defaults: new ControllerReviewFlowDefaultsStore(deps.getClaudeDir),
    teams: new TeamKanbanReviewFlowGateway(deps.teamWriter, deps.getTeamsDir, (teamName) => {
      const metaStore = new TeamMetaStore();
      const teamsDir = deps.getTeamsDir();
      return readTeamProjectContextMode(
        {
          getMeta: (name) => metaStore.getMeta(name, teamsDir),
          metadataFileExists: (name) => metaStore.metadataFileExists(name, teamsDir),
        },
        teamName
      );
    }),
  });
}
