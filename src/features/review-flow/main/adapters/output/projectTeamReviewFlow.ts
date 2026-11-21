import { areReviewFlowSettingsEqual } from '../../../core/domain';

import type { ReviewFlowSettings } from '../../../contracts/types';

/** The board of one project of a team with separate history per project (its project copy). */
export interface ProjectBoard {
  executionTeamName: string;
  projectPath: string;
}

/**
 * What a team name means for its review flow: an ordinary board, a team with separate history per
 * project (one setting for the team), or the project copy of such a team (it has none of its own).
 */
export type ReviewFlowTeamKind = 'board' | 'project-team' | 'project-copy';

/** The review flow of a team with separate history per project, as stored. */
export interface ProjectTeamState {
  /** The setting saved with the team; `undefined` when it never saved one. */
  saved: ReviewFlowSettings | null | undefined;
  /** The boards of its projects that exist on disk, running ones included. */
  projects: readonly ProjectBoard[];
}

/**
 * Where a team with separate history per project keeps its review flow. The team saves one setting
 * and the board of each project carries a copy of it, because agents read the board of their own
 * project when they decide a review.
 */
export interface ProjectTeamReviewFlowPorts {
  /** Fails closed: rejects when the kind of the team cannot be told (unreadable metadata). */
  kindOf(teamName: string): Promise<ReviewFlowTeamKind>;
  /** Runs the operation under the lock that launches and edits of the team take. */
  withTeamLock(teamName: string, operation: () => Promise<void>): Promise<void>;
  /** `undefined` for a team that does not keep separate history per project. */
  readProjectTeam(teamName: string): Promise<ProjectTeamState | undefined>;
  saveTeamSetting(teamName: string, settings: ReviewFlowSettings | null): Promise<void>;
}

/** Writes the override of one board under its board lock (`null` removes it). */
export type WriteBoardReviewFlow = (
  teamName: string,
  settings: ReviewFlowSettings | null
) => Promise<void>;

/** What a board carries now: its override, `null` (it follows the default), or `unknown`. */
export type ReadBoardReviewFlow = (
  teamName: string
) => Promise<ReviewFlowSettings | null | 'unknown'>;

/** The team's setting is saved, but some project boards do not carry it yet. */
export class ProjectBoardsNotUpdatedError extends Error {
  constructor(readonly failed: readonly { projectPath: string; message: string }[]) {
    super(
      `The review flow is saved for the team, but it could not be applied in ${failed
        .map((board) => `${board.projectPath} (${board.message})`)
        .join(', ')}. Save again to apply it there; a project also takes it when it is launched.`
    );
    this.name = 'ProjectBoardsNotUpdatedError';
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The one write of the review flow of a team with separate history per project: the team's setting,
 * then the board of every project, running ones included (an ordinary team's board is written while
 * it runs too). Under the team lock, so a launch cannot create a copy from the old setting meanwhile.
 * The projects are listed before anything is written: a team whose projects cannot be listed is
 * refused untouched. A board that fails does not undo the others; the error names it.
 */
export async function saveProjectTeamReviewFlow(
  ports: ProjectTeamReviewFlowPorts,
  writeBoard: WriteBoardReviewFlow,
  teamName: string,
  settings: ReviewFlowSettings | null
): Promise<void> {
  await ports.withTeamLock(teamName, async () => {
    const team = await ports.readProjectTeam(teamName);
    if (!team) throw new Error(`Team "${teamName}" no longer keeps separate history per project`);
    await ports.saveTeamSetting(teamName, settings);
    const failed: { projectPath: string; message: string }[] = [];
    for (const board of team.projects) {
      try {
        await writeBoard(board.executionTeamName, settings);
      } catch (error) {
        failed.push({ projectPath: board.projectPath, message: messageOf(error) });
      }
    }
    if (failed.length > 0) throw new ProjectBoardsNotUpdatedError(failed);
  });
}

function carries(
  current: ReviewFlowSettings | null | 'unknown',
  wanted: ReviewFlowSettings | null
): boolean {
  if (current === 'unknown') return false;
  if (current === null || wanted === null) return current === wanted;
  return areReviewFlowSettingsEqual(current, wanted);
}

/**
 * Brings the board of one project copy to the setting of its team, when the team saved one. A team
 * that never did leaves the board as it is: it keeps what this project had before. Returns whether
 * the board was written.
 */
export async function syncProjectBoardReviewFlow(
  ports: Pick<ProjectTeamReviewFlowPorts, 'readProjectTeam'>,
  board: { read: ReadBoardReviewFlow; write: WriteBoardReviewFlow },
  teamName: string,
  executionTeamName: string
): Promise<boolean> {
  const wanted = (await ports.readProjectTeam(teamName))?.saved;
  if (wanted === undefined) return false;
  if (carries(await board.read(executionTeamName), wanted)) return false;
  await board.write(executionTeamName, wanted);
  return true;
}
