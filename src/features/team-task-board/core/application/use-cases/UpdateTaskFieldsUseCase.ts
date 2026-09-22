import type {
  TaskFields,
  TaskFieldsWriterPort,
  TeamLeadNotificationPort,
  TeamRuntimeStatusPort,
  TeamTaskBoardLoggerPort,
} from '../ports/TeamTaskBoardPorts';

export class UpdateTaskFieldsUseCase {
  constructor(
    private readonly dependencies: {
      fields: TaskFieldsWriterPort;
      runtime: TeamRuntimeStatusPort;
      notifications: TeamLeadNotificationPort;
      logger: Pick<TeamTaskBoardLoggerPort, 'warn'>;
    }
  ) {}

  async execute(teamName: string, taskId: string, fields: TaskFields): Promise<void> {
    await this.dependencies.fields.updateTaskFields(teamName, taskId, fields);

    if (!this.dependencies.runtime.isTeamAlive(teamName)) {
      return;
    }

    const changedParts: string[] = [];
    if (fields.subject) changedParts.push('title');
    if (fields.description !== undefined) changedParts.push('description');
    const message =
      `Task #${taskId} has been updated by the user (changed: ${changedParts.join(', ')}). ` +
      `New title: "${fields.subject ?? '(unchanged)'}".`;

    try {
      await this.dependencies.notifications.sendMessageToTeam(teamName, message);
    } catch {
      this.dependencies.logger.warn(
        `Failed to notify lead about task fields update for #${taskId} in ${teamName}`
      );
    }
  }
}
