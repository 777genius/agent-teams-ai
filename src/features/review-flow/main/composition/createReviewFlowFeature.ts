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
    teams: new TeamKanbanReviewFlowGateway(deps.teamWriter, deps.getTeamsDir),
  });
}
