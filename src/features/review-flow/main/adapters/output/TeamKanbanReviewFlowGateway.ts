import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import * as fs from 'fs';
import * as path from 'path';

import { ReviewFlowValidationError, type TeamReviewFlowPort, type TeamReviewFlowScan } from '../../../core/application';
import { scanTeamReviewFlowOverrides } from '../../infrastructure/scanTeamReviewFlowOverrides';

import type { ReviewFlowSettings } from '../../../contracts/types';
import type { TeamProjectContextMode } from '@shared/types';

/** The part of the team data service this adapter needs; the controller does the locked write. */
export interface TeamReviewFlowWriter {
  setReviewFlowSettings(teamName: string, settings: ReviewFlowSettings | null): Promise<void>;
}

/** The history mode of a saved team; rejects when its metadata cannot be read (fail closed). */
export type ReadTeamProjectContextMode = (teamName: string) => Promise<TeamProjectContextMode>;

export class TeamKanbanReviewFlowGateway implements TeamReviewFlowPort {
  constructor(
    private readonly writer: TeamReviewFlowWriter,
    private readonly getTeamsDir: () => string,
    private readonly readTeamMode: ReadTeamProjectContextMode
  ) {}

  async writeOverride(teamName: string, settings: ReviewFlowSettings | null): Promise<void> {
    const validated = validateTeamName(teamName);
    if (!validated.valid) {
      throw new ReviewFlowValidationError(validated.error ?? 'Invalid team name');
    }
    // The settings screen can outlive a team; writing would silently recreate its directory.
    const configPath = path.join(this.getTeamsDir(), validated.value!, 'config.json');
    if (!(await fs.promises.access(configPath).then(() => true, () => false))) {
      throw new ReviewFlowValidationError(await this.describeMissingBoard(validated.value!));
    }
    await this.writer.setReviewFlowSettings(validated.value!, settings);
  }

  /**
   * A team with separate history per project has no board of its own: each
   * project's copy has its board, and the review flow is set there.
   */
  private async describeMissingBoard(teamName: string): Promise<string> {
    const mode = await this.readTeamMode(teamName).catch((error: unknown) => {
      throw new ReviewFlowValidationError(error instanceof Error ? error.message : String(error));
    });
    return mode === 'per_project'
      ? `Team "${teamName}" keeps a separate history per project, so each project has its own review flow. Set it for one of its projects.`
      : `Team "${teamName}" no longer exists`;
  }

  listOverrides(): Promise<TeamReviewFlowScan> {
    return scanTeamReviewFlowOverrides(this.getTeamsDir());
  }
}
