import { yieldToEventLoop } from '@main/utils/asyncYield';
import {
  encodePath,
  extractBaseDir,
  getClaudeBasePath,
  getProjectsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import {
  AGENT_BLOCK_CLOSE,
  AGENT_BLOCK_OPEN,
  stripAgentBlocks,
} from '@shared/constants/agentBlocks';
import { getMemberColor } from '@shared/constants/memberColors';
import { createLogger } from '@shared/utils/logger';
import { getKanbanColumnFromReviewState, normalizeReviewState } from '@shared/utils/reviewState';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { parseNumericSuffixName } from '@shared/utils/teamMemberName';
import { extractToolPreview, formatToolSummaryFromCalls } from '@shared/utils/toolSummary';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { gitIdentityResolver } from '../parsing/GitIdentityResolver';

import { atomicWriteAsync } from './atomicWrite';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamKanbanManager } from './TeamKanbanManager';
import { TeamMemberResolver } from './TeamMemberResolver';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';
import { TeamTaskReader } from './TeamTaskReader';
import { TeamTaskWriter } from './TeamTaskWriter';

import type {
  AddMemberRequest,
  AttachmentMeta,
  CreateTaskRequest,
  GlobalTask,
  InboxMessage,
  KanbanColumnId,
  KanbanState,
  ResolvedTeamMember,
  SendMessageRequest,
  SendMessageResult,
  TaskAttachmentMeta,
  TaskComment,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamData,
  TeamMember,
  TeamProcess,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamTaskWithKanban,
  ToolCallMeta,
  UpdateKanbanPatch,
} from '@shared/types';
import type { AgentTeamsController } from 'agent-teams-controller';

const { createController } = agentTeamsControllerModule;

const logger = createLogger('Service:TeamDataService');

const MIN_TEXT_LENGTH = 30;
const MAX_LEAD_TEXTS = 150;
const PROCESS_HEALTH_INTERVAL_MS = 2_000;
const TASK_MAP_YIELD_EVERY = 250;

export class TeamDataService {
  private processHealthTimer: ReturnType<typeof setInterval> | null = null;
  private processHealthTeams = new Set<string>();
  /** Tracks notified task-start transitions to avoid duplicate lead notifications. */
  private notifiedTaskStarts = new Set<string>();

  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    _inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    private readonly taskWriter: TeamTaskWriter = new TeamTaskWriter(),
    private readonly memberResolver: TeamMemberResolver = new TeamMemberResolver(),
    private readonly kanbanManager: TeamKanbanManager = new TeamKanbanManager(),
    _legacyToolsInstaller: unknown = null,
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore(),
    private readonly controllerFactory: (teamName: string) => AgentTeamsController = (teamName) =>
      createController({
        teamName,
        claudeDir: getClaudeBasePath(),
      })
  ) {}

  private getController(teamName: string): AgentTeamsController {
    return this.controllerFactory(teamName);
  }

  private getTaskLabel(task: Pick<TeamTask, 'id' | 'displayId'>): string {
    return formatTaskDisplayLabel(task);
  }

  private resolveTaskReviewState(
    task: Pick<TeamTask, 'reviewState'>
  ): 'none' | 'review' | 'approved' {
    return normalizeReviewState(task.reviewState);
  }

  private attachKanbanCompatibility(task: TeamTask): TeamTaskWithKanban {
    const reviewState = this.resolveTaskReviewState(task);
    return {
      ...task,
      reviewState,
      kanbanColumn: getKanbanColumnFromReviewState(reviewState),
    };
  }

  async listTeams(): Promise<TeamSummary[]> {
    return this.configReader.listTeams();
  }

  async getAllTasks(): Promise<GlobalTask[]> {
    const rawTasks = await this.taskReader.getAllTasks();
    const teams = await this.configReader.listTeams();

    const teamInfoMap = new Map<
      string,
      { displayName: string; projectPath?: string; deletedAt?: string }
    >();
    for (const team of teams) {
      teamInfoMap.set(team.teamName, {
        displayName: team.displayName,
        projectPath: team.projectPath,
        deletedAt: team.deletedAt,
      });
    }

    const deletedTeams = new Set(teams.filter((t) => t.deletedAt).map((t) => t.teamName));

    const teamNames = [
      ...new Set(rawTasks.map((t) => t.teamName).filter((n) => teamInfoMap.has(n))),
    ];
    const kanbanByTeam = new Map<string, KanbanState>();
    await Promise.all(
      teamNames.map(async (teamName) => {
        try {
          const state = await this.kanbanManager.getState(teamName);
          kanbanByTeam.set(teamName, state);
        } catch {
          // ignore
        }
      })
    );

    const out: GlobalTask[] = [];
    let processed = 0;
    for (const task of rawTasks) {
      if (!teamInfoMap.has(task.teamName)) {
        continue;
      }
      const info = teamInfoMap.get(task.teamName)!;
      const reviewState = this.resolveTaskReviewState(task);
      const kanbanColumn = getKanbanColumnFromReviewState(reviewState);

      // IPC payload safety: GlobalTask lists can be enormous (especially comments and large nested fields).
      // Return a "light" task object and defer heavy details to team/task detail views.
      const projectPath = task.projectPath ?? info.projectPath;
      const subject =
        typeof task.subject === 'string'
          ? task.subject.slice(0, 300)
          : String(task.subject).slice(0, 300);
      out.push({
        id: task.id,
        subject,
        owner: task.owner,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        projectPath,
        needsClarification: task.needsClarification,
        deletedAt: task.deletedAt,
        reviewState,
        // Intentionally omit description/comments/activeForm/workIntervals/links to keep payload small
        kanbanColumn,
        teamName: task.teamName,
        teamDisplayName: info.displayName,
        teamDeleted: deletedTeams.has(task.teamName) || undefined,
      });
      processed++;
      if (processed % TASK_MAP_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }

    // Hard cap: keep renderer responsive even with huge task sets.
    const MAX_GLOBAL_TASKS_EXPORTED = 500;
    if (out.length > MAX_GLOBAL_TASKS_EXPORTED) {
      // Prefer newest first if timestamps exist.
      out.sort((a, b) => {
        const at = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
        const bt = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
        return bt - at;
      });
      return out.slice(0, MAX_GLOBAL_TASKS_EXPORTED);
    }

    return out;
  }

  async updateConfig(
    teamName: string,
    updates: { name?: string; description?: string; color?: string }
  ): Promise<TeamConfig | null> {
    return this.configReader.updateConfig(teamName, updates);
  }

  async deleteTeam(teamName: string): Promise<void> {
    const config = await this.configReader.getConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }
    config.deletedAt = new Date().toISOString();
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
  }

  async restoreTeam(teamName: string): Promise<void> {
    const config = await this.configReader.getConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }
    delete config.deletedAt;
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
  }

  async permanentlyDeleteTeam(teamName: string): Promise<void> {
    const teamsDir = path.join(getTeamsBasePath(), teamName);
    await fs.promises.rm(teamsDir, { recursive: true, force: true });

    const tasksDir = path.join(getTasksBasePath(), teamName);
    await fs.promises.rm(tasksDir, { recursive: true, force: true });
  }

  async getTeamData(teamName: string): Promise<TeamData> {
    const startedAt = Date.now();
    const marks: Record<string, number> = {};
    const mark = (label: string): void => {
      marks[label] = Date.now();
    };
    const msSince = (label: string): number => {
      const t = marks[label];
      return typeof t === 'number' ? t - startedAt : -1;
    };

    const config = await this.configReader.getConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }
    mark('config');

    const warnings: string[] = [];

    let tasks: TeamTask[] = [];
    try {
      tasks = await this.taskReader.getTasks(teamName);
    } catch {
      warnings.push('Tasks failed to load');
    }
    mark('tasks');

    let inboxNames: string[] = [];
    try {
      inboxNames = await this.inboxReader.listInboxNames(teamName);
    } catch {
      warnings.push('Inboxes failed to load');
    }
    mark('inboxNames');

    let messages: InboxMessage[] = [];
    try {
      messages = await this.inboxReader.getMessages(teamName);
    } catch {
      warnings.push('Messages failed to load');
    }
    mark('messages');

    let leadTexts: InboxMessage[] = [];
    try {
      leadTexts = await this.extractLeadSessionTexts(config);
      if (leadTexts.length > 0) {
        messages = [...messages, ...leadTexts];
      }
    } catch {
      warnings.push('Lead session texts failed to load');
    }
    mark('leadTexts');

    let sentMessages: InboxMessage[] = [];
    try {
      sentMessages = await this.sentMessagesStore.readMessages(teamName);
      if (sentMessages.length > 0) {
        messages = [...messages, ...sentMessages];
      }
    } catch {
      warnings.push('Sent messages failed to load');
    }
    mark('sentMessages');

    // Dedup: if a lead_process message text is also present in lead_session, prefer lead_session.
    // This avoids double-rendering when we persist lead process messages and later load the lead JSONL.
    // Exception: lead_process messages with `to` field are captured SendMessage — never dedup those.
    if (leadTexts.length > 0 && sentMessages.length > 0) {
      const normalizeText = (text: string): string => text.trim().replace(/\r\n/g, '\n');
      const leadSessionFingerprints = new Set<string>();
      for (const msg of leadTexts) {
        if (msg.source !== 'lead_session') continue;
        leadSessionFingerprints.add(`${msg.from}\0${normalizeText(msg.text)}`);
      }
      messages = messages.filter((m) => {
        if (m.source !== 'lead_process') return true;
        // Captured SendMessage messages (with recipient) are real messages — never dedup
        if (m.to) return true;
        const fp = `${m.from}\0${normalizeText(m.text ?? '')}`;
        return !leadSessionFingerprints.has(fp);
      });
    }

    // Enrich inbox messages without leadSessionId by assigning the nearest neighbor's
    // session ID (by timestamp). This avoids the old forward-only propagation bug.
    if (config.leadSessionId || messages.some((m) => m.leadSessionId)) {
      messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

      const anchors: { index: number; time: number; sessionId: string }[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].leadSessionId) {
          anchors.push({
            index: i,
            time: Date.parse(messages[i].timestamp),
            sessionId: messages[i].leadSessionId!,
          });
        }
      }

      if (anchors.length > 0) {
        let anchorIdx = 0;
        for (let i = 0; i < messages.length; i++) {
          if (messages[i].leadSessionId) {
            while (anchorIdx < anchors.length - 1 && anchors[anchorIdx].index < i) {
              anchorIdx++;
            }
            continue;
          }

          const msgTime = Date.parse(messages[i].timestamp);
          let bestAnchor = anchors[0];
          let bestDist = Math.abs(msgTime - bestAnchor.time);
          for (const anchor of anchors) {
            const dist = Math.abs(msgTime - anchor.time);
            if (dist < bestDist) {
              bestDist = dist;
              bestAnchor = anchor;
            } else if (dist > bestDist && anchor.time > msgTime) {
              break;
            }
          }
          messages[i].leadSessionId = bestAnchor.sessionId;
        }
      } else if (config.leadSessionId) {
        for (const msg of messages) {
          msg.leadSessionId = config.leadSessionId;
        }
      }
    }

    messages.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

    let metaMembers: TeamConfig['members'] = [];
    try {
      metaMembers = await this.membersMetaStore.getMembers(teamName);
    } catch {
      warnings.push('Member metadata failed to load');
    }
    mark('metaMembers');

    let kanbanState: KanbanState = {
      teamName,
      reviewers: [],
      tasks: {},
    };
    try {
      kanbanState = await this.kanbanManager.getState(teamName);
    } catch {
      warnings.push('Kanban state failed to load');
    }
    mark('kanbanState');

    mark('kanbanGc');

    const tasksWithKanban: TeamTaskWithKanban[] = tasks.map((task) =>
      this.attachKanbanCompatibility(task)
    );

    const members = this.memberResolver.resolveMembers(
      config,
      metaMembers,
      inboxNames,
      tasksWithKanban,
      messages
    );
    mark('resolveMembers');

    // Enrich members with git branch when it differs from lead's branch
    await this.enrichMemberBranches(members, config);
    mark('enrichBranches');

    mark('syncComments');

    const tasksToReturn: TeamTaskWithKanban[] = tasks.map((task) =>
      this.attachKanbanCompatibility(task)
    );

    let processes: TeamProcess[] = [];
    try {
      processes = await this.readProcesses(teamName);
    } catch {
      warnings.push('Processes failed to load');
    }
    mark('processes');

    const totalMs = Date.now() - startedAt;
    if (totalMs >= 1500) {
      logger.warn(
        `getTeamData team=${teamName} slow total=${totalMs}ms config=${msSince('config')} tasks=${msSince('tasks')} inboxNames=${msSince(
          'inboxNames'
        )} messages=${msSince('messages')} leadTexts=${msSince('leadTexts')} sent=${msSince(
          'sentMessages'
        )} membersMeta=${msSince('metaMembers')} kanban=${msSince('kanbanState')} kanbanGc=${msSince(
          'kanbanGc'
        )} resolveMembers=${msSince('resolveMembers')} enrichBranches=${msSince(
          'enrichBranches'
        )} syncComments=${msSince('syncComments')} processes=${msSince('processes')}`
      );
    }

    // Auto-track teams with alive processes for periodic health checks
    const hasAlive = processes.some((p) => !p.stoppedAt);
    if (hasAlive) {
      this.processHealthTeams.add(teamName);
    } else {
      this.processHealthTeams.delete(teamName);
    }

    return {
      teamName,
      config,
      tasks: tasksToReturn,
      members,
      messages,
      kanbanState,
      processes,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  startProcessHealthPolling(): void {
    if (this.processHealthTimer) return;
    this.processHealthTimer = setInterval(() => {
      void this.processHealthTick();
    }, PROCESS_HEALTH_INTERVAL_MS);
    // Background maintenance should not keep the process alive.
    this.processHealthTimer.unref();
  }

  stopProcessHealthPolling(): void {
    if (this.processHealthTimer) {
      clearInterval(this.processHealthTimer);
      this.processHealthTimer = null;
    }
    this.processHealthTeams.clear();
  }

  trackProcessHealthForTeam(teamName: string): void {
    this.processHealthTeams.add(teamName);
  }

  untrackProcessHealthForTeam(teamName: string): void {
    this.processHealthTeams.delete(teamName);
  }

  private async processHealthTick(): Promise<void> {
    for (const teamName of this.processHealthTeams) {
      try {
        this.getController(teamName).processes.listProcesses();
      } catch {
        // best-effort per team
      }
    }
  }

  private async readProcesses(teamName: string): Promise<TeamProcess[]> {
    return this.getController(teamName).processes.listProcesses() as TeamProcess[];
  }

  /**
   * Kill a registered CLI process by PID (SIGTERM) and mark it as stopped in processes.json.
   */
  async killProcess(teamName: string, pid: number): Promise<void> {
    // Try to kill the process (cross-platform: SIGTERM on Unix, taskkill on Windows)
    try {
      killProcessByPid(pid);
    } catch (err: unknown) {
      // ESRCH = process not found — still mark as stopped below
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code !== 'ESRCH'
      ) {
        throw new Error(`Failed to kill process ${pid}: ${(err as Error).message}`);
      }
    }

    try {
      this.getController(teamName).processes.stopProcess({ pid });
    } catch {
      // Ignore missing persisted registry rows after OS-level stop.
    }
  }

  /**
   * Enriches members with gitBranch when their cwd differs from the lead's.
   * Mutates members in-place for efficiency (called right after resolveMembers).
   */
  private async enrichMemberBranches(
    members: ResolvedTeamMember[],
    config: TeamConfig
  ): Promise<void> {
    // Determine lead's cwd — prefer explicit member entry, fall back to config.projectPath
    const leadEntry = config.members?.find((m) => m.name === 'team-lead');
    const leadCwd = leadEntry?.cwd ?? config.projectPath;
    if (!leadCwd) return;

    const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
      let timer: NodeJS.Timeout | null = null;
      try {
        return await Promise.race([
          p,
          new Promise<T>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), ms);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let leadBranch: string | null = null;
    try {
      // Git can hang on some Windows setups (network drives, locked repos, credential prompts).
      // Branch is best-effort; never block team:getData on it.
      leadBranch = await withTimeout(gitIdentityResolver.getBranch(path.normalize(leadCwd)), 2000);
    } catch {
      // Lead cwd may not be a git repo — skip enrichment entirely
      return;
    }

    const candidates = members.filter((m) => m.cwd && m.cwd !== leadCwd);
    if (candidates.length === 0) return;

    const concurrency = process.platform === 'win32' ? 4 : 8;
    for (let i = 0; i < candidates.length; i += concurrency) {
      const batch = candidates.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (member) => {
          if (!member.cwd) return;
          try {
            const branch = await withTimeout(
              gitIdentityResolver.getBranch(path.normalize(member.cwd)),
              2000
            );
            if (branch && branch !== leadBranch) {
              // eslint-disable-next-line no-param-reassign -- intentional in-place enrichment
              member.gitBranch = branch;
            }
          } catch {
            // Member cwd may not be a git repo — skip silently
          }
        })
      );
    }
  }

  async addMember(teamName: string, request: AddMemberRequest): Promise<void> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('Member name cannot be empty');
    }
    const suffixInfo = parseNumericSuffixName(name);
    if (suffixInfo && suffixInfo.suffix >= 2) {
      throw new Error(
        `Member name "${name}" is not allowed (reserved for Claude CLI auto-suffix). Use "${suffixInfo.base}" instead.`
      );
    }

    const members = await this.membersMetaStore.getMembers(teamName);
    const existing = members.find((m) => m.name.toLowerCase() === name.toLowerCase());

    if (existing) {
      if (existing.removedAt) {
        throw new Error(`Name "${name}" was previously used by a removed member`);
      }
      throw new Error(`Member "${name}" already exists`);
    }

    const newMember: TeamMember = {
      name,
      role: request.role?.trim() || undefined,
      workflow: request.workflow?.trim() || undefined,
      agentType: 'general-purpose',
      color: getMemberColor(members.filter((m) => !m.removedAt).length),
      joinedAt: Date.now(),
    };

    members.push(newMember);
    await this.membersMetaStore.writeMembers(teamName, members);
  }

  async updateMemberRole(
    teamName: string,
    memberName: string,
    newRole: string | undefined
  ): Promise<{ oldRole: string | undefined; changed: boolean }> {
    const members = await this.membersMetaStore.getMembers(teamName);
    const member = members.find((m) => m.name === memberName);
    if (!member) throw new Error(`Member "${memberName}" not found`);
    if (member.removedAt) throw new Error(`Member "${memberName}" is removed`);
    if (member.agentType === 'team-lead') throw new Error('Cannot change team lead role');

    const oldRole = member.role;
    const normalized = typeof newRole === 'string' && newRole.trim() ? newRole.trim() : undefined;
    if (oldRole === normalized) return { oldRole, changed: false };

    member.role = normalized;
    await this.membersMetaStore.writeMembers(teamName, members);
    return { oldRole, changed: true };
  }

  async replaceMembers(
    teamName: string,
    request: { members: { name: string; role?: string; workflow?: string }[] }
  ): Promise<void> {
    const existing = await this.membersMetaStore.getMembers(teamName);
    const isTeamLead = (m: TeamMember): boolean =>
      m.agentType === 'team-lead' || m.name.trim().toLowerCase() === 'team-lead';
    const existingLead = existing.find(isTeamLead) ?? null;
    const existingByName = new Map(existing.map((m) => [m.name.toLowerCase(), m]));
    const joinedAt = Date.now();
    const nextByName = new Set<string>();

    const nextActive: TeamMember[] = request.members.map((member, index) => {
      const name = member.name.trim();
      if (!name) throw new Error('Member name cannot be empty');
      if (name.toLowerCase() === 'team-lead') {
        throw new Error('Member name "team-lead" is reserved');
      }
      const suffixInfo = parseNumericSuffixName(name);
      if (suffixInfo && suffixInfo.suffix >= 2) {
        throw new Error(
          `Member name "${name}" is not allowed (reserved for Claude CLI auto-suffix). Use "${suffixInfo.base}" instead.`
        );
      }
      nextByName.add(name.toLowerCase());
      const prev = existingByName.get(name.toLowerCase());
      return {
        name,
        role: member.role?.trim() || undefined,
        workflow: member.workflow?.trim() || undefined,
        agentType: prev?.agentType ?? 'general-purpose',
        color: prev?.color ?? getMemberColor(index),
        joinedAt: prev?.joinedAt ?? joinedAt,
        removedAt: undefined,
      };
    });

    // Preserve/mark removed members so stale inbox files don't resurrect them in the UI.
    const nextRemoved: TeamMember[] = [];
    for (const prev of existing) {
      if (isTeamLead(prev)) continue;
      const prevName = prev.name.trim();
      if (!prevName) continue;
      const key = prevName.toLowerCase();
      if (nextByName.has(key)) continue;
      nextRemoved.push({
        ...prev,
        removedAt: prev.removedAt ?? joinedAt,
      });
    }

    const out: TeamMember[] = [...nextActive, ...nextRemoved];
    if (existingLead) {
      const leadKey = existingLead.name.trim().toLowerCase();
      if (!out.some((m) => m.name.trim().toLowerCase() === leadKey)) {
        out.unshift({ ...existingLead, removedAt: undefined });
      }
    }
    await this.membersMetaStore.writeMembers(teamName, out);
  }

  async removeMember(teamName: string, memberName: string): Promise<void> {
    const members = await this.membersMetaStore.getMembers(teamName);
    const member = members.find((m) => m.name === memberName);

    if (!member) {
      throw new Error(`Member "${memberName}" not found`);
    }
    if (member.removedAt) {
      throw new Error(`Member "${memberName}" is already removed`);
    }
    if (member.agentType === 'team-lead') {
      throw new Error('Cannot remove team lead');
    }

    member.removedAt = Date.now();
    await this.membersMetaStore.writeMembers(teamName, members);
  }

  async createTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask> {
    const controller = this.getController(teamName);
    const blockedBy = request.blockedBy?.filter((id) => id.length > 0) ?? [];
    const related = request.related?.filter((id) => id.length > 0) ?? [];

    let projectPath: string | undefined;
    try {
      const config = await this.configReader.getConfig(teamName);
      projectPath = config?.projectPath;
    } catch {
      /* best-effort */
    }

    const shouldStart = request.owner && request.startImmediately !== false;
    const task = controller.tasks.createTask({
      subject: request.subject,
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.owner ? { owner: request.owner } : {}),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
      ...(related.length > 0 ? { related } : {}),
      ...(projectPath ? { projectPath } : {}),
      createdBy: 'user',
      ...(shouldStart ? { status: 'in_progress' } : { status: 'pending' }),
    }) as TeamTask;

    if (shouldStart && request.owner) {
      try {
        const leadName = await this.resolveLeadName(teamName);

        // Skip inbox notification when lead assigns a task to themselves (solo teams)
        if (!this.isLeadOwner(request.owner, leadName)) {
          // Build notification with full context — inbox is the primary delivery
          // channel to agents (Claude Code monitors inbox via fs.watch)
          const parts = [`New task assigned to you: ${this.getTaskLabel(task)} "${task.subject}".`];

          if (request.description?.trim()) {
            parts.push(`\nDescription:\n${request.description.trim()}`);
          }

          if (request.prompt?.trim()) {
            parts.push(`\nInstructions:\n${request.prompt.trim()}`);
          }

          parts.push(
            `\n${AGENT_BLOCK_OPEN}`,
            `Update task status using the board MCP tools:`,
            `task_start { teamName: "${teamName}", taskId: "${task.id}" }`,
            `task_complete { teamName: "${teamName}", taskId: "${task.id}" }`,
            AGENT_BLOCK_CLOSE
          );

          await this.sendMessage(teamName, {
            member: request.owner,
            from: leadName,
            text: parts.join('\n'),
            summary: `New task ${this.getTaskLabel(task)} assigned`,
            source: 'system_notification',
          });
        }
      } catch {
        // Best-effort notification — don't fail task creation if message fails
      }
    }

    return task;
  }

  async startTask(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    const tasks = await this.taskReader.getTasks(teamName);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }
    if (task.status !== 'pending') {
      throw new Error(`Task #${taskId} is not pending (current: ${task.status})`);
    }

    this.getController(teamName).tasks.startTask(taskId, 'user');

    if (task.owner) {
      try {
        const leadName = await this.resolveLeadName(teamName);

        // Skip inbox notification when lead starts their own task (solo teams)
        if (!this.isLeadOwner(task.owner, leadName)) {
          const parts = [`Task ${this.getTaskLabel(task)} "${task.subject}" has been started.`];
          if (task.description?.trim()) {
            parts.push(`\nDetails:\n${task.description.trim()}`);
          }
          parts.push(
            `\n${AGENT_BLOCK_OPEN}`,
            `Update task status using the board MCP tools:`,
            `task_complete { teamName: "${teamName}", taskId: "${task.id}" }`,
            AGENT_BLOCK_CLOSE
          );
          await this.sendMessage(teamName, {
            member: task.owner,
            from: leadName,
            text: parts.join('\n'),
            summary: `Task ${this.getTaskLabel(task)} started`,
            source: 'system_notification',
          });
        }
      } catch {
        // Best-effort notification
      }
    }

    return { notifiedOwner: !!task.owner };
  }

  async updateTaskStatus(
    teamName: string,
    taskId: string,
    status: TeamTaskStatus,
    actor?: string
  ): Promise<void> {
    this.getController(teamName).tasks.setTaskStatus(taskId, status, actor);
  }

  /**
   * Called when a task file changes on disk (e.g. teammate CLI wrote it).
   * If the latest statusHistory entry shows a non-user actor started the task,
   * sends an inbox notification to the team lead.
   */
  async notifyLeadOnTeammateTaskStart(teamName: string, taskId: string): Promise<void> {
    try {
      const tasks = await this.taskReader.getTasks(teamName);
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      const history = task.statusHistory;
      if (!Array.isArray(history) || history.length === 0) return;

      const last = history[history.length - 1];
      if (last.to !== 'in_progress') return;
      if (!last.actor || last.actor === 'user') return;

      // Dedup: only notify once per unique transition (keyed by team+task+timestamp).
      const dedupKey = `${teamName}:${taskId}:${last.timestamp}`;
      if (this.notifiedTaskStarts.has(dedupKey)) return;
      this.notifiedTaskStarts.add(dedupKey);
      // Prevent unbounded growth in long-running sessions.
      if (this.notifiedTaskStarts.size > 500) {
        const first = this.notifiedTaskStarts.values().next().value!;
        this.notifiedTaskStarts.delete(first);
      }

      const leadName = await this.resolveLeadName(teamName);
      if (this.isLeadOwner(last.actor, leadName)) return;

      await this.sendMessage(teamName, {
        member: leadName,
        from: last.actor,
        text: `Task ${this.getTaskLabel(task)} "${task.subject}" has been started by ${last.actor}.`,
        summary: `Task ${this.getTaskLabel(task)} started`,
        source: 'system_notification',
      });
    } catch (error) {
      logger.warn(`[TeamDataService] notifyLeadOnTeammateTaskStart failed: ${String(error)}`);
    }
  }

  async softDeleteTask(teamName: string, taskId: string): Promise<void> {
    this.getController(teamName).tasks.softDeleteTask(taskId, 'user');
  }

  async restoreTask(teamName: string, taskId: string): Promise<void> {
    this.getController(teamName).tasks.restoreTask(taskId, 'user');
  }

  async getDeletedTasks(teamName: string): Promise<TeamTask[]> {
    return this.taskReader.getDeletedTasks(teamName);
  }

  async updateTaskOwner(teamName: string, taskId: string, owner: string | null): Promise<void> {
    this.getController(teamName).tasks.setTaskOwner(taskId, owner);
  }

  async updateTaskFields(
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ): Promise<void> {
    this.getController(teamName).tasks.updateTaskFields(taskId, fields);
  }

  async addTaskAttachment(
    teamName: string,
    taskId: string,
    meta: TaskAttachmentMeta
  ): Promise<void> {
    this.getController(teamName).tasks.addTaskAttachmentMeta(
      taskId,
      meta as unknown as Record<string, unknown>
    );
  }

  async removeTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string
  ): Promise<void> {
    this.getController(teamName).tasks.removeTaskAttachment(taskId, attachmentId);
  }

  async setTaskNeedsClarification(
    teamName: string,
    taskId: string,
    value: 'lead' | 'user' | null
  ): Promise<void> {
    this.getController(teamName).tasks.setNeedsClarification(taskId, value);
  }

  async addTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    this.getController(teamName).tasks.linkTask(
      taskId,
      targetId,
      type === 'blockedBy' ? 'blocked-by' : type
    );
  }

  async removeTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    this.getController(teamName).tasks.unlinkTask(
      taskId,
      targetId,
      type === 'blockedBy' ? 'blocked-by' : type
    );
  }

  async addTaskComment(
    teamName: string,
    taskId: string,
    text: string,
    attachments?: TaskAttachmentMeta[]
  ): Promise<TaskComment> {
    const controller = this.getController(teamName);
    const addResult = controller.tasks.addTaskComment(taskId, {
      from: 'user',
      text,
      attachments,
    }) as { task?: TeamTask; comment?: TaskComment };
    const comment =
      addResult.comment ??
      ({
        id: randomUUID(),
        author: 'user',
        text,
        createdAt: new Date().toISOString(),
        type: 'regular',
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      } as TaskComment);

    try {
      const [tasks, config] = await Promise.all([
        this.taskReader.getTasks(teamName),
        this.configReader.getConfig(teamName).catch(() => null),
      ]);
      const task = addResult.task ?? tasks.find((t) => t.id === taskId);
      const leadName = this.resolveLeadNameFromConfig(config);
      const owner = task?.owner?.trim() || null;
      // Auto-clear needsClarification: "user" on UI comment
      // UI comments always have author "user" (TeamTaskWriter default)
      if (task?.needsClarification === 'user') {
        controller.tasks.setNeedsClarification(taskId, null);
      }

      if (task && owner && !this.isLeadOwner(owner, leadName)) {
        // Notify non-lead task owner via inbox (lead → member message)
        const parts = [
          `Comment on task ${this.getTaskLabel(task)} "${task.subject}":\n\n${text}`,
          `\n${AGENT_BLOCK_OPEN}`,
          `Reply to this comment using MCP tool task_add_comment:`,
          `{ teamName: "${teamName}", taskId: "${taskId}", text: "<your reply>", from: "<your-name>" }`,
          AGENT_BLOCK_CLOSE,
        ];
        await this.sendMessage(teamName, {
          member: owner,
          from: leadName,
          text: parts.join('\n'),
          summary: `Comment on ${this.getTaskLabel(task)}`,
          source: 'system_notification',
        });
      } else if (task && owner && this.isLeadOwner(owner, leadName)) {
        // Notify lead about user's comment on their own task.
        // Write to lead's inbox — relay delivers to stdin when process is alive.
        const parts = [
          `New comment from user on your task ${this.getTaskLabel(task)} "${task.subject}":\n\n${text}`,
          `\n${AGENT_BLOCK_OPEN}`,
          `Reply to this comment using MCP tool task_add_comment:`,
          `{ teamName: "${teamName}", taskId: "${taskId}", text: "<your reply>", from: "${leadName}" }`,
          AGENT_BLOCK_CLOSE,
        ];
        await this.sendMessage(teamName, {
          member: leadName,
          from: 'user',
          text: parts.join('\n'),
          summary: `Comment on ${this.getTaskLabel(task)}`,
          source: 'system_notification',
        });
      }
    } catch {
      // Notification is best-effort — don't fail comment save
    }

    return comment;
  }

  async sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult> {
    // Enrich with leadSessionId so session boundary separators work
    let enrichedRequest = request;
    if (!enrichedRequest.leadSessionId) {
      try {
        const config = await this.configReader.getConfig(teamName);
        if (config?.leadSessionId) {
          enrichedRequest = { ...enrichedRequest, leadSessionId: config.leadSessionId };
        }
      } catch {
        // non-critical
      }
    }
    return this.getController(teamName).messages.sendMessage({
      member: enrichedRequest.member,
      from: enrichedRequest.from,
      text: enrichedRequest.text,
      summary: enrichedRequest.summary,
      source: enrichedRequest.source,
      leadSessionId: enrichedRequest.leadSessionId,
      attachments: enrichedRequest.attachments,
    }) as SendMessageResult;
  }

  private resolveLeadNameFromConfig(config: TeamConfig | null): string {
    if (!config) return 'team-lead';
    const lead = config.members?.find((m) => m.role?.toLowerCase().includes('lead'));
    return lead?.name ?? config.members?.[0]?.name ?? 'team-lead';
  }

  private async resolveLeadName(teamName: string): Promise<string> {
    try {
      const config = await this.configReader.getConfig(teamName);
      return this.resolveLeadNameFromConfig(config);
    } catch {
      return 'team-lead';
    }
  }

  private async resolveLeadRuntimeContext(
    teamName: string
  ): Promise<{ leadName: string; leadSessionId?: string }> {
    try {
      const config = await this.configReader.getConfig(teamName);
      return {
        leadName: this.resolveLeadNameFromConfig(config),
        leadSessionId: config?.leadSessionId,
      };
    } catch {
      return { leadName: 'team-lead' };
    }
  }

  private isLeadOwner(owner: string, leadName: string): boolean {
    const normalized = owner.trim().toLowerCase();
    if (!normalized) return false;
    return normalized === leadName.trim().toLowerCase() || normalized === 'team-lead';
  }

  async sendDirectToLead(
    teamName: string,
    leadName: string,
    text: string,
    summary?: string,
    attachments?: AttachmentMeta[]
  ): Promise<SendMessageResult> {
    let leadSessionId: string | undefined;
    try {
      const config = await this.configReader.getConfig(teamName);
      leadSessionId = config?.leadSessionId;
    } catch {
      // non-critical — proceed without sessionId
    }

    const msg = this.getController(teamName).messages.appendSentMessage({
      from: 'user',
      to: leadName,
      text,
      summary,
      source: 'user_sent',
      attachments: attachments?.length ? attachments : undefined,
      leadSessionId,
    }) as InboxMessage;
    return {
      deliveredToInbox: false,
      deliveredViaStdin: true,
      messageId: msg.messageId ?? randomUUID(),
    };
  }

  async getLeadMemberName(teamName: string): Promise<string | null> {
    try {
      const config = await this.configReader.getConfig(teamName);

      // Check config.json members first (Claude Code-created teams)
      if (config?.members?.length) {
        const lead = config.members.find(
          (m) => m.agentType === 'team-lead' || m.name === 'team-lead'
        );
        if (lead?.name) return lead.name;
      }

      // Fallback: check members.meta.json (UI-created teams)
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      if (metaMembers.length > 0) {
        const lead = metaMembers.find((m) => m.agentType === 'team-lead' || m.name === 'team-lead');
        if (lead?.name) return lead.name;
        return metaMembers[0]?.name ?? null;
      }

      // Last resort: check config.json first member
      return config?.members?.[0]?.name ?? null;
    } catch {
      return null;
    }
  }

  async requestReview(teamName: string, taskId: string): Promise<void> {
    const { leadName, leadSessionId } = await this.resolveLeadRuntimeContext(teamName);
    this.getController(teamName).review.requestReview(taskId, {
      from: leadName,
      ...(leadSessionId ? { leadSessionId } : {}),
    });
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
    const config: Record<string, unknown> = {
      name: request.displayName?.trim() || request.teamName,
      description: request.description?.trim() || undefined,
      color: request.color?.trim() || undefined,
    };
    if (request.cwd?.trim()) {
      config.projectPath = request.cwd.trim();
      config.projectPathHistory = [request.cwd.trim()];
    }

    await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
    await this.membersMetaStore.writeMembers(
      request.teamName,
      request.members.map((member, index) => ({
        name: (() => {
          const name = member.name.trim();
          if (!name) throw new Error('Member name cannot be empty');
          if (name.toLowerCase() === 'team-lead')
            throw new Error('Member name "team-lead" is reserved');
          const suffixInfo = parseNumericSuffixName(name);
          if (suffixInfo && suffixInfo.suffix >= 2) {
            throw new Error(
              `Member name "${name}" is not allowed (reserved for Claude CLI auto-suffix). Use "${suffixInfo.base}" instead.`
            );
          }
          return name;
        })(),
        role: member.role?.trim() || undefined,
        agentType: 'general-purpose',
        color: getMemberColor(index),
        joinedAt,
      }))
    );
  }

  async reconcileTeamArtifacts(teamName: string): Promise<void> {
    this.getController(teamName).maintenance.reconcileArtifacts({
      reason: 'file-watch',
    });
  }

  private async extractLeadSessionTexts(config: TeamConfig): Promise<InboxMessage[]> {
    if (!config.leadSessionId || !config.projectPath) {
      return [];
    }

    const projectId = encodePath(config.projectPath);
    const baseDir = extractBaseDir(projectId);
    let jsonlPath = path.join(getProjectsBasePath(), baseDir, `${config.leadSessionId}.jsonl`);

    try {
      await fs.promises.access(jsonlPath, fs.constants.F_OK);
    } catch {
      // Claude Code encodes underscores as hyphens in project directory names;
      // our encodePath only handles slashes. Try the underscore-to-hyphen variant.
      const altBaseDir = baseDir.replace(/_/g, '-');
      if (altBaseDir !== baseDir) {
        const altPath = path.join(
          getProjectsBasePath(),
          altBaseDir,
          `${config.leadSessionId}.jsonl`
        );
        try {
          await fs.promises.access(altPath, fs.constants.F_OK);
          jsonlPath = altPath;
        } catch {
          return [];
        }
      } else {
        return [];
      }
    }

    const leadName = config.members?.find((m) => m.agentType === 'team-lead')?.name ?? 'team-lead';

    // Optimization: read from the end of the JSONL file (we only need the last N texts).
    // The full file can be huge; scanning from the start causes long stalls on Windows.
    const MAX_SCAN_BYTES = 8 * 1024 * 1024; // 8MB tail cap
    const INITIAL_SCAN_BYTES = 256 * 1024; // 256KB

    const textsReversed: InboxMessage[] = [];
    const seenMessageIds = new Set<string>();
    const handle = await fs.promises.open(jsonlPath, 'r');
    try {
      const stat = await handle.stat();
      const fileSize = stat.size;

      let scanBytes = Math.min(INITIAL_SCAN_BYTES, fileSize);
      while (textsReversed.length < MAX_LEAD_TEXTS && scanBytes <= MAX_SCAN_BYTES) {
        const start = Math.max(0, fileSize - scanBytes);
        const buffer = Buffer.alloc(scanBytes);
        await handle.read(buffer, 0, scanBytes, start);
        const chunk = buffer.toString('utf8');

        const lines = chunk.split(/\r?\n/);
        // If we started mid-file, the first line may be partial — drop it.
        const fromIndex = start > 0 ? 1 : 0;

        for (let i = lines.length - 1; i >= fromIndex; i--) {
          const trimmed = lines[i]?.trim();
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

          const textParts: string[] = [];
          for (const block of content as Record<string, unknown>[]) {
            if (block.type !== 'text' || typeof block.text !== 'string') continue;
            textParts.push(block.text);
          }
          if (textParts.length === 0) continue;

          const combined = stripAgentBlocks(textParts.join('\n')).trim();
          if (combined.length < MIN_TEXT_LENGTH) continue;

          // Collect tool_use details from following lines (text and tool_use are separate in JSONL).
          // tool_result (type=user) lines are interleaved between tool_use lines — skip them.
          const toolCallsList: ToolCallMeta[] = [];
          const lookaheadLimit = Math.min(i + 200, lines.length);
          for (let j = i + 1; j < lookaheadLimit; j++) {
            const tLine = lines[j]?.trim();
            if (!tLine) continue;
            let tMsg: Record<string, unknown>;
            try {
              tMsg = JSON.parse(tLine) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (tMsg.type !== 'assistant') continue; // skip tool_result (type=user) lines
            const tMessage = (tMsg.message ?? tMsg) as Record<string, unknown>;
            const tContent = tMessage.content;
            if (!Array.isArray(tContent)) continue;
            const tBlocks = tContent as Record<string, unknown>[];
            if (tBlocks.some((b) => b.type === 'text')) break; // next text = stop
            for (const b of tBlocks) {
              if (b.type === 'tool_use' && typeof b.name === 'string' && b.name !== 'SendMessage') {
                const input = (b.input ?? {}) as Record<string, unknown>;
                toolCallsList.push({
                  name: b.name,
                  preview: extractToolPreview(b.name, input),
                });
              }
            }
          }
          const toolCalls = toolCallsList.length > 0 ? toolCallsList : undefined;
          const toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;

          // Stable messageId: timestamp + text prefix (survives tail-scan range changes)
          const textPrefix = combined
            .slice(0, 50)
            .replace(/[^\p{L}\p{N}]/gu, '')
            .slice(0, 20);

          const messageId = `lead-session-${timestamp}-${textPrefix}`;
          if (seenMessageIds.has(messageId)) continue;
          seenMessageIds.add(messageId);

          textsReversed.push({
            from: leadName,
            text: combined,
            timestamp,
            read: true,
            source: 'lead_session',
            leadSessionId: config.leadSessionId,
            messageId,
            toolSummary,
            toolCalls,
          });
          if (textsReversed.length >= MAX_LEAD_TEXTS) break;
        }

        if (textsReversed.length >= MAX_LEAD_TEXTS) break;
        if (scanBytes === fileSize) break;
        scanBytes = Math.min(fileSize, scanBytes * 2);
      }
    } finally {
      await handle.close();
    }

    // Convert back to chronological order (old behavior) and keep the last N texts.
    textsReversed.reverse();
    const texts = textsReversed;
    return texts.length > MAX_LEAD_TEXTS ? texts.slice(-MAX_LEAD_TEXTS) : texts;
  }

  async updateKanban(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void> {
    const controller = this.getController(teamName);

    if (patch.op === 'remove') {
      controller.kanban.clearKanban(taskId);
      return;
    }

    if (patch.op === 'set_column') {
      if (patch.column === 'review') {
        const { leadName, leadSessionId } = await this.resolveLeadRuntimeContext(teamName);
        controller.review.requestReview(taskId, {
          from: leadName,
          ...(leadSessionId ? { leadSessionId } : {}),
        });
      } else {
        const { leadName, leadSessionId } = await this.resolveLeadRuntimeContext(teamName);
        controller.review.approveReview(taskId, {
          from: leadName,
          note: 'Approved from kanban',
          'notify-owner': true,
          ...(leadSessionId ? { leadSessionId } : {}),
        });
      }
      return;
    }

    const { leadName, leadSessionId } = await this.resolveLeadRuntimeContext(teamName);
    controller.review.requestChanges(taskId, {
      from: leadName,
      comment: patch.comment?.trim() || 'Reviewer requested changes.',
      ...(leadSessionId ? { leadSessionId } : {}),
    });
  }

  async updateKanbanColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    this.getController(teamName).kanban.updateColumnOrder(columnId, orderedTaskIds);
  }
}
