import * as agentTeamsControllerModule from 'agent-teams-controller';

import { parseReviewFlowSettings } from '../../../core/domain';

import type { ReviewFlowSettings } from '../../../contracts/types';
import type { ReviewFlowDefaultsPort } from '../../../core/application';

const { reviewFlowDefaults } = agentTeamsControllerModule;

function toSettings(raw: unknown): ReviewFlowSettings {
  const parsed = parseReviewFlowSettings(raw);
  if (!parsed.ok) throw new Error(`Review flow defaults are corrupt: ${parsed.error}`);
  return parsed.settings;
}

/**
 * The controller owns the file and its validation, because it also enforces the policy for agents.
 * This adapter only reuses that single implementation instead of keeping a second copy.
 */
export class ControllerReviewFlowDefaultsStore implements ReviewFlowDefaultsPort {
  constructor(private readonly getClaudeDir: () => string) {}

  async read(): Promise<ReviewFlowSettings> {
    return toSettings(reviewFlowDefaults.read(this.getClaudeDir()));
  }

  async write(settings: ReviewFlowSettings): Promise<ReviewFlowSettings> {
    return toSettings(reviewFlowDefaults.write(this.getClaudeDir(), settings));
  }
}
