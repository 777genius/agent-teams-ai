import { BUILT_IN_REVIEW_FLOW_SETTINGS, parseReviewFlowSettings } from '../domain/reviewFlowPolicy';

import type { ReviewFlowOverview, ReviewFlowSettings } from '../../contracts/types';
import type { ReviewFlowDefaultsPort, TeamReviewFlowPort } from './ports';

export class ReviewFlowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewFlowValidationError';
  }
}

function requireSettings(raw: unknown): ReviewFlowSettings {
  const parsed = parseReviewFlowSettings(raw);
  if (!parsed.ok) throw new ReviewFlowValidationError(parsed.error);
  return parsed.settings;
}

export interface ReviewFlowServicePorts {
  defaults: ReviewFlowDefaultsPort;
  teams: TeamReviewFlowPort;
}

/** Use cases of the review-flow settings. Validation happens here, before any port is touched. */
export class ReviewFlowService {
  constructor(private readonly ports: ReviewFlowServicePorts) {}

  async getOverview(): Promise<ReviewFlowOverview> {
    const [defaults, scan] = await Promise.all([this.readDefaults(), this.ports.teams.listOverrides()]);
    return { ...defaults, overrides: scan.overrides, unreadableTeams: scan.unreadable };
  }

  /** An unreadable default must not lock the settings screen: it can be replaced by saving a new one. */
  private async readDefaults(): Promise<Pick<ReviewFlowOverview, 'defaults' | 'defaultsError'>> {
    try {
      return { defaults: await this.ports.defaults.read() };
    } catch (error) {
      return {
        defaults: { ...BUILT_IN_REVIEW_FLOW_SETTINGS },
        defaultsError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async saveDefaults(raw: unknown): Promise<ReviewFlowSettings> {
    return this.ports.defaults.write(requireSettings(raw));
  }

  /** Only an explicit `null` removes the override; a missing value is a caller bug, not a removal. */
  async saveTeamOverride(teamName: string, raw: unknown): Promise<ReviewFlowSettings | null> {
    if (typeof teamName !== 'string' || !teamName.trim()) {
      throw new ReviewFlowValidationError('teamName is required');
    }
    if (raw === undefined) {
      throw new ReviewFlowValidationError('settings are required (use null to remove the override)');
    }
    const settings = raw === null ? null : requireSettings(raw);
    await this.ports.teams.writeOverride(teamName, settings);
    return settings;
  }
}
