import { yieldToEventLoop } from '@main/utils/asyncYield';
import { readFileUtf8WithTimeout } from '@main/utils/fsRead';
import {
  encodePath,
  extractBaseDir,
  getProjectsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { isProcessAlive } from '@main/utils/processHealth';
import { killProcessByPid } from '@main/utils/processKill';
import { AGENT_BLOCK_CLOSE, AGENT_BLOCK_OPEN } from '@shared/constants/agentBlocks';
import { getMemberColor } from '@shared/constants/memberColors';
import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { gitIdentityResolver } from '../parsing/GitIdentityResolver';

import { atomicWriteAsync } from './atomicWrite';
import { TeamAgentToolsInstaller } from './TeamAgentToolsInstaller';
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
  KanbanTaskState,
  ResolvedTeamMember,
  SendMessageRequest,
  SendMessageResult,
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
  UpdateKanbanPatch,
} from '@shared/types';

const logger = createLogger('Service:TeamDataService');

const MIN_TEXT_LENGTH = 30;
const MAX_LEAD_TEXTS = 50;
const PROCESS_HEALTH_INTERVAL_MS = 2_000;
const MAX_PROCESSES_FILE_BYTES = 2 * 1024 * 1024;
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
    private readonly inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    private readonly taskWriter: TeamTaskWriter = new TeamTaskWriter(),
    private readonly memberResolver: TeamMemberResolver = new TeamMemberResolver(),
    private readonly kanbanManager: TeamKanbanManager = new TeamKanbanManager(),
    private readonly toolsInstaller: TeamAgentToolsInstaller = new TeamAgentToolsInstaller(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore()
  ) {}

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
      const kanban = kanbanByTeam.get(task.teamName);
      const kanbanEntry = kanban?.tasks[task.id];
      const kanbanColumn =
        kanbanEntry?.column === 'review' || kanbanEntry?.column === 'approved'
          ? kanbanEntry.column
          : undefined;

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
    let tasksLoaded = true;
    try {
      tasks = await this.taskReader.getTasks(teamName);
    } catch {
      warnings.push('Tasks failed to load');
      tasksLoaded = false;
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

    try {
      const leadTexts = await this.extractLeadSessionTexts(config);
      if (leadTexts.length > 0) {
        messages = [...messages, ...leadTexts];
      }
    } catch {
      warnings.push('Lead session texts failed to load');
    }
    mark('leadTexts');

    try {
      const sentMessages = await this.sentMessagesStore.readMessages(teamName);
      if (sentMessages.length > 0) {
        messages = [...messages, ...sentMessages];
      }
    } catch {
      warnings.push('Sent messages failed to load');
    }
    mark('sentMessages');

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
    let canRunKanbanGc = true;
    try {
      kanbanState = await this.kanbanManager.getState(teamName);
    } catch {
      warnings.push('Kanban state failed to load');
      canRunKanbanGc = false;
    }
    mark('kanbanState');

    if (canRunKanbanGc && tasksLoaded) {
      try {
        await this.kanbanManager.garbageCollect(teamName, new Set(tasks.map((task) => task.id)));
        kanbanState = await this.kanbanManager.getState(teamName);
      } catch {
        warnings.push('Kanban state cleanup failed');
      }
    }
    mark('kanbanGc');

    const tasksWithKanban: TeamTaskWithKanban[] = tasks.map((task) => {
      const col = kanbanState.tasks[task.id]?.column;
      const kanbanColumn = col === 'review' || col === 'approved' ? col : undefined;
      return { ...task, kanbanColumn };
    });

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

    // Auto-sync: create comments from task-related inbox messages
    if (tasksLoaded && messages.length > 0) {
      try {
        const didSync = await this.syncLinkedComments(teamName, tasks, messages);
        if (didSync) {
          // Re-read tasks only if new comments were actually written
          tasks = await this.taskReader.getTasks(teamName);
        }
      } catch {
        warnings.push('Comment sync from messages failed');
      }
    }
    mark('syncComments');

    const tasksToReturn: TeamTaskWithKanban[] = tasks.map((task) => {
      const col = kanbanState.tasks[task.id]?.column;
      const kanbanColumn = col === 'review' || col === 'approved' ? col : undefined;
      return { ...task, kanbanColumn };
    });

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
        const processesPath = path.join(getTeamsBasePath(), teamName, 'processes.json');
        let raw: unknown[];
        try {
          const stat = await fs.promises.stat(processesPath);
          if (!stat.isFile() || stat.size > MAX_PROCESSES_FILE_BYTES) {
            continue;
          }
          const content = await readFileUtf8WithTimeout(processesPath, 5_000);
          const parsed: unknown = JSON.parse(content);
          raw = Array.isArray(parsed) ? (parsed as unknown[]) : [];
        } catch {
          continue;
        }

        const processes = raw.filter(
          (p): p is TeamProcess =>
            !!p &&
            typeof p === 'object' &&
            'pid' in p &&
            typeof (p as TeamProcess).pid === 'number' &&
            (p as TeamProcess).pid > 0
        );

        let dirty = false;
        for (const proc of processes) {
          if (!proc.stoppedAt && !isProcessAlive(proc.pid)) {
            proc.stoppedAt = new Date().toISOString();
            dirty = true;
          }
        }

        if (dirty) {
          await atomicWriteAsync(processesPath, JSON.stringify(processes, null, 2));
          // atomicWrite triggers FileWatcher → team-change 'process' → UI refresh
          // No need to emit manually — FileWatcher handles it.
        }
      } catch {
        // best-effort per team
      }
    }
  }

  private async readProcesses(teamName: string): Promise<TeamProcess[]> {
    const processesPath = path.join(getTeamsBasePath(), teamName, 'processes.json');
    let raw: unknown[];
    try {
      const stat = await fs.promises.stat(processesPath);
      if (!stat.isFile() || stat.size > MAX_PROCESSES_FILE_BYTES) {
        return [];
      }
      const content = await readFileUtf8WithTimeout(processesPath, 5_000);
      const parsed: unknown = JSON.parse(content);
      raw = Array.isArray(parsed) ? (parsed as unknown[]) : [];
    } catch {
      return [];
    }

    const processes = raw.filter(
      (p): p is TeamProcess =>
        !!p &&
        typeof p === 'object' &&
        'pid' in p &&
        typeof (p as TeamProcess).pid === 'number' &&
        (p as TeamProcess).pid > 0
    );

    let dirty = false;
    for (const proc of processes) {
      if (!proc.stoppedAt && !isProcessAlive(proc.pid)) {
        proc.stoppedAt = new Date().toISOString();
        dirty = true;
      }
    }

    if (dirty) {
      try {
        await atomicWriteAsync(processesPath, JSON.stringify(processes, null, 2));
      } catch {
        // best-effort write-back
      }
    }

    return processes;
  }

  /**
   * Kill a registered CLI process by PID (SIGTERM) and mark it as stopped in processes.json.
   */
  async killProcess(teamName: string, pid: number): Promise<void> {
    const processesPath = path.join(getTeamsBasePath(), teamName, 'processes.json');

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

    // Update processes.json to set stoppedAt
    let raw: unknown[];
    try {
      const content = await readFileUtf8WithTimeout(processesPath, 5_000);
      const parsed: unknown = JSON.parse(content);
      raw = Array.isArray(parsed) ? (parsed as unknown[]) : [];
    } catch {
      return; // No processes file — nothing to update
    }

    let dirty = false;
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === 'object' &&
        'pid' in entry &&
        (entry as TeamProcess).pid === pid &&
        !(entry as TeamProcess).stoppedAt
      ) {
        (entry as TeamProcess).stoppedAt = new Date().toISOString();
        dirty = true;
      }
    }

    if (dirty) {
      await atomicWriteAsync(processesPath, JSON.stringify(raw, null, 2));
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
    const members = await this.membersMetaStore.getMembers(teamName);
    const existing = members.find((m) => m.name.toLowerCase() === request.name.toLowerCase());

    if (existing) {
      if (existing.removedAt) {
        throw new Error(`Name "${request.name}" was previously used by a removed member`);
      }
      throw new Error(`Member "${request.name}" already exists`);
    }

    const newMember: TeamMember = {
      name: request.name,
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
    const nextId = await this.taskReader.getNextTaskId(teamName);

    const blockedBy = request.blockedBy?.filter((id) => id.length > 0) ?? [];
    const related = request.related?.filter((id) => id.length > 0 && id !== nextId) ?? [];

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

    const shouldStart = request.owner && request.startImmediately !== false;

    const task: TeamTask = {
      id: nextId,
      subject: request.subject,
      description,
      owner: request.owner,
      createdBy: 'user',
      status: shouldStart ? 'in_progress' : 'pending',
      blocks: [],
      blockedBy,
      related: related.length > 0 ? related : undefined,
      projectPath,
    };

    await this.taskWriter.createTask(teamName, task);

    // Update blocks[] on each referenced task so the reverse link exists
    for (const depId of blockedBy) {
      await this.taskWriter.addBlocksEntry(teamName, depId, nextId);
    }

    if (shouldStart && request.owner) {
      try {
        const leadName = await this.resolveLeadName(teamName);

        // Skip inbox notification when lead assigns a task to themselves (solo teams)
        if (!this.isLeadOwner(request.owner, leadName)) {
          const toolPath = await this.toolsInstaller.ensureInstalled();

          // Build notification with full context — inbox is the primary delivery
          // channel to agents (Claude Code monitors inbox via fs.watch)
          const parts = [`New task assigned to you: #${task.id} "${task.subject}".`];

          if (request.description?.trim()) {
            parts.push(`\nDescription:\n${request.description.trim()}`);
          }

          if (request.prompt?.trim()) {
            parts.push(`\nInstructions:\n${request.prompt.trim()}`);
          }

          parts.push(
            `\n${AGENT_BLOCK_OPEN}`,
            `Update task status using:`,
            `node "${toolPath}" --team ${teamName} task start ${task.id}`,
            `node "${toolPath}" --team ${teamName} task complete ${task.id}`,
            AGENT_BLOCK_CLOSE
          );

          await this.sendMessage(teamName, {
            member: request.owner,
            from: leadName,
            text: parts.join('\n'),
            summary: `New task #${task.id} assigned`,
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

    await this.taskWriter.updateStatus(teamName, taskId, 'in_progress', 'user');

    if (task.owner) {
      try {
        const leadName = await this.resolveLeadName(teamName);

        // Skip inbox notification when lead starts their own task (solo teams)
        if (!this.isLeadOwner(task.owner, leadName)) {
          const toolPath = await this.toolsInstaller.ensureInstalled();
          const parts = [`Task #${task.id} "${task.subject}" has been started.`];
          if (task.description?.trim()) {
            parts.push(`\nDetails:\n${task.description.trim()}`);
          }
          parts.push(
            `\n${AGENT_BLOCK_OPEN}`,
            `Update task status using:`,
            `node "${toolPath}" --team ${teamName} task complete ${task.id}`,
            AGENT_BLOCK_CLOSE
          );
          await this.sendMessage(teamName, {
            member: task.owner,
            from: leadName,
            text: parts.join('\n'),
            summary: `Task #${task.id} started`,
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
    await this.taskWriter.updateStatus(teamName, taskId, status, actor);
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
        text: `Task #${task.id} "${task.subject}" has been started by ${last.actor}.`,
        summary: `Task #${task.id} started`,
      });
    } catch (error) {
      logger.warn(`[TeamDataService] notifyLeadOnTeammateTaskStart failed: ${error}`);
    }
  }

  async softDeleteTask(teamName: string, taskId: string): Promise<void> {
    await this.taskWriter.softDelete(teamName, taskId, 'user');
  }

  async restoreTask(teamName: string, taskId: string): Promise<void> {
    await this.taskWriter.restoreTask(teamName, taskId, 'user');
  }

  async getDeletedTasks(teamName: string): Promise<TeamTask[]> {
    return this.taskReader.getDeletedTasks(teamName);
  }

  async updateTaskOwner(teamName: string, taskId: string, owner: string | null): Promise<void> {
    await this.taskWriter.updateOwner(teamName, taskId, owner);
  }

  async updateTaskFields(
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ): Promise<void> {
    await this.taskWriter.updateFields(teamName, taskId, fields);
  }

  async addTaskAttachment(
    teamName: string,
    taskId: string,
    meta: import('@shared/types').TaskAttachmentMeta
  ): Promise<void> {
    await this.taskWriter.addAttachment(teamName, taskId, meta);
  }

  async removeTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string
  ): Promise<void> {
    await this.taskWriter.removeAttachment(teamName, taskId, attachmentId);
  }

  async setTaskNeedsClarification(
    teamName: string,
    taskId: string,
    value: 'lead' | 'user' | null
  ): Promise<void> {
    await this.taskWriter.setNeedsClarification(teamName, taskId, value);
  }

  async addTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    await this.taskWriter.addRelationship(teamName, taskId, targetId, type);
  }

  async removeTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ): Promise<void> {
    await this.taskWriter.removeRelationship(teamName, taskId, targetId, type);
  }

  async addTaskComment(
    teamName: string,
    taskId: string,
    text: string,
    attachments?: import('@shared/types').TaskAttachmentMeta[]
  ): Promise<TaskComment> {
    const comment = await this.taskWriter.addComment(teamName, taskId, text, {
      attachments,
    });

    try {
      const [tasks, toolPath, config] = await Promise.all([
        this.taskReader.getTasks(teamName),
        this.toolsInstaller.ensureInstalled(),
        this.configReader.getConfig(teamName).catch(() => null),
      ]);
      const task = tasks.find((t) => t.id === taskId);
      const leadName = this.resolveLeadNameFromConfig(config);
      const owner = task?.owner?.trim() || null;
      const normalizedOwner = owner?.toLowerCase() ?? null;

      // Auto-clear needsClarification: "user" on UI comment
      // UI comments always have author "user" (TeamTaskWriter default)
      if (task?.needsClarification === 'user') {
        await this.taskWriter.setNeedsClarification(teamName, taskId, null);
      }

      if (task && owner && !this.isLeadOwner(owner, leadName)) {
        // Notify non-lead task owner via inbox (lead → member message)
        const parts = [
          `Comment on task #${taskId} "${task.subject}":\n\n${text}`,
          `\n${AGENT_BLOCK_OPEN}`,
          `Reply to this comment using:`,
          `node "${toolPath}" --team ${teamName} task comment ${taskId} --text "<your reply>" --from "<your-name>"`,
          AGENT_BLOCK_CLOSE,
        ];
        await this.sendMessage(teamName, {
          member: owner,
          from: leadName,
          text: parts.join('\n'),
          summary: `Comment on #${taskId}`,
        });
      } else if (task && owner && this.isLeadOwner(owner, leadName)) {
        // Notify lead about user's comment on their own task.
        // Write to lead's inbox — relay delivers to stdin when process is alive.
        const parts = [
          `New comment from user on your task #${taskId} "${task.subject}":\n\n${text}`,
          `\n${AGENT_BLOCK_OPEN}`,
          `Reply to this comment using:`,
          `node "${toolPath}" --team ${teamName} task comment ${taskId} --text "<your reply>" --from "${leadName}"`,
          AGENT_BLOCK_CLOSE,
        ];
        await this.sendMessage(teamName, {
          member: leadName,
          from: 'user',
          text: parts.join('\n'),
          summary: `Comment on #${taskId}`,
        });
      }
    } catch {
      // Notification is best-effort — don't fail comment save
    }

    return comment;
  }

  async sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return this.inboxWriter.sendMessage(teamName, request);
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
    const messageId = randomUUID();
    const msg: InboxMessage = {
      from: 'user',
      to: leadName,
      text,
      timestamp: new Date().toISOString(),
      read: true,
      summary,
      messageId,
      source: 'user_sent',
      attachments: attachments?.length ? attachments : undefined,
    };
    await this.sentMessagesStore.appendMessage(teamName, msg);
    return { deliveredToInbox: false, deliveredViaStdin: true, messageId };
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
    await this.kanbanManager.updateTask(teamName, taskId, { op: 'set_column', column: 'review' });

    const state = await this.kanbanManager.getState(teamName);
    const reviewer = state.reviewers[0];
    if (!reviewer) {
      return;
    }

    try {
      const [toolPath, leadName] = await Promise.all([
        this.toolsInstaller.ensureInstalled(),
        this.resolveLeadName(teamName),
      ]);
      await this.sendMessage(teamName, {
        member: reviewer,
        from: leadName,
        text:
          `Please review task #${taskId}.\n\n` +
          `${AGENT_BLOCK_OPEN}\n` +
          `When approved, move it to APPROVED:\n` +
          `node "${toolPath}" --team ${teamName} review approve ${taskId}\n\n` +
          `If changes are needed:\n` +
          `node "${toolPath}" --team ${teamName} review request-changes ${taskId} --comment "..."\n` +
          AGENT_BLOCK_CLOSE,
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
        name: member.name,
        role: member.role?.trim() || undefined,
        agentType: 'general-purpose',
        color: getMemberColor(index),
        joinedAt,
      }))
    );
  }

  /**
   * Scans inbox messages for task-related discussions and auto-creates
   * linked comments on disk. Uses deterministic comment ID for dedup.
   * Returns true if any new comments were synced (caller should re-read tasks).
   */
  private async syncLinkedComments(
    teamName: string,
    tasks: TeamTask[],
    messages: InboxMessage[]
  ): Promise<boolean> {
    const TASK_ID_PATTERN = /#(\d+)/g;
    let synced = false;

    const tasksById = new Map<string, TeamTask>();
    for (const t of tasks) {
      tasksById.set(t.id, t);
    }

    // Dedup broadcasts: same sender + same text → process only once
    const processedTexts = new Set<string>();

    function isAutomatedCommentNotification(msg: InboxMessage): boolean {
      const summary = typeof msg.summary === 'string' ? msg.summary : '';
      if (!/^Comment on #\d+/.test(summary)) return false;
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!text) return false;
      // These are system-generated inbox messages that already correspond to a real task comment.
      // Syncing them into task.comments causes an immediate "duplicate" (lead echo) in the UI.
      if (text.includes('Reply to this comment using:')) return true;
      if (text.startsWith('Comment on task #')) return true;
      if (text.startsWith('New comment from user on your task #')) return true;
      return false;
    }

    for (const msg of messages) {
      if (!msg.messageId || !msg.summary || msg.from === 'user') continue;
      if (msg.source === 'lead_session' || msg.source === 'lead_process') continue;
      if (isAutomatedCommentNotification(msg)) continue;

      const textKey = `${msg.from}\0${msg.text}`;
      if (processedTexts.has(textKey)) continue;
      processedTexts.add(textKey);

      const matches = msg.summary.matchAll(TASK_ID_PATTERN);
      const taskIds = new Set<string>();
      for (const match of matches) {
        taskIds.add(match[1]);
      }

      for (const taskId of taskIds) {
        const task = tasksById.get(taskId);
        if (!task) continue;

        const commentId = `msg-${msg.messageId}`;
        const existing = task.comments ?? [];
        if (existing.some((c) => c.id === commentId)) continue;

        try {
          await this.taskWriter.addComment(teamName, taskId, msg.text, {
            id: commentId,
            author: msg.from,
            createdAt: msg.timestamp,
          });
          synced = true;
        } catch {
          // Best-effort — don't fail getTeamData() on sync errors
        }
      }
    }

    return synced;
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

    // Optimization: read from the end of the JSONL file (we only need the last N texts).
    // The full file can be huge; scanning from the start causes long stalls on Windows.
    const MAX_SCAN_BYTES = 8 * 1024 * 1024; // 8MB tail cap
    const INITIAL_SCAN_BYTES = 256 * 1024; // 256KB

    const textsReversed: InboxMessage[] = [];
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

          for (const block of content as Record<string, unknown>[]) {
            if (block.type !== 'text' || typeof block.text !== 'string') continue;
            const text = block.text.trim();
            if (text.length < MIN_TEXT_LENGTH) continue;
            textsReversed.push({
              from: leadName,
              text,
              timestamp,
              read: true,
              source: 'lead_session',
            });
            if (textsReversed.length >= MAX_LEAD_TEXTS) break;
          }
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
    if (patch.op !== 'request_changes') {
      // Keep kanban + task.status consistent:
      // - moving a task into kanban review/approved implies the work is complete
      // - request_changes already moves it back to in_progress and clears kanban entry
      if (patch.op !== 'set_column') {
        await this.kanbanManager.updateTask(teamName, taskId, patch);
        return;
      }

      const previousState = await this.kanbanManager.getState(teamName);
      const previousKanbanEntry: KanbanTaskState | undefined = previousState.tasks[taskId];

      await this.kanbanManager.updateTask(teamName, taskId, patch);

      try {
        await this.taskWriter.updateStatus(teamName, taskId, 'completed', 'user');
      } catch (error) {
        // Best-effort rollback of kanban move if task status update failed.
        if (previousKanbanEntry) {
          await this.kanbanManager
            .updateTask(teamName, taskId, { op: 'set_column', column: previousKanbanEntry.column })
            .catch(() => undefined);
        } else {
          await this.kanbanManager
            .updateTask(teamName, taskId, { op: 'remove' })
            .catch(() => undefined);
        }
        throw error;
      }
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
      await this.taskWriter.updateStatus(teamName, taskId, 'in_progress', 'reviewer');
      const leadName = await this.resolveLeadName(teamName);
      await this.sendMessage(teamName, {
        member: task.owner,
        from: leadName,
        text:
          `Task #${taskId} needs fixes.\n\n` +
          `${patch.comment?.trim() || 'Reviewer requested changes.'}\n\n` +
          `Please fix and mark it as completed when ready.`,
        summary: `Fix request for #${taskId}`,
      });
    } catch (error) {
      await this.taskWriter
        .updateStatus(teamName, taskId, previousStatus, 'system')
        .catch(() => undefined);
      if (previousKanbanEntry) {
        await this.kanbanManager
          .updateTask(teamName, taskId, { op: 'set_column', column: previousKanbanEntry.column })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async updateKanbanColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    await this.kanbanManager.updateColumnOrder(teamName, columnId, orderedTaskIds);
  }
}
