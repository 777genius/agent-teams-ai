import { encodePath, extractBaseDir, getProjectsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { parseAllTeammateMessages } from '@shared/utils/teammateMessageParser';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';

import type { MemberLogSummary, MemberSubagentLogSummary } from '@shared/types';

const logger = createLogger('Service:TeamMemberLogsFinder');

/**
 * Phase 1: How many lines to scan for member attribution.
 * Detection signals (process.team.memberName, "You are {name}", routing.sender)
 * appear in the first ~10 lines, so 50 is very conservative.
 */
const ATTRIBUTION_SCAN_LINES = 50;

interface StreamedMetadata {
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  messageCount: number;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value.charCodeAt(end - 1);
    // '/' or '\'
    if (ch === 47 || ch === 92) {
      end--;
      continue;
    }
    break;
  }
  return end === value.length ? value : value.slice(0, end);
}

export class TeamMemberLogsFinder {
  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore()
  ) {}

  async findMemberLogs(teamName: string, memberName: string): Promise<MemberLogSummary[]> {
    const discovery = await this.discoverMemberFiles(teamName, memberName);
    if (!discovery) return [];

    const { projectDir, projectId, config, sessionIds, knownMembers, isLeadMember } = discovery;
    const results: MemberLogSummary[] = [];

    const leadMemberName =
      config.members?.find((m) => m?.agentType === 'team-lead')?.name?.trim() || 'team-lead';
    if (isLeadMember && config.leadSessionId) {
      const leadJsonl = path.join(projectDir, `${config.leadSessionId}.jsonl`);
      const leadSummary = await this.parseLeadSessionSummary(
        leadJsonl,
        projectId,
        config.leadSessionId,
        leadMemberName
      );
      if (leadSummary) {
        results.push(leadSummary);
      }
    }

    for (const sessionId of sessionIds) {
      const subagentsDir = path.join(projectDir, sessionId, 'subagents');

      let files: string[];
      try {
        files = await fs.readdir(subagentsDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
        if (file.startsWith('agent-acompact')) continue;

        const filePath = path.join(subagentsDir, file);
        const summary = await this.parseSubagentSummary(
          filePath,
          projectId,
          sessionId,
          file,
          memberName,
          knownMembers
        );
        if (summary) results.push(summary);
      }
    }

    return results.sort(
      (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );
  }

  /**
   * Returns session logs that reference the given task (TaskCreate, TaskUpdate, comments, etc.).
   * When the task is in_progress and has an owner, also includes that owner's session logs so
   * the executor's current activity is visible even before the JSONL mentions the task id.
   */
  async findLogsForTask(
    teamName: string,
    taskId: string,
    options?: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    }
  ): Promise<MemberLogSummary[]> {
    const discovery = await this.discoverProjectSessions(teamName);
    if (!discovery) return [];

    const { projectDir, projectId, config, sessionIds, knownMembers } = discovery;
    const results: MemberLogSummary[] = [];
    const leadMemberName =
      config.members?.find((m) => m?.agentType === 'team-lead')?.name?.trim() || 'team-lead';

    if (config.leadSessionId) {
      const leadJsonl = path.join(projectDir, `${config.leadSessionId}.jsonl`);
      try {
        await fs.access(leadJsonl);
        if (await this.fileMentionsTaskId(leadJsonl, taskId)) {
          const leadSummary = await this.parseLeadSessionSummary(
            leadJsonl,
            projectId,
            config.leadSessionId,
            leadMemberName
          );
          if (leadSummary) results.push(leadSummary);
        }
      } catch {
        // file missing or unreadable
      }
    }

    for (const sessionId of sessionIds) {
      const subagentsDir = path.join(projectDir, sessionId, 'subagents');
      let files: string[];
      try {
        files = await fs.readdir(subagentsDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
        if (file.startsWith('agent-acompact')) continue;
        const filePath = path.join(subagentsDir, file);
        if (!(await this.fileMentionsTaskId(filePath, taskId))) continue;
        const attribution = await this.attributeSubagent(filePath, knownMembers);
        if (!attribution) continue;
        const summary = await this.parseSubagentSummary(
          filePath,
          projectId,
          sessionId,
          file,
          attribution.detectedMember,
          knownMembers
        );
        if (summary) results.push(summary);
      }
    }

    const includeOwnerSessions =
      options?.status === 'in_progress' &&
      typeof options?.owner === 'string' &&
      options.owner.trim().length > 0;
    if (includeOwnerSessions) {
      const ownerLogs = await this.findMemberLogs(teamName, options.owner!.trim());

      const TASK_LOG_INTERVAL_GRACE_MS = 10_000;
      const fallbackRecentMs = 30 * 60_000; // if caller doesn't supply intervals/since, avoid pulling in old owner history
      const now = Date.now();

      const normalizedIntervals = Array.isArray(options?.intervals)
        ? options.intervals
            .map((i) => {
              const startMs = Date.parse(i.startedAt);
              const endMsRaw =
                typeof i.completedAt === 'string' ? Date.parse(i.completedAt) : Number.NaN;
              const endMs = Number.isFinite(endMsRaw) ? endMsRaw : null;
              return Number.isFinite(startMs) ? { startMs, endMs } : null;
            })
            .filter((v): v is { startMs: number; endMs: number | null } => v !== null)
        : [];

      // Back-compat: single since timestamp -> treat as open interval.
      const sinceMsRaw = typeof options?.since === 'string' ? Date.parse(options.since) : NaN;
      const sinceMs = Number.isFinite(sinceMsRaw) ? sinceMsRaw : null;
      const effectiveIntervals =
        normalizedIntervals.length > 0
          ? normalizedIntervals
          : sinceMs != null
            ? [{ startMs: sinceMs, endMs: null }]
            : [];

      const overlapsAnyInterval = (logStartMs: number, logEndMs: number): boolean => {
        for (const it of effectiveIntervals) {
          const start = it.startMs - TASK_LOG_INTERVAL_GRACE_MS;
          const end = (it.endMs ?? now) + TASK_LOG_INTERVAL_GRACE_MS;
          if (logStartMs <= end && logEndMs >= start) return true;
        }
        return false;
      };

      const filteredOwnerLogs = ownerLogs.filter((log) => {
        if (log.isOngoing) return true;
        const startMs = new Date(log.startTime).getTime();
        if (!Number.isFinite(startMs)) return false;
        const durationMs =
          typeof log.durationMs === 'number' && log.durationMs > 0 ? log.durationMs : 0;
        const endMs = startMs + durationMs;

        if (effectiveIntervals.length > 0) {
          return overlapsAnyInterval(startMs, endMs);
        }

        return startMs >= now - fallbackRecentMs;
      });
      const seen = new Set<string>();
      for (const log of results) {
        const key =
          log.kind === 'subagent'
            ? `subagent:${log.sessionId}:${log.subagentId}`
            : `lead:${log.sessionId}`;
        seen.add(key);
      }
      for (const log of filteredOwnerLogs) {
        const key =
          log.kind === 'subagent'
            ? `subagent:${log.sessionId}:${log.subagentId}`
            : `lead:${log.sessionId}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(log);
        }
      }
    }

    return results.sort(
      (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );
  }

  /**
   * Returns absolute paths to all JSONL files belonging to the specified member.
   * Uses the same discovery logic as findMemberLogs but collects file paths.
   */
  async findMemberLogPaths(teamName: string, memberName: string): Promise<string[]> {
    const discovery = await this.discoverMemberFiles(teamName, memberName);
    if (!discovery) return [];

    const { projectDir, config, sessionIds, knownMembers, isLeadMember } = discovery;
    const paths: string[] = [];

    if (isLeadMember && config.leadSessionId) {
      const leadJsonl = path.join(projectDir, `${config.leadSessionId}.jsonl`);
      try {
        await fs.access(leadJsonl);
        paths.push(leadJsonl);
      } catch {
        // File doesn't exist
      }
    }

    for (const sessionId of sessionIds) {
      const subagentsDir = path.join(projectDir, sessionId, 'subagents');

      let files: string[];
      try {
        files = await fs.readdir(subagentsDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
        if (file.startsWith('agent-acompact')) continue;

        const filePath = path.join(subagentsDir, file);
        // Quick attribution check — only Phase 1 (no full-file streaming)
        const attribution = await this.attributeSubagent(filePath, knownMembers);
        if (attribution?.detectedMember.toLowerCase() === memberName.trim().toLowerCase()) {
          paths.push(filePath);
        }
      }
    }

    return paths;
  }

  /** Быстрая проверка: содержит ли файл TaskUpdate/teamctl маркер для данного taskId */
  async hasTaskUpdateMarker(filePath: string, taskId: string): Promise<boolean> {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`"taskId"\\s*:\\s*"${escapedTaskId}"`);

    try {
      for await (const line of rl) {
        if (line.includes('TaskUpdate') && pattern.test(line)) {
          rl.close();
          stream.destroy();
          return true;
        }
        if (line.includes('teamctl') && line.includes('task') && line.includes(taskId)) {
          rl.close();
          stream.destroy();
          return true;
        }
      }
    } catch {
      // ignore read errors
    }

    rl.close();
    stream.destroy();
    return false;
  }

  private async discoverProjectSessions(teamName: string): Promise<{
    projectDir: string;
    projectId: string;
    config: NonNullable<Awaited<ReturnType<TeamConfigReader['getConfig']>>>;
    sessionIds: string[];
    knownMembers: Set<string>;
  } | null> {
    const config = await this.configReader.getConfig(teamName);
    if (!config?.projectPath) {
      logger.debug(`No projectPath for team "${teamName}"`);
      return null;
    }

    const normalizedProjectPath = trimTrailingSlashes(config.projectPath);
    let projectId = encodePath(normalizedProjectPath);
    let baseDir = extractBaseDir(projectId);
    let projectDir = path.join(getProjectsBasePath(), baseDir);

    // If the encoded directory doesn't exist (symlink/cwd mismatch), fall back to locating
    // the project directory by leadSessionId which is unique and reliable.
    try {
      const stat = await fs.stat(projectDir);
      if (!stat.isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      const leadSessionId =
        typeof config.leadSessionId === 'string' && config.leadSessionId.trim().length > 0
          ? config.leadSessionId.trim()
          : null;
      if (leadSessionId) {
        const projectsBase = getProjectsBasePath();
        try {
          const entries = await fs.readdir(projectsBase, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidateDir = path.join(projectsBase, entry.name);
            const leadPath = path.join(candidateDir, `${leadSessionId}.jsonl`);
            try {
              await fs.access(leadPath);
              projectDir = candidateDir;
              projectId = entry.name;
              baseDir = entry.name;
              break;
            } catch {
              // not this project
            }
          }
        } catch {
          // ignore
        }
      }
    }

    const knownSessionIds = new Set<string>();
    if (config.leadSessionId) {
      knownSessionIds.add(config.leadSessionId);
    }
    if (Array.isArray(config.sessionHistory)) {
      for (const sid of config.sessionHistory) {
        if (typeof sid === 'string' && sid.trim().length > 0) {
          knownSessionIds.add(sid.trim());
        }
      }
    }

    let sessionIds: string[];
    if (knownSessionIds.size > 0) {
      const verified: string[] = [];
      for (const sid of knownSessionIds) {
        const sidDir = path.join(projectDir, sid);
        try {
          const stat = await fs.stat(sidDir);
          if (stat.isDirectory()) verified.push(sid);
        } catch {
          // dir doesn't exist
        }
      }
      sessionIds = verified.length > 0 ? verified : await this.listSessionDirs(projectDir);
    } else {
      sessionIds = await this.listSessionDirs(projectDir);
    }

    const knownMembers = new Set<string>(
      (config.members ?? [])
        .map((member) => member.name?.trim().toLowerCase())
        .filter((name): name is string => Boolean(name && name.length > 0))
    );
    try {
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      for (const member of metaMembers) {
        const normalized = member.name.trim().toLowerCase();
        if (normalized.length > 0) knownMembers.add(normalized);
      }
    } catch {
      // best-effort
    }
    try {
      const inboxMembers = await this.inboxReader.listInboxNames(teamName);
      for (const name of inboxMembers) {
        const normalized = name.trim().toLowerCase();
        if (normalized.length > 0) knownMembers.add(normalized);
      }
    } catch {
      // best-effort
    }

    return { projectDir, projectId, config, sessionIds, knownMembers };
  }

  private async discoverMemberFiles(
    teamName: string,
    memberName: string
  ): Promise<{
    projectDir: string;
    projectId: string;
    config: NonNullable<Awaited<ReturnType<TeamConfigReader['getConfig']>>>;
    sessionIds: string[];
    knownMembers: Set<string>;
    isLeadMember: boolean;
  } | null> {
    const discovery = await this.discoverProjectSessions(teamName);
    if (!discovery) return null;
    const { config } = discovery;
    const leadMemberName =
      config.members?.find((m) => m?.agentType === 'team-lead')?.name?.trim() || 'team-lead';
    const isLeadMember = leadMemberName.toLowerCase() === memberName.trim().toLowerCase();
    return { ...discovery, isLeadMember };
  }

  private async fileMentionsTaskId(filePath: string, taskId: string): Promise<boolean> {
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numericTaskId = /^\d+$/.test(taskId) ? taskId : null;
    const patterns: RegExp[] = [
      new RegExp(`"task_id"\\s*:\\s*"${escaped}"`, 'i'),
      new RegExp(`"taskId"\\s*:\\s*"${escaped}"`, 'i'),
    ];
    if (numericTaskId) {
      patterns.push(
        new RegExp(`"task_id"\\s*:\\s*${numericTaskId}\\b`),
        new RegExp(`"taskId"\\s*:\\s*${numericTaskId}\\b`),
        // Support teamctl command lines (may appear in tool output).
        // Example: node ".../teamctl.js" --team "t" task start 10
        new RegExp(
          `\\bteamctl(?:\\.js)?\\b.{0,250}\\b(?:task|review)\\b.{0,250}\\b${numericTaskId}\\b`,
          'i'
        )
      );
    }
    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        for (const re of patterns) {
          if (re.test(line)) {
            rl.close();
            stream.destroy();
            return true;
          }
        }
      }
      rl.close();
      stream.destroy();
    } catch {
      // ignore
    }
    return false;
  }

  private async listSessionDirs(projectDir: string): Promise<string[]> {
    try {
      const dirEntries = await fs.readdir(projectDir, { withFileTypes: true });
      return dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      logger.debug(`Cannot read project dir: ${projectDir}`);
      return [];
    }
  }

  private async parseSubagentSummary(
    filePath: string,
    projectId: string,
    sessionId: string,
    fileName: string,
    targetMember: string,
    knownMembers: Set<string>
  ): Promise<MemberSubagentLogSummary | null> {
    const subagentId = fileName.replace(/^agent-/, '').replace(/\.jsonl$/, '');

    // ── Phase 1: Attribution (first N lines) ──
    // Detect which member owns this file + extract description.
    // All detection signals appear in the first few lines of the JSONL.
    const attribution = await this.attributeSubagent(filePath, knownMembers);
    if (!attribution) return null;

    const targetLower = targetMember.toLowerCase();
    if (attribution.detectedMember.toLowerCase() !== targetLower) {
      return null;
    }

    // ── Phase 2: Metadata (stream entire file) ──
    // Now that we know the file belongs to this member, collect
    // accurate timestamps and message count from the full file.
    const metadata = await this.streamFileMetadata(filePath);

    const firstTimestamp = metadata.firstTimestamp ?? (await this.getFileMtime(filePath));
    const lastTimestamp = metadata.lastTimestamp ?? firstTimestamp;

    const startTime = new Date(firstTimestamp);
    const endTime = new Date(lastTimestamp);
    const durationMs = endTime.getTime() - startTime.getTime();

    // Check if the file might still be active (modified recently)
    let isOngoing = false;
    try {
      const stat = await fs.stat(filePath);
      const ageMs = Date.now() - stat.mtimeMs;
      isOngoing = ageMs < 60_000; // Active within last minute
    } catch {
      // ignore
    }

    return {
      kind: 'subagent',
      subagentId,
      sessionId,
      projectId,
      description: attribution.description || `Subagent ${subagentId}`,
      memberName: targetMember,
      startTime: firstTimestamp,
      durationMs: Math.max(0, durationMs),
      messageCount: metadata.messageCount,
      isOngoing,
    };
  }

  /**
   * Phase 1: Scan first ATTRIBUTION_SCAN_LINES lines for member detection signals
   * and extract a human-readable description from the first user message.
   * Returns null if the file is a warmup session or empty.
   */
  private async attributeSubagent(
    filePath: string,
    knownMembers: Set<string>
  ): Promise<{ detectedMember: string; description: string } | null> {
    const lines: string[] = [];

    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      let count = 0;
      for await (const line of rl) {
        if (count >= ATTRIBUTION_SCAN_LINES) break;
        const trimmed = line.trim();
        if (trimmed) {
          lines.push(trimmed);
          count++;
        }
      }
      rl.close();
      stream.destroy();
    } catch {
      return null;
    }

    if (lines.length === 0) return null;

    let description = '';
    let detectedMember: string | null = null;
    let detectionPriority = 0;

    for (const line of lines) {
      // Early exit: both objectives met (member detected at max priority + description found)
      if (detectionPriority >= 3 && description) break;

      try {
        const msg = JSON.parse(line) as Record<string, unknown>;

        const role = this.extractRole(msg);
        const textContent = this.extractTextContent(msg);

        // Skip warmup messages
        if (role === 'user' && textContent?.trim() === 'Warmup') {
          return null;
        }

        // Extract description from first user message + teammate_id attribution
        if (role === 'user' && textContent) {
          if (textContent.trimStart().startsWith('<teammate-message')) {
            const parsed = parseAllTeammateMessages(textContent);
            if (!description) {
              description =
                parsed[0]?.summary || parsed[0]?.content?.slice(0, 200) || 'Teammate spawn';
            }

            // teammate_id is a structured XML attribute — highest reliability signal
            if (detectionPriority < 3 && parsed[0]?.teammateId) {
              const tmId = parsed[0].teammateId.trim().toLowerCase();
              if (tmId.length > 0 && knownMembers.has(tmId)) {
                detectedMember = parsed[0].teammateId.trim();
                detectionPriority = 3;
              }
            }
          } else if (!description) {
            description = textContent.slice(0, 200);
          }
        }

        // --- Multi-signal member detection ---
        // Higher priority signals override lower priority ones (skip if already at max)
        if (detectionPriority < 3) {
          const detection = this.detectMemberFromMessage(msg, knownMembers);
          if (detection && detection.priority > detectionPriority) {
            detectedMember = detection.name;
            detectionPriority = detection.priority;
          }
        }

        // Check toolUseResult routing (highest priority — directly identifies the agent)
        if (detectionPriority < 3 && msg.toolUseResult && typeof msg.toolUseResult === 'object') {
          const routing = (msg.toolUseResult as Record<string, unknown>).routing as
            | Record<string, unknown>
            | undefined;
          if (routing && typeof routing.sender === 'string') {
            const sender = routing.sender.toLowerCase();
            if (knownMembers.has(sender)) {
              detectedMember = routing.sender;
              detectionPriority = 3;
            }
          }
        }

        // Check process.team.memberName from system messages (highest priority)
        if (detectionPriority < 3) {
          const init = msg.init as Record<string, unknown> | undefined;
          const process = (msg.process ?? init?.process) as Record<string, unknown> | undefined;
          const team = process?.team as Record<string, unknown> | undefined;
          if (team && typeof team.memberName === 'string') {
            const memberNameLower = team.memberName.trim().toLowerCase();
            if (memberNameLower.length > 0 && knownMembers.has(memberNameLower)) {
              detectedMember = team.memberName.trim();
              detectionPriority = 3;
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (!detectedMember) return null;

    return { detectedMember, description };
  }

  /**
   * Last-resort member detection from message text.
   * Only called when all structured signals (teammate_id, process.team, routing) failed.
   * Returns priority 1 (lowest) — only if exactly one known member name appears.
   */
  private detectMemberFromMessage(
    msg: Record<string, unknown>,
    knownMembers: Set<string>
  ): { name: string; priority: number } | null {
    if (this.extractRole(msg) !== 'user') return null;

    const text = this.extractTextContent(msg);
    if (!text) return null;

    // Only attribute if exactly one known member name appears (word-boundary match).
    // Avoids false positives when multiple members are mentioned.
    const matches: string[] = [];
    for (const name of knownMembers) {
      const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i');
      if (regex.test(text)) {
        matches.push(name);
      }
    }
    if (matches.length === 1) {
      return { name: findOriginalCase(text, matches[0]), priority: 1 };
    }

    return null;
  }

  private extractTextContent(msg: Record<string, unknown>): string | null {
    if (typeof msg.content === 'string') {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      const textParts = (msg.content as Record<string, unknown>[])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string);
      if (textParts.length > 0) return textParts.join(' ');
    }
    // Also check message wrapper
    if (msg.message && typeof msg.message === 'object') {
      return this.extractTextContent(msg.message as Record<string, unknown>);
    }
    return null;
  }

  private extractRole(msg: Record<string, unknown>): string | null {
    if (typeof msg.role === 'string') {
      return msg.role;
    }
    if (msg.message && typeof msg.message === 'object') {
      const inner = msg.message as Record<string, unknown>;
      if (typeof inner.role === 'string') {
        return inner.role;
      }
    }
    return null;
  }

  private async parseLeadSessionSummary(
    jsonlPath: string,
    projectId: string,
    sessionId: string,
    memberName: string
  ): Promise<MemberLogSummary | null> {
    try {
      await fs.access(jsonlPath);
    } catch {
      return null;
    }

    const metadata = await this.streamFileMetadata(jsonlPath);

    const firstTimestamp = metadata.firstTimestamp ?? (await this.getFileMtime(jsonlPath));
    const lastTimestamp = metadata.lastTimestamp ?? firstTimestamp;

    const startTime = new Date(firstTimestamp);
    const endTime = new Date(lastTimestamp);
    const durationMs = endTime.getTime() - startTime.getTime();

    let isOngoing = false;
    try {
      const stat = await fs.stat(jsonlPath);
      const ageMs = Date.now() - stat.mtimeMs;
      isOngoing = ageMs < 60_000;
    } catch {
      // ignore
    }

    return {
      kind: 'lead_session',
      sessionId,
      projectId,
      description: 'Lead session',
      memberName,
      startTime: firstTimestamp,
      durationMs: Math.max(0, durationMs),
      messageCount: metadata.messageCount,
      isOngoing,
    };
  }

  /**
   * Stream entire JSONL file collecting only timestamps and message count.
   * Lightweight — uses regex to extract timestamp without full JSON parse.
   */
  private async streamFileMetadata(filePath: string): Promise<StreamedMetadata> {
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;
    let messageCount = 0;

    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        messageCount++;

        // Fast timestamp extraction without full JSON parse.
        // ISO prefix anchor avoids false positives from "timestamp" inside string values.
        const tsMatch = /"timestamp"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/.exec(trimmed);
        if (tsMatch) {
          if (!firstTimestamp) firstTimestamp = tsMatch[1];
          lastTimestamp = tsMatch[1];
        }
      }
      rl.close();
      stream.destroy();
    } catch {
      // ignore — return whatever we collected so far
    }

    return { firstTimestamp, lastTimestamp, messageCount };
  }

  private async getFileMtime(filePath: string): Promise<string> {
    try {
      const stat = await fs.stat(filePath);
      return stat.mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
}

function findOriginalCase(text: string, lowerName: string): string {
  const regex = new RegExp(`\\b(${escapeRegex(lowerName)})\\b`, 'i');
  const match = regex.exec(text);
  return match ? match[1] : lowerName;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
