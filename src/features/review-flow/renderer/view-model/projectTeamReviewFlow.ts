import { areReviewFlowOverridesEqual } from '../../core/domain/reviewFlowPolicy';

import type {
  ReviewFlowOverview,
  ReviewFlowSettings,
  TeamReviewFlowOverrides,
} from '../../contracts/types';

/** What the board of one project carries: its override, `null` (the default), or `unreadable`. */
export type BoardSetting = ReviewFlowSettings | null | 'unreadable';

export interface ProjectBoardReviewFlow {
  projectLabel: string;
  setting: BoardSetting;
}

/** The review flow of a team with separate history per project, against its project boards. */
export interface ProjectTeamReviewFlowStatus {
  /** The team saved its setting; before that each project keeps what it had. */
  saved: boolean;
  /**
   * Projects whose board does not carry the team's setting. Before the first save these are all
   * the projects when they disagree: there is no single setting of the team to show yet.
   */
  unsynced: ProjectBoardReviewFlow[];
  /**
   * Not saved yet, but its projects share settings of their own: they are shown as the team's, and
   * a project launched for the first time would still start on the default until the team saves.
   */
  saveSuggested: boolean;
  /** Its projects cannot be listed: nothing is shown as its setting and nothing can be saved. */
  projectsError?: string;
}

/** The review flow as a person edits it: one entry per team, never one per project copy. */
export interface TeamLevelReviewFlow {
  overrides: TeamReviewFlowOverrides;
  unreadableTeams: string[];
  projectTeams: Record<string, ProjectTeamReviewFlowStatus>;
}

type ProjectTeams = ReviewFlowOverview['projectTeams'];

function sameSetting(a: BoardSetting, b: ReviewFlowSettings | null): boolean {
  return a !== 'unreadable' && areReviewFlowOverridesEqual(a, b);
}

/** The setting every board shares, `null` for none, or `undefined` when they disagree. */
function commonSetting(
  boards: readonly ProjectBoardReviewFlow[]
): ReviewFlowSettings | null | undefined {
  const [first] = boards;
  if (!first) return null;
  if (first.setting === 'unreadable') return undefined;
  const shared = first.setting;
  return boards.every((board) => sameSetting(board.setting, shared)) ? shared : undefined;
}

/**
 * Folds the boards of each team with separate history per project into the team. Its setting is
 * the one saved with the team; before the first save, the setting its projects share. The boards of
 * its copies stop being entries of their own, so the rest of the view treats the team like any other.
 * The copies come from the main process, which proves them, so a copy whose first launch never
 * finished is folded too.
 */
export function foldProjectTeamBoards(
  overview: Pick<ReviewFlowOverview, 'overrides' | 'unreadableTeams' | 'projectTeams'>,
  projectLabel: (teamName: string, executionTeamName: string) => string | null
): TeamLevelReviewFlow {
  const overrides = { ...overview.overrides };
  const unreadable = new Set(overview.unreadableTeams);
  const projectTeams: Record<string, ProjectTeamReviewFlowStatus> = {};
  for (const [teamName, team] of Object.entries(overview.projectTeams)) {
    if (team.projectsError !== undefined) {
      projectTeams[teamName] = {
        saved: team.saved,
        unsynced: [],
        saveSuggested: false,
        projectsError: team.projectsError,
      };
      continue;
    }
    const boards = team.projects.map((project): ProjectBoardReviewFlow => {
      const name = project.executionTeamName;
      const setting: BoardSetting = unreadable.has(name) ? 'unreadable' : (overrides[name] ?? null);
      delete overrides[name];
      unreadable.delete(name);
      return {
        projectLabel: projectLabel(teamName, name) ?? project.projectPath,
        setting,
      };
    });
    // The team has no board of its own; what it shows is its setting.
    delete overrides[teamName];
    unreadable.delete(teamName);
    if (team.unreadable) {
      // What it saved cannot be read: shown for repair, never as the default.
      unreadable.add(teamName);
      projectTeams[teamName] = { saved: true, unsynced: [], saveSuggested: false };
      continue;
    }
    const setting = team.saved ? team.settings : commonSetting(boards);
    if (setting) overrides[teamName] = setting;
    projectTeams[teamName] = {
      saved: team.saved,
      unsynced:
        setting === undefined
          ? boards
          : boards.filter((board) => !sameSetting(board.setting, setting)),
      saveSuggested: !team.saved && Boolean(setting),
    };
  }
  return { overrides, unreadableTeams: [...unreadable], projectTeams };
}

/** The project copies of teams with separate history per project: never entries of their own. */
export function projectCopyNames(projectTeams: ProjectTeams): ReadonlySet<string> {
  return new Set(
    Object.values(projectTeams).flatMap((team) =>
      team.projects.map((project) => project.executionTeamName)
    )
  );
}

/** The team whose review flow a board shows: a project copy shows its team's. */
export function reviewFlowTeamOf(projectTeams: ProjectTeams, boardName: string): string {
  const owner = Object.entries(projectTeams).find(([, team]) =>
    team.projects.some((project) => project.executionTeamName === boardName)
  );
  return owner?.[0] ?? boardName;
}
