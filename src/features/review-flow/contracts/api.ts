import type { ReviewFlowOverview, ReviewFlowSettings } from './types';

/** Renderer-facing API. Every method rejects with a readable Error when the request is invalid. */
export interface ReviewFlowElectronApi {
  /** The default for all teams plus the teams that override it. */
  getOverview: () => Promise<ReviewFlowOverview>;
  /** Replaces the default used by every team without an override. */
  setDefaults: (settings: ReviewFlowSettings) => Promise<ReviewFlowSettings>;
  /** Saves a team override, or removes it (the team follows the default again) when `null`. */
  setTeamOverride: (
    teamName: string,
    settings: ReviewFlowSettings | null
  ) => Promise<ReviewFlowSettings | null>;
}
