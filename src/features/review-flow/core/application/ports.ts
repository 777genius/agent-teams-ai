import type { ReviewFlowSettings, TeamReviewFlowOverrides } from '../../contracts/types';

export interface TeamReviewFlowScan {
  overrides: TeamReviewFlowOverrides;
  unreadable: string[];
}

/** Storage of the default review flow shared by every team without an override. */
export interface ReviewFlowDefaultsPort {
  read(): Promise<ReviewFlowSettings>;
  write(settings: ReviewFlowSettings): Promise<ReviewFlowSettings>;
}

/** Per-team overrides, stored with each team's kanban state. */
export interface TeamReviewFlowPort {
  /** Saves the override, or removes it (the team follows the default again) when `null`. */
  writeOverride(teamName: string, settings: ReviewFlowSettings | null): Promise<void>;
  listOverrides(): Promise<TeamReviewFlowScan>;
}
