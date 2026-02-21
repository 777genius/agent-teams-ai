import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { TeamAgentToolsInstaller } from './TeamAgentToolsInstaller';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamKanbanManager } from './TeamKanbanManager';
import { TeamMemberResolver } from './TeamMemberResolver';
import { TeamTaskReader } from './TeamTaskReader';
import { TeamTaskWriter } from './TeamTaskWriter';

import type {
  CreateTaskRequest,
  InboxMessage,
  KanbanState,
  KanbanTaskState,
  SendMessageRequest,
  SendMessageResult,
  TeamData,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  UpdateKanbanPatch,
} from '@shared/types';

export class TeamDataService {
  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    private readonly inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    private readonly taskWriter: TeamTaskWriter = new TeamTaskWriter(),
    private readonly memberResolver: TeamMemberResolver = new TeamMemberResolver(),
    private readonly kanbanManager: TeamKanbanManager = new TeamKanbanManager(),
    private readonly toolsInstaller: TeamAgentToolsInstaller = new TeamAgentToolsInstaller()
  ) {}

  async listTeams(): Promise<TeamSummary[]> {
    return this.configReader.listTeams();
  }

  async deleteTeam(teamName: string): Promise<void> {
    const teamsDir = path.join(getTeamsBasePath(), teamName);
    await fs.promises.rm(teamsDir, { recursive: true, force: true });

    const tasksDir = path.join(getTasksBasePath(), teamName);
    await fs.promises.rm(tasksDir, { recursive: true, force: true });
  }

  async getTeamData(teamName: string): Promise<TeamData> {
    const config = await this.configReader.getConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }

    const warnings: string[] = [];

    let tasks: TeamTask[] = [];
    let tasksLoaded = true;
    try {
      tasks = await this.taskReader.getTasks(teamName);
    } catch {
      warnings.push('Tasks failed to load');
      tasksLoaded = false;
    }

    let inboxNames: string[] = [];
    try {
      inboxNames = await this.inboxReader.listInboxNames(teamName);
    } catch {
      warnings.push('Inboxes failed to load');
    }

    let messages: InboxMessage[] = [];
    try {
      messages = await this.inboxReader.getMessages(teamName);
    } catch {
      warnings.push('Messages failed to load');
    }

    let kanbanState: KanbanState = {
      teamName,
      reviewers: [],
      tasks: {},
    };
    let canRunKanbanGc = true;
    try {
      kanbanState = await this.kanbanManager.getState(teamName);
    } catch {
      warnings.push('Kanban state failed to load');
      canRunKanbanGc = false;
    }

    if (canRunKanbanGc && tasksLoaded) {
      try {
        await this.kanbanManager.garbageCollect(teamName, new Set(tasks.map((task) => task.id)));
        kanbanState = await this.kanbanManager.getState(teamName);
      } catch {
        warnings.push('Kanban state cleanup failed');
      }
    }

    const members = this.memberResolver.resolveMembers(config, inboxNames, tasks, messages);
    return {
      teamName,
      config,
      tasks,
      members,
      messages,
      kanbanState,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async createTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask> {
    const nextId = await this.taskReader.getNextTaskId(teamName);

    const blockedBy = request.blockedBy?.filter((id) => id.length > 0) ?? [];

    const task: TeamTask = {
      id: nextId,
      subject: request.subject,
      description: request.description
        ? `${request.subject}\n\n${request.description}`
        : request.subject,
      owner: request.owner,
      status: request.owner ? 'in_progress' : 'pending',
      blocks: [],
      blockedBy,
    };

    await this.taskWriter.createTask(teamName, task);

    // Update blocks[] on each referenced task so the reverse link exists
    for (const depId of blockedBy) {
      await this.taskWriter.addBlocksEntry(teamName, depId, nextId);
    }

    if (request.owner) {
      try {
        const toolPath = await this.toolsInstaller.ensureInstalled(teamName);
        await this.sendMessage(teamName, {
          member: request.owner,
          text:
            `New task assigned to you: #${task.id} "${task.subject}".\n\n` +
            `Update task status using:\n` +
            `node "${toolPath}" task start ${task.id}\n` +
            `node "${toolPath}" task complete ${task.id}\n\n` +
            `Help:\n` +
            `node "${toolPath}" --help`,
          summary: `New task #${task.id} assigned`,
        });
      } catch {
        // Best-effort notification — don't fail task creation if message fails
      }
    }

    return task;
  }

  async updateTaskStatus(teamName: string, taskId: string, status: TeamTaskStatus): Promise<void> {
    await this.taskWriter.updateStatus(teamName, taskId, status);
  }

  async sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return this.inboxWriter.sendMessage(teamName, request);
  }

  async requestReview(teamName: string, taskId: string): Promise<void> {
    await this.kanbanManager.updateTask(teamName, taskId, { op: 'set_column', column: 'review' });

    const state = await this.kanbanManager.getState(teamName);
    const reviewer = state.reviewers[0];
    if (!reviewer) {
      return;
    }

    try {
      const toolPath = await this.toolsInstaller.ensureInstalled(teamName);
      await this.sendMessage(teamName, {
        member: reviewer,
        text:
          `Please review task #${taskId}.\n\n` +
          `When approved, move it to APPROVED:\n` +
          `node "${toolPath}" review approve ${taskId}\n\n` +
          `If changes are needed:\n` +
          `node "${toolPath}" review request-changes ${taskId} --comment "..."`,
        summary: `Review request for #${taskId}`,
      });
    } catch (error) {
      await this.kanbanManager
        .updateTask(teamName, taskId, { op: 'remove' })
        .catch(() => undefined);
      throw error;
    }
  }

  async updateKanban(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void> {
    if (patch.op !== 'request_changes') {
      await this.kanbanManager.updateTask(teamName, taskId, patch);
      return;
    }

    const tasks = await this.taskReader.getTasks(teamName);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task?.owner) {
      throw new Error(`No owner found for task ${taskId}`);
    }

    const previousStatus: TeamTaskStatus = task.status;
    const previousState = await this.kanbanManager.getState(teamName);
    const previousKanbanEntry: KanbanTaskState | undefined = previousState.tasks[taskId];

    await this.kanbanManager.updateTask(teamName, taskId, { op: 'remove' });

    try {
      await this.taskWriter.updateStatus(teamName, taskId, 'in_progress');
      await this.sendMessage(teamName, {
        member: task.owner,
        text:
          `Task #${taskId} needs fixes.\n\n` +
          `${patch.comment?.trim() || 'Reviewer requested changes.'}\n\n` +
          `Please fix and mark it as completed when ready.`,
        summary: `Fix request for #${taskId}`,
      });
    } catch (error) {
      await this.taskWriter.updateStatus(teamName, taskId, previousStatus).catch(() => undefined);
      if (previousKanbanEntry) {
        await this.kanbanManager
          .updateTask(teamName, taskId, { op: 'set_column', column: previousKanbanEntry.column })
          .catch(() => undefined);
      }
      throw error;
    }
  }
}
