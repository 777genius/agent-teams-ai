import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';

import type {
  TaskBoardCreateTaskCommand,
  TaskBoardCreateTaskCommandResult,
} from '@features/task-board-commands';
import type { CreateTaskRequest, SendMessageRequest, TeamTask } from '@shared/types';

const MAX_NOTIFIED_TASK_STARTS = 500;
const SAFE_DIAGNOSTIC_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface TeamTaskStartBoardPort {
  getTask?(taskId: string): unknown;
  listTasks(): readonly unknown[];
  listDeletedTasks(): readonly unknown[];
  createTask(input: Record<string, unknown>): unknown;
  startTask(taskId: string, actor?: string): unknown;
  reconcileTaskCreation?(input: Record<string, unknown>): unknown;
}

type TaskBoardWithCreationReconciliation = TeamTaskStartBoardPort & {
  reconcileTaskCreation(input: Record<string, unknown>): unknown;
};

function hasTaskCreationReconciliation(
  taskBoard: TeamTaskStartBoardPort
): taskBoard is TaskBoardWithCreationReconciliation {
  return typeof taskBoard.reconcileTaskCreation === 'function';
}

function isControllerTaskNotFoundError(error: unknown, taskId: string): boolean {
  return error instanceof Error && error.message === `Task not found: ${taskId}`;
}

function findTasksByCreationIdempotencyKey(
  activeTasks: readonly TeamTask[],
  deletedTasks: readonly TeamTask[],
  idempotencyKey: string
): TeamTask[] {
  return [...activeTasks, ...deletedTasks].filter(
    (task) =>
      (
        task as TeamTask & {
          creationCommand?: { idempotencyKey?: unknown };
        }
      ).creationCommand?.idempotencyKey === idempotencyKey
  );
}

function toSafeDiagnosticIdentifier(value: string): string {
  return SAFE_DIAGNOSTIC_IDENTIFIER_PATTERN.test(value) ? value : 'redacted';
}

export interface TeamTaskStartCoordinatorPorts {
  getTaskBoard(teamName: string): TeamTaskStartBoardPort;
  readTasks(teamName: string): Promise<readonly TeamTask[]>;
  readTaskCreateProjectPath(teamName: string): Promise<string | undefined>;
  runCreateTaskCommand(
    command: TaskBoardCreateTaskCommand
  ): Promise<TaskBoardCreateTaskCommandResult>;
  invalidateTaskProjection(): void;
  resolveLeadName(teamName: string): Promise<string>;
  sendMessage(teamName: string, request: SendMessageRequest): Promise<unknown>;
  sendRuntimeRecipientMessage(teamName: string, request: SendMessageRequest): Promise<unknown>;
  warn(message: string): void;
}

export interface TeamTaskCreateOutcome {
  task: TeamTask;
  createdInAttempt: boolean;
}

/**
 * Owns task creation, task-start transitions, and their notifications.
 *
 * The task board and durable command facade remain the mutation owners. This
 * coordinator only sequences those capabilities through focused ports.
 */
export class TeamTaskStartCoordinator {
  private readonly notifiedTaskStarts = new Set<string>();

  constructor(private readonly ports: TeamTaskStartCoordinatorPorts) {}

  async createTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask> {
    return (await this.createTaskWithOutcome(teamName, request)).task;
  }

  async createTaskWithOutcome(
    teamName: string,
    request: CreateTaskRequest
  ): Promise<TeamTaskCreateOutcome> {
    const taskBoard = this.ports.getTaskBoard(teamName);
    const blockedBy = this.normalizeTaskLinks(request.blockedBy);
    const related = this.normalizeTaskLinks(request.related);
    const shouldStart = Boolean(request.owner && request.startImmediately === true);
    const commandPayload: Record<string, unknown> = {
      subject: request.subject,
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.descriptionTaskRefs?.length
        ? { descriptionTaskRefs: request.descriptionTaskRefs }
        : {}),
      ...(request.owner ? { owner: request.owner } : {}),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
      ...(related.length > 0 ? { related } : {}),
      createdBy: 'user',
      ...(request.prompt?.trim() ? { prompt: request.prompt.trim() } : {}),
      ...(request.promptTaskRefs?.length ? { promptTaskRefs: request.promptTaskRefs } : {}),
      ...(shouldStart ? { startImmediately: true } : {}),
    };

    let task: TeamTask;
    let createdInAttempt = true;
    if (request.command) {
      if (typeof taskBoard.getTask !== 'function') {
        throw new Error('Durable task-board commands are unavailable');
      }
      const getTask = taskBoard.getTask.bind(taskBoard);
      const commandResult = await this.ports.runCreateTaskCommand({
        teamName,
        identity: request.command,
        payload: commandPayload,
        destination: {
          findById: (taskId) => {
            try {
              return getTask(taskId) as TeamTask;
            } catch (error) {
              if (isControllerTaskNotFoundError(error, taskId)) {
                return null;
              }
              throw error;
            }
          },
          findByIdempotencyKey: (idempotencyKey) =>
            findTasksByCreationIdempotencyKey(
              taskBoard.listTasks() as readonly TeamTask[],
              taskBoard.listDeletedTasks() as readonly TeamTask[],
              idempotencyKey
            ),
          create: async (input) => {
            const projectPath = await this.ports.readTaskCreateProjectPath(teamName);
            return taskBoard.createTask({
              ...input,
              ...(projectPath ? { projectPath } : {}),
            }) as TeamTask;
          },
          ...(hasTaskCreationReconciliation(taskBoard)
            ? {
                reconcile: (input: Record<string, unknown>) =>
                  taskBoard.reconcileTaskCreation(input) as TeamTask,
              }
            : {}),
        },
      });
      task = commandResult.task;
      createdInAttempt = commandResult.createdInAttempt;
    } else {
      const projectPath = await this.ports.readTaskCreateProjectPath(teamName);
      task = taskBoard.createTask({
        ...commandPayload,
        ...(projectPath ? { projectPath } : {}),
      }) as TeamTask;
    }
    this.ports.invalidateTaskProjection();

    // The task-board owner already notifies non-lead assignees. Base this repair
    // on the resolved task so durable reconciliation/replay can recover a
    // missing lead notification without repeating the board mutation.
    if (task.status === 'in_progress' && task.owner) {
      try {
        const leadName = await this.ports.resolveLeadName(teamName);
        if (this.isLeadOwner(task.owner, leadName)) {
          if (request.command) {
            await this.sendDurableUserTaskStartNotification(teamName, task, leadName);
          } else {
            await this.sendUserTaskStartNotification(teamName, task);
          }
        }
      } catch {
        if (request.command) {
          this.ports.warn(
            `[TeamDataService] category=post_commit_notification code=task_start_notification_failed team=${toSafeDiagnosticIdentifier(teamName)} task=${toSafeDiagnosticIdentifier(task.id)}`
          );
        }
      }
    }

    return { task, createdInAttempt };
  }

  async startTask(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    const task = await this.readPendingTask(teamName, taskId);
    this.ports.getTaskBoard(teamName).startTask(taskId, 'user');
    this.ports.invalidateTaskProjection();

    if (task.owner) {
      try {
        const leadName = await this.ports.resolveLeadName(teamName);
        // Preserve the legacy solo-team behavior: the lead does not receive
        // this compatibility notification when starting its own task.
        if (!this.isLeadOwner(task.owner, leadName)) {
          const parts = [
            `**start working on task now** ${formatTaskDisplayLabel(task)} "${task.subject}"`,
          ];
          if (task.description?.trim()) {
            parts.push(`\nDetails:\n${task.description.trim()}`);
          }
          parts.push(
            '',
            wrapAgentBlock(
              [
                `Begin work on this task immediately. Keep it moving until it is completed or clearly blocked. Do not leave it idle.`,
                `Update task status using the board MCP tools:`,
                `task_complete { teamName: "${teamName}", taskId: "${task.id}", actor: "${task.owner}" }`,
              ].join('\n')
            )
          );
          await this.ports.sendMessage(teamName, {
            member: task.owner,
            from: leadName,
            text: parts.join('\n'),
            taskRefs: task.descriptionTaskRefs,
            summary: `Start working on ${formatTaskDisplayLabel(task)}`,
            source: 'system_notification',
          });
        }
      } catch {
        // Best-effort compatibility notification.
      }
    }

    return { notifiedOwner: !!task.owner };
  }

  async startTaskByUser(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    const task = await this.readPendingTask(teamName, taskId);
    this.ports.getTaskBoard(teamName).startTask(taskId, 'user');
    this.ports.invalidateTaskProjection();

    if (task.owner) {
      await this.sendUserTaskStartNotification(teamName, task);
    }

    return { notifiedOwner: !!task.owner };
  }

  async notifyLeadOnTeammateTaskStart(teamName: string, taskId: string): Promise<void> {
    try {
      const tasks = await this.ports.readTasks(teamName);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;

      const events = task.historyEvents;
      if (!Array.isArray(events) || events.length === 0) return;

      const newest = events[events.length - 1];
      if (newest.type !== 'status_changed' || newest.to !== 'in_progress') return;
      if (!newest.actor || newest.actor === 'user') return;

      const dedupKey = `${teamName}:${taskId}:${newest.timestamp}`;
      if (this.notifiedTaskStarts.has(dedupKey)) return;
      this.notifiedTaskStarts.add(dedupKey);
      if (this.notifiedTaskStarts.size > MAX_NOTIFIED_TASK_STARTS) {
        const oldest = this.notifiedTaskStarts.values().next().value;
        if (oldest !== undefined) {
          this.notifiedTaskStarts.delete(oldest);
        }
      }

      const leadName = await this.ports.resolveLeadName(teamName);
      if (this.isLeadOwner(newest.actor, leadName)) return;

      await this.ports.sendMessage(teamName, {
        member: leadName,
        from: newest.actor,
        text: `@${newest.actor} **started task** ${formatTaskDisplayLabel(task)} "${task.subject}"`,
        summary: `Task ${formatTaskDisplayLabel(task)} started`,
        source: 'system_notification',
      });
    } catch (error) {
      this.ports.warn(`[TeamDataService] notifyLeadOnTeammateTaskStart failed: ${String(error)}`);
    }
  }

  private normalizeTaskLinks(values: readonly string[] | undefined): string[] {
    return [...new Set(values?.filter((id) => id.length > 0) ?? [])].sort();
  }

  private async readPendingTask(teamName: string, taskId: string): Promise<TeamTask> {
    const tasks = await this.ports.readTasks(teamName);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }
    if (task.status !== 'pending') {
      throw new Error(`Task #${taskId} is not pending (current: ${task.status})`);
    }
    return task;
  }

  private async sendUserTaskStartNotification(teamName: string, task: TeamTask): Promise<void> {
    if (!task.owner) return;
    try {
      await this.ports.sendMessage(teamName, this.buildUserTaskStartNotification(teamName, task));
    } catch {
      // Best-effort notification.
    }
  }

  private async sendDurableUserTaskStartNotification(
    teamName: string,
    task: TeamTask,
    leadName: string
  ): Promise<void> {
    await this.ports.sendRuntimeRecipientMessage(teamName, {
      ...this.buildUserTaskStartNotification(teamName, task),
      member: leadName,
      messageId: `task-start:${teamName}:${task.id}`,
    });
  }

  private buildUserTaskStartNotification(teamName: string, task: TeamTask): SendMessageRequest {
    const parts = [
      `**start working on task now** ${formatTaskDisplayLabel(task)} "${task.subject}"`,
    ];
    if (task.description?.trim()) {
      parts.push(`\nDetails:\n${task.description.trim()}`);
    }
    if (task.prompt?.trim()) {
      parts.push(`\nInstructions:\n${task.prompt.trim()}`);
    }
    parts.push(
      '',
      wrapAgentBlock(
        [
          `This start notification can become stale after reassignment or completion. Before modifying anything, fetch the current task and verify that task.owner is your configured teammate name and task.status is pending or in_progress. If the owner changed or the task is completed/deleted, do not start or reopen it, modify files, add a completion comment, or complete it; stop unless the current owner explicitly asks you to collaborate on fresh follow-up work.`,
          `Begin work on this task immediately. Keep it moving until it is completed or clearly blocked. Do not leave it idle.`,
          `To fetch the full task context (description, comments, attachments) use:`,
          `task_get { teamName: "${teamName}", taskId: "${task.id}" }`,
          `When done, update task status:`,
          `task_complete { teamName: "${teamName}", taskId: "${task.id}", actor: "${task.owner}" }`,
        ].join('\n')
      )
    );
    return {
      member: task.owner!,
      from: 'user',
      text: parts.join('\n'),
      taskRefs: task.descriptionTaskRefs,
      summary: `Start working on ${formatTaskDisplayLabel(task)}`,
      source: 'system_notification',
    };
  }

  private isLeadOwner(owner: string, leadName: string): boolean {
    const normalized = owner.trim().toLowerCase();
    if (!normalized) return false;
    return normalized === leadName.trim().toLowerCase() || normalized === 'team-lead';
  }
}
