import type {
  TeamDataTaskBoardCapability,
  TeamDataTaskBoardPort,
} from './TeamDataControllerCompatibilityAdapter';

export type TeamDataLegacyTaskBoardPort = TeamDataTaskBoardPort;

/**
 * Exposes the controller adapter's normalized task-board capability through
 * the feature's generic task-board ports.
 */
export class TeamDataLegacyTaskBoardAdapter {
  constructor(private readonly taskBoardCapability: TeamDataTaskBoardCapability) {}

  getTaskBoard(teamName: string): TeamDataLegacyTaskBoardPort {
    const taskBoard = this.taskBoardCapability.getTaskBoard(teamName);
    if (!taskBoard) {
      throw new Error('Agent teams controller taskBoard API is unavailable');
    }
    return taskBoard;
  }
}
