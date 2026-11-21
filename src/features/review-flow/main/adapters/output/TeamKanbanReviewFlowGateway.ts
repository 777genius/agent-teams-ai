import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import * as fs from 'fs';
import * as path from 'path';

import {
  type ProjectTeamReviewFlowPorts,
  ReviewFlowValidationError,
  saveProjectTeamReviewFlow,
  type TeamReviewFlowPort,
  type TeamReviewFlowScan,
} from '../../../core/application';
import { scanTeamReviewFlowOverrides } from '../../infrastructure/scanTeamReviewFlowOverrides';

import type { ReviewFlowSettings } from '../../../contracts/types';

/** The part of the team data service this adapter needs; the controller does the locked write. */
export interface TeamReviewFlowWriter {
  setReviewFlowSettings(teamName: string, settings: ReviewFlowSettings | null): Promise<void>;
}

export const PROJECT_COPY_REVIEW_FLOW_MESSAGE =
  'This is a project copy of a team with separate history per project. Its review flow is the team\'s: set it for the team.';

export class TeamKanbanReviewFlowGateway implements TeamReviewFlowPort {
  constructor(
    private readonly writer: TeamReviewFlowWriter,
    private readonly getTeamsDir: () => string,
    private readonly projectTeams: ProjectTeamReviewFlowPorts
  ) {}

  async writeOverride(teamName: string, settings: ReviewFlowSettings | null): Promise<void> {
    const validated = validateTeamName(teamName);
    if (!validated.valid) {
      throw new ReviewFlowValidationError(validated.error ?? 'Invalid team name');
    }
    const name = validated.value!;
    const kind = await this.projectTeams.kindOf(name).catch((error: unknown) => {
      throw new ReviewFlowValidationError(error instanceof Error ? error.message : String(error));
    });
    if (kind === 'project-copy') throw new ReviewFlowValidationError(PROJECT_COPY_REVIEW_FLOW_MESSAGE);
    if (kind === 'project-team') {
      await saveProjectTeamReviewFlow(
        this.projectTeams,
        (board, value) => this.writer.setReviewFlowSettings(board, value),
        name,
        settings
      );
      return;
    }
    // The settings screen can outlive a team; writing would silently recreate its directory.
    const configPath = path.join(this.getTeamsDir(), name, 'config.json');
    if (!(await fs.promises.access(configPath).then(() => true, () => false))) {
      throw new ReviewFlowValidationError(`Team "${name}" no longer exists`);
    }
    await this.writer.setReviewFlowSettings(name, settings);
  }

  listOverrides(): Promise<TeamReviewFlowScan> {
    return scanTeamReviewFlowOverrides(this.getTeamsDir(), (teamName) =>
      this.projectTeams.readProjectTeam(teamName)
    );
  }
}
