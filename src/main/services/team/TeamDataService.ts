import {
  encodePath,
  extractBaseDir,
  getProjectsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { getMemberColor } from '@shared/constants/memberColors';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { atomicWriteAsync } from './atomicWrite';
import { TeamAgentToolsInstaller } from './TeamAgentToolsInstaller';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamKanbanManager } from './TeamKanbanManager';
import { TeamMemberResolver } from './TeamMemberResolver';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamTaskReader } from './TeamTaskReader';
import { TeamTaskWriter } from './TeamTaskWriter';

import type {
  CreateTaskRequest,
  GlobalTask,
  InboxMessage,
  KanbanState,
  KanbanTaskState,
  SendMessageRequest,
  SendMessageResult,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamData,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  UpdateKanbanPatch,
} from '@shared/types';

const logger = createLogger('Service:TeamDataService');

const MIN_TEXT_LENGTH = 30;
const MAX_LEAD_TEXTS = 50;

export class TeamDataService {
  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    private readonly inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    private readonly taskWriter: TeamTaskWriter = new TeamTaskWriter(),
    private readonly memberResolver: TeamMemberResolver = new TeamMemberResolver(),
    private readonly kanbanManager: TeamKanbanManager = new TeamKanbanManager(),
    private readonly toolsInstaller: TeamAgentToolsInstaller = new TeamAgentToolsInstaller(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore()
  ) {}

  async listTeams(): Promise<TeamSummary[]> {
    return this.configReader.listTeams();
  }

  async getAllTasks(): Promise<GlobalTask[]> {
    const [rawTasks, teams] = await Promise.all([
      this.taskReader.getAllTasks(),
      this.configReader.listTeams(),
    ]);

    const teamInfoMap = new Map<string, { displayName: string; projectPath?: string }>();
    for (const team of teams) {
      teamInfoMap.set(team.teamName, {
        displayName: team.displayName,
        projectPath: team.projectPath,
      });
    }

    // Only include tasks that belong to a known team.
    // ~/.claude/tasks/ may also contain solo session task dirs (UUID-named)
    // which have no corresponding team in ~/.claude/teams/.
    return rawTasks
      .filter((task) => teamInfoMap.has(task.teamName))
      .map((task) => {
        const info = teamInfoMap.get(task.teamName)!;
        return {
          ...task,
          teamDisplayName: info.displayName,
          projectPath: task.projectPath ?? info.projectPath,
        };
      });
  }

  async updateConfig(
    teamName: string,
    updates: { name?: string; description?: string; color?: string }
  ): Promise<TeamConfig | null> {
    return this.configReader.updateConfig(teamName, updates);
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

    try {
      const leadTexts = await this.extractLeadSessionTexts(config);
      if (leadTexts.length > 0) {
        messages = [...messages, ...leadTexts];
        messages.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      }
    } catch {
      warnings.push('Lead session texts failed to load');
    }

    let metaMembers: TeamConfig['members'] = [];
    try {
      metaMembers = await this.membersMetaStore.getMembers(teamName);
    } catch {
      warnings.push('Member metadata failed to load');
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

    const members = this.memberResolver.resolveMembers(
      config,
      metaMembers,
      inboxNames,
      tasks,
      messages
    );
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

    let description = request.description
      ? `${request.subject}\n\n${request.description}`
      : request.subject;

    if (request.prompt?.trim()) {
      description = description
        ? `${description}\n\n---\nPrompt: ${request.prompt.trim()}`
        : `Prompt: ${request.prompt.trim()}`;
    }

    let projectPath: string | undefined;
    try {
      const config = await this.configReader.getConfig(teamName);
      projectPath = config?.projectPath;
    } catch {
      /* best-effort */
    }

    const task: TeamTask = {
      id: nextId,
      subject: request.subject,
      description,
      owner: request.owner,
      status: request.owner ? 'in_progress' : 'pending',
      blocks: [],
      blockedBy,
      projectPath,
    };

    await this.taskWriter.createTask(teamName, task);

    // Update blocks[] on each referenced task so the reverse link exists
    for (const depId of blockedBy) {
      await this.taskWriter.addBlocksEntry(teamName, depId, nextId);
    }

    if (request.owner) {
      try {
        const toolPath = await this.toolsInstaller.ensureInstalled();
        await this.sendMessage(teamName, {
          member: request.owner,
          text:
            `New task assigned to you: #${task.id} "${task.subject}".\n\n` +
            `Update task status using:\n` +
            `node "${toolPath}" --team ${teamName} task start ${task.id}\n` +
            `node "${toolPath}" --team ${teamName} task complete ${task.id}\n\n` +
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
      const toolPath = await this.toolsInstaller.ensureInstalled();
      await this.sendMessage(teamName, {
        member: reviewer,
        text:
          `Please review task #${taskId}.\n\n` +
          `When approved, move it to APPROVED:\n` +
          `node "${toolPath}" --team ${teamName} review approve ${taskId}\n\n` +
          `If changes are needed:\n` +
          `node "${toolPath}" --team ${teamName} review request-changes ${taskId} --comment "..."`,
        summary: `Review request for #${taskId}`,
      });
    } catch (error) {
      await this.kanbanManager
        .updateTask(teamName, taskId, { op: 'remove' })
        .catch(() => undefined);
      throw error;
    }
  }

  async createTeamConfig(request: TeamCreateConfigRequest): Promise<void> {
    const teamDir = path.join(getTeamsBasePath(), request.teamName);
    const configPath = path.join(teamDir, 'config.json');

    try {
      await fs.promises.access(configPath, fs.constants.F_OK);
      throw new Error(`Team already exists: ${request.teamName}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const tasksDir = path.join(getTasksBasePath(), request.teamName);
    await fs.promises.mkdir(teamDir, { recursive: true });
    await fs.promises.mkdir(tasksDir, { recursive: true });

    const joinedAt = Date.now();
    const config = {
      name: request.displayName?.trim() || request.teamName,
      description: request.description?.trim() || undefined,
      color: request.color?.trim() || undefined,
    };

    await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
    await this.membersMetaStore.writeMembers(
      request.teamName,
      request.members.map((member, index) => ({
        name: member.name,
        role: member.role?.trim() || undefined,
        agentType: 'general-purpose',
        color: getMemberColor(index),
        joinedAt,
      }))
    );
  }

  private async extractLeadSessionTexts(config: TeamConfig): Promise<InboxMessage[]> {
    if (!config.leadSessionId || !config.projectPath) {
      return [];
    }

    const projectId = encodePath(config.projectPath);
    const baseDir = extractBaseDir(projectId);
    const jsonlPath = path.join(getProjectsBasePath(), baseDir, `${config.leadSessionId}.jsonl`);

    try {
      await fs.promises.access(jsonlPath, fs.constants.F_OK);
    } catch {
      logger.debug(`Lead session JSONL not found: ${jsonlPath}`);
      return [];
    }

    const leadName = config.members?.find((m) => m.agentType === 'team-lead')?.name ?? 'team-lead';

    const texts: InboxMessage[] = [];

    const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (msg.type !== 'assistant') continue;

        const message = (msg.message ?? msg) as Record<string, unknown>;
        const content = message.content;
        if (!Array.isArray(content)) continue;

        const timestamp =
          typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString();

        for (const block of content as Record<string, unknown>[]) {
          if (block.type !== 'text' || typeof block.text !== 'string') continue;

          const text = block.text.trim();
          if (text.length < MIN_TEXT_LENGTH) continue;

          texts.push({
            from: leadName,
            text,
            timestamp,
            read: true,
            source: 'lead_session',
          });
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    // Keep only the last N texts
    if (texts.length > MAX_LEAD_TEXTS) {
      return texts.slice(-MAX_LEAD_TEXTS);
    }

    return texts;
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
