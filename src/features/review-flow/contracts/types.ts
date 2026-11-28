import type { TeamReadUnavailable } from '@shared/types/team';

/**
 * Who gives final acceptance after AI review.
 * - agent_approval: the reviewer approves; the task goes to Approved.
 * - human_approval: the reviewer completes review (Done, reviewed); only the user approves.
 * - lead_then_human: like human_approval, but the team lead must sign off after the reviewer
 *   (a second review cycle on the same task) before the task reaches Done; only the user approves.
 */
export type ReviewFlow = 'agent_approval' | 'human_approval' | 'lead_then_human';

/** One complete review-flow configuration. It is always saved and overridden as a unit. */
export interface ReviewFlowSettings {
  reviewFlow: ReviewFlow;
  /** Free-text owner instructions for agents. Advisory only; an empty string means none. */
  reviewFlowPrompt: string;
}

/** Where the effective settings of a team come from. */
export type ReviewFlowSource = 'team' | 'default';

/** Effective settings of one team after applying its optional override on top of the default. */
export interface ReviewFlowPolicy extends ReviewFlowSettings {
  source: ReviewFlowSource;
}

/** Teams that carry their own settings instead of following the default, keyed by team name. */
export type TeamReviewFlowOverrides = Record<string, ReviewFlowSettings>;

/**
 * A team with separate history per project has one review flow, saved with the team and copied to
 * the board of each of its projects (agents read the board of their own project).
 */
export interface ProjectTeamReviewFlow {
  /** The team saved its setting. Before that each project keeps what it had. */
  saved: boolean;
  /** The saved setting: its own, or `null` when it follows the default (also `null` while not saved). */
  settings: ReviewFlowSettings | null;
  /** What the team saved cannot be read: its launches are refused until a save repairs it. */
  unreadable?: true;
  /** Its projects cannot be listed (a damaged contexts index), so nothing can be saved for it. */
  projectsError?: string;
  /** Its project copies. Their boards are listed in `overrides` and `unreadableTeams` by copy name. */
  projects: { executionTeamName: string; projectPath: string }[];
}

export interface ReviewFlowOverview {
  /** The saved default, or the built-in one when the saved file cannot be read (see `defaultsError`). */
  defaults: ReviewFlowSettings;
  /** Present when the saved default is unreadable. It can still be replaced by saving a new one. */
  defaultsError?: string;
  overrides: TeamReviewFlowOverrides;
  /** Teams whose saved review-flow settings are invalid. Resetting them to the default repairs them. */
  unreadableTeams: string[];
  /** Captured owners/teams whose settings could not be observed; never imply inheritance. */
  unavailable?: TeamReadUnavailable[];
  /** Every team with separate history per project, keyed by team name. */
  projectTeams: Record<string, ProjectTeamReviewFlow>;
}
