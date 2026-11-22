import type {
  ProjectTeamReviewFlow,
  ReviewFlowSettings,
  TeamReviewFlowOverrides,
} from '../../contracts/types';

export interface TeamReviewFlowScan {
  overrides: TeamReviewFlowOverrides;
  unreadable: string[];
  /** Every team that keeps separate history per project, with its project copies. */
  projectTeams: Record<string, ProjectTeamReviewFlow>;
}

/** Storage of the default review flow shared by every team without an override. */
export interface ReviewFlowDefaultsPort {
  read(): Promise<ReviewFlowSettings>;
  write(settings: ReviewFlowSettings): Promise<ReviewFlowSettings>;
}

/**
 * Per-team overrides, stored with each team's kanban state. A team with separate history per
 * project saves one override for the team and copies it to the board of each of its projects.
 */
export interface TeamReviewFlowPort {
  /** Saves the override, or removes it (the team follows the default again) when `null`. */
  writeOverride(teamName: string, settings: ReviewFlowSettings | null): Promise<void>;
  listOverrides(): Promise<TeamReviewFlowScan>;
}
