import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import * as fs from 'fs';
import * as path from 'path';

import { ReviewFlowValidationError, type TeamReviewFlowPort, type TeamReviewFlowScan } from '../../../core/application';
import { scanTeamReviewFlowOverrides } from '../../infrastructure/scanTeamReviewFlowOverrides';

import type { ReviewFlowSettings } from '../../../contracts/types';

/** The part of the team data service this adapter needs; the controller does the locked write. */
export interface TeamReviewFlowWriter {
  setReviewFlowSettings(teamName: string, settings: ReviewFlowSettings | null): Promise<void>;
}

export class TeamKanbanReviewFlowGateway implements TeamReviewFlowPort {
  constructor(
    private readonly writer: TeamReviewFlowWriter,
    private readonly getTeamsDir: () => string
  ) {}

  async writeOverride(teamName: string, settings: ReviewFlowSettings | null): Promise<void> {
    const validated = validateTeamName(teamName);
    if (!validated.valid) {
      throw new ReviewFlowValidationError(validated.error ?? 'Invalid team name');
    }
    // The settings screen can outlive a team; writing would silently recreate its directory.
    const configPath = path.join(this.getTeamsDir(), validated.value!, 'config.json');
    if (!(await fs.promises.access(configPath).then(() => true, () => false))) {
      throw new ReviewFlowValidationError(`Team "${validated.value}" no longer exists`);
    }
    await this.writer.setReviewFlowSettings(validated.value!, settings);
  }

  listOverrides(): Promise<TeamReviewFlowScan> {
    return scanTeamReviewFlowOverrides(this.getTeamsDir());
  }
}
