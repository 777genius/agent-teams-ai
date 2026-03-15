import { encodePath, extractBaseDir, getProjectsBasePath } from '@main/utils/pathDecoder';
import { isLeadAgentType } from '@shared/utils/leadDetection';
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

/** Grace before task creation — logs cannot reference a task before it exists. */
const TASK_SINCE_GRACE_MS = 2 * 60 * 1000;
const FILE_MENTIONS_CACHE_MAX = 10_000;

/** Max concurrent file reads during parallel scan phases. */
const SCAN_CONCURRENCY = 15;

/** TTL for discoverProjectSessions cache — avoids re-reading config/dirs within rapid successive calls. */
const DISCOVERY_CACHE_TTL = 5_000;

/** Signal sources for subagent member attribution, ordered by reliability. */
type AttributionSignalSource = 'process_team' | 'routing_sender' | 'teammate_id' | 'text_mention';

interface DetectionSignal {
  member: string;
  source: AttributionSignalSource;
}

/**
 * Precedence order for attribution signals (most reliable first).
 * - process_team: from system init message — written by CLI, definitive
 * - routing_sender: from toolUseResult.routing — identifies the actual agent
 * - teammate_id: from <teammate-message> XML — identifies the message SENDER, not the agent
 * - text_mention: regex match of member name in text — lowest reliability
 */
const SIGNAL_PRECEDENCE: readonly AttributionSignalSource[] = [
  'process_team',
  'routing_sender',
  'teammate_id',
  'text_mention',
];

interface StreamedMetadata {
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  messageCount: number;
  lastOutputPreview: string | null;
}

/** Result of attributing a subagent file to a team member. */
interface SubagentAttribution {
  detectedMember: string;
  description: string;
  firstTimestamp: string | null;
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
  private readonly fileMentionsCache = new Map<string, boolean>();
  private readonly discoveryCache = new Map<
    string,
    {
      result: NonNullable<Awaited<ReturnType<TeamMemberLogsFinder['discoverProjectSessions']>>>;
      expiresAt: number;
    }
  >();

  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore()
  ) {}

  async findMemberLogs(
    teamName: string,
    memberName: string,
    mtimeSinceMs?: number | null
  ): Promise<MemberLogSummary[]> {
    const discovery = await this.discoverMemberFiles(teamName, memberName);
    if (!discovery) return [];

    const { projectDir, projectId, config, sessionIds, knownMembers, isLeadMember } = discovery;
    const results: MemberLogSummary[] = [];

    const leadMemberName =
      config.members?.find((m) => isLeadAgentType(m?.agentType))?.name?.trim() || 'team-lead';
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

    // ── Collect and parallel-scan subagent files ──
    const candidates = await this.collectSubagentCandidates(projectDir, sessionIds);
    const settled: (MemberSubagentLogSummary | null)[] = new Array(candidates.length).fill(null);
    let nextIdx = 0;

    const scanWorker = async (): Promise<void> => {
      while (nextIdx < candidates.length) {
        const idx = nextIdx++;
        const c = candidates[idx];
        try {
          // Skip files older than the caller's time window (cheap fs.stat, no file read)
          if (mtimeSinceMs != null) {
            try {
              const stat = await fs.stat(c.filePath);
              if (stat.mtimeMs < mtimeSinceMs) continue;
            } catch {
              continue;
            }
          }
          const summary = await this.parseSubagentSummary(
            c.filePath,
            projectId,
            c.sessionId,
            c.fileName,
            memberName,
            knownMembers
          );
          if (summary) settled[idx] = summary;
        } catch (err) {
          logger.warn(`Failed to parse subagent summary: ${c.filePath}`, err);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SCAN_CONCURRENCY, candidates.length) }, () => scanWorker())
    );
    for (const s of settled) {
      if (s) results.push(s);
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
    const t0 = performance.now();

    const discovery = await this.discoverProjectSessions(teamName);
    const tDiscovery = performance.now();

    if (!discovery) {
      console.log(
        `[perf] findLogsForTask(${taskId}) discovery=null ${(tDiscovery - t0).toFixed(0)}ms`
      );
      return [];
    }

    const sinceMs = this.deriveSinceMs(options);
    const { projectDir, projectId, config, sessionIds, knownMembers } = discovery;
    const results: MemberLogSummary[] = [];
    const leadMemberName =
      config.members?.find((m) => isLeadAgentType(m?.agentType))?.name?.trim() || 'team-lead';

    if (config.leadSessionId) {
      const leadJsonl = path.join(projectDir, `${config.leadSessionId}.jsonl`);
      try {
        await fs.access(leadJsonl);
        if (await this.fileMentionsTaskIdCached(leadJsonl, teamName, taskId, true, sinceMs)) {
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
    const tLead = performance.now();

    // ── Collect all subagent file candidates ──
    const candidates = await this.collectSubagentCandidates(projectDir, sessionIds);

    // ── Parallel scan with concurrency limit ──
    const settled: (MemberLogSummary | null)[] = new Array(candidates.length).fill(null);
    let nextIdx = 0;
    let mentionHits = 0;

    const scanWorker = async (): Promise<void> => {
      while (nextIdx < candidates.length) {
        const idx = nextIdx++;
        const c = candidates[idx];
        try {
          if (!(await this.fileMentionsTaskIdCached(c.filePath, teamName, taskId, false, sinceMs)))
            continue;
          mentionHits++;
          const attribution = await this.attributeSubagent(c.filePath, knownMembers);
          if (!attribution) continue;
          const summary = await this.parseSubagentSummary(
            c.filePath,
            projectId,
            c.sessionId,
            c.fileName,
            attribution.detectedMember,
            knownMembers,
            attribution
          );
          if (summary) settled[idx] = summary;
        } catch (err) {
          logger.warn(`Failed to scan subagent file: ${c.filePath}`, err);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SCAN_CONCURRENCY, candidates.length) }, () => scanWorker())
    );
    for (const s of settled) {
      if (s) results.push(s);
    }
    const totalFiles = candidates.length;
    const step2Count = results.length; // count before step 3 (owner fallback)
    const tScan = performance.now();

    const normalizedOwner =
      typeof options?.owner === 'string' ? options.owner.trim() : options?.owner;
    const isLeadOwner =
      typeof normalizedOwner === 'string' &&
      normalizedOwner.length > 0 &&
      normalizedOwner.toLowerCase() === leadMemberName.toLowerCase();
    const ownerRelevantStatus =
      options?.status === 'in_progress' || options?.status === 'completed';
    const includeOwnerSessions =
      ownerRelevantStatus &&
      typeof normalizedOwner === 'string' &&
      normalizedOwner.length > 0 &&
      !isLeadOwner;
    if (includeOwnerSessions) {
      const ownerLogs = await this.findMemberLogs(teamName, normalizedOwner, sinceMs);

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
      const sinceStartMs = Number.isFinite(sinceMsRaw) ? sinceMsRaw : null;
      const effectiveIntervals =
        normalizedIntervals.length > 0
          ? normalizedIntervals
          : sinceStartMs != null
            ? [{ startMs: sinceStartMs, endMs: null }]
            : [];

      const filteredOwnerLogs = ownerLogs.filter((log) => {
        if (log.isOngoing) return true;
        const startMs = new Date(log.startTime).getTime();
        if (!Number.isFinite(startMs)) return false;
        const durationMs =
          typeof log.durationMs === 'number' && log.durationMs > 0 ? log.durationMs : 0;
        const endMs = startMs + durationMs;

        if (effectiveIntervals.length > 0) {
          return this.logOverlapsIntervals(
            startMs,
            endMs,
            effectiveIntervals,
            now,
            TASK_LOG_INTERVAL_GRACE_MS
          );
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
    const tOwner = performance.now();

    // Dedup cumulative subagent snapshots: keep 1 file per sessionId+memberName (largest).
    // In-process teammates produce cumulative JSONL files where each successive file
    // contains ALL lines from the previous + a new delta. The largest file is a superset.
    const preDedupCount = results.length;
    {
      const subagentsByKey = new Map<string, MemberSubagentLogSummary>();
      const nonSubagent: MemberLogSummary[] = [];
      for (const r of results) {
        if (r.kind !== 'subagent') {
          nonSubagent.push(r);
          continue;
        }
        const memberKey = r.memberName ? r.memberName.toLowerCase() : `_${r.subagentId}`;
        const key = `${r.sessionId}:${memberKey}`;
        const existing = subagentsByKey.get(key);
        if (!existing || r.messageCount > existing.messageCount) {
          subagentsByKey.set(key, r);
        }
      }
      results.length = 0;
      results.push(...nonSubagent, ...subagentsByKey.values());
    }
    // NOTE: dedup assumes cumulative snapshots (largest file = superset of all smaller ones).
    // Safety net: filterChunksByWorkIntervals on frontend still filters content by time,
    // so even if the wrong file is picked, only task-relevant chunks are shown.

    const sorted = results.sort(
      (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );
    const tTotal = performance.now();

    console.log(
      `[findLogsForTask] task=${taskId}@${teamName} | ` +
        `step2=${step2Count} (scan ${mentionHits}/${totalFiles} files) | ` +
        `step3=${preDedupCount - step2Count} (owner=${normalizedOwner ?? 'none'}, includeOwner=${includeOwnerSessions}) | ` +
        `dedup=${preDedupCount}→${sorted.length} | ` +
        `total=${sorted.length} | ` +
        `${(tTotal - t0).toFixed(0)}ms`
    );

    return sorted;
  }

  /**
   * Fast path for change extraction: returns task-related JSONL file refs directly without
   * building full MemberLogSummary metadata for every matched log.
   */
  async findLogFileRefsForTask(
    teamName: string,
    taskId: string,
    options?: {
      owner?: string;
      status?: string;
      intervals?: { startedAt: string; completedAt?: string }[];
      since?: string;
    }
  ): Promise<{ filePath: string; memberName: string }[]> {
    const t0 = performance.now();

    const discovery = await this.discoverProjectSessions(teamName);
    const tDiscovery = performance.now();

    if (!discovery) {
      // console.log(
      //   `[perf] findLogFileRefsForTask(${taskId}) discovery=null ${(tDiscovery - t0).toFixed(0)}ms`
      // );
      return [];
    }

    const sinceMs = this.deriveSinceMs(options);
    const { projectDir, config, sessionIds, knownMembers } = discovery;
    const refs: { filePath: string; memberName: string; sortTime: number }[] = [];
    const seen = new Set<string>();
    const leadMemberName =
      config.members?.find((m) => isLeadAgentType(m?.agentType))?.name?.trim() || 'team-lead';

    const pushRef = (filePath: string, memberName: string, sortTime = 0): void => {
      const key = `${memberName.toLowerCase()}:${filePath}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({ filePath, memberName, sortTime });
    };

    if (config.leadSessionId) {
      const leadJsonl = path.join(projectDir, `${config.leadSessionId}.jsonl`);
      try {
        await fs.access(leadJsonl);
        if (await this.fileMentionsTaskIdCached(leadJsonl, teamName, taskId, true, sinceMs)) {
          const firstTimestamp = await this.probeFirstTimestamp(leadJsonl);
          pushRef(leadJsonl, leadMemberName, await this.getSortTime(leadJsonl, firstTimestamp));
        }
      } catch {
        // file missing or unreadable
      }
    }
    const tLead = performance.now();

    // ── Collect all subagent file candidates ──
    const candidates = await this.collectSubagentCandidates(projectDir, sessionIds);

    // ── Parallel scan with concurrency limit ──
    let nextIdx = 0;
    let mentionHits = 0;

    const scanWorker = async (): Promise<void> => {
      while (nextIdx < candidates.length) {
        const idx = nextIdx++;
        const c = candidates[idx];
        try {
          if (!(await this.fileMentionsTaskIdCached(c.filePath, teamName, taskId, false, sinceMs)))
            continue;
          mentionHits++;
          const attribution = await this.attributeSubagent(c.filePath, knownMembers);
          if (!attribution) continue;
          pushRef(
            c.filePath,
            attribution.detectedMember,
            await this.getSortTime(c.filePath, attribution.firstTimestamp)
          );
        } catch (err) {
          logger.warn(`Failed to scan subagent file: ${c.filePath}`, err);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SCAN_CONCURRENCY, candidates.length) }, () => scanWorker())
    );
    const totalFiles = candidates.length;
    const tScan = performance.now();

    const normalizedOwner =
      typeof options?.owner === 'string' ? options.owner.trim() : options?.owner;
    const isLeadOwner =
      typeof normalizedOwner === 'string' &&
      normalizedOwner.length > 0 &&
      normalizedOwner.toLowerCase() === leadMemberName.toLowerCase();
    const ownerRelevantStatus =
      options?.status === 'in_progress' || options?.status === 'completed';
    const includeOwnerSessions =
      ownerRelevantStatus &&
      typeof normalizedOwner === 'string' &&
      normalizedOwner.length > 0 &&
      !isLeadOwner;

    if (includeOwnerSessions) {
      const ownerLogs = await this.findMemberLogs(teamName, normalizedOwner, sinceMs);
      const TASK_LOG_INTERVAL_GRACE_MS = 10_000;
      const fallbackRecentMs = 30 * 60_000;
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

      const sinceMsRaw = typeof options?.since === 'string' ? Date.parse(options.since) : NaN;
      const sinceStartMs = Number.isFinite(sinceMsRaw) ? sinceMsRaw : null;
      const effectiveIntervals =
        normalizedIntervals.length > 0
          ? normalizedIntervals
          : sinceStartMs != null
            ? [{ startMs: sinceStartMs, endMs: null }]
            : [];

      for (const log of ownerLogs) {
        if (!log.filePath) continue;
        if (!log.isOngoing) {
          const startMs = new Date(log.startTime).getTime();
          if (!Number.isFinite(startMs)) continue;
          const durationMs =
            typeof log.durationMs === 'number' && log.durationMs > 0 ? log.durationMs : 0;
          const endMs = startMs + durationMs;

          if (effectiveIntervals.length > 0) {
            if (
              !this.logOverlapsIntervals(
                startMs,
                endMs,
                effectiveIntervals,
                now,
                TASK_LOG_INTERVAL_GRACE_MS
              )
            ) {
              continue;
            }
          } else if (startMs < now - fallbackRecentMs) {
            continue;
          }
        }

        pushRef(
          log.filePath,
          log.memberName ?? normalizedOwner,
          Number.isFinite(new Date(log.startTime).getTime()) ? new Date(log.startTime).getTime() : 0
        );
      }
    }
    const tOwner = performance.now();

    // Dedup cumulative subagent snapshots (same logic as findLogsForTask).
    {
      const refsByKey = new Map<string, (typeof refs)[0]>();
      const leadRefs: (typeof refs)[0][] = [];
      for (const ref of refs) {
        if (ref.memberName.toLowerCase() === leadMemberName.toLowerCase()) {
          leadRefs.push(ref);
          continue;
        }
        const parts = ref.filePath.split(path.sep);
        const subagentsIdx = parts.lastIndexOf('subagents');
        const sessionId = subagentsIdx > 0 ? parts[subagentsIdx - 1] : '';
        const key = `${sessionId}:${ref.memberName.toLowerCase()}`;
        const existing = refsByKey.get(key);
        if (!existing || ref.sortTime > existing.sortTime) {
          refsByKey.set(key, ref);
        }
      }
      refs.length = 0;
      refs.push(...leadRefs, ...refsByKey.values());
    }

    const sortedRefs = [...refs].sort((a, b) => b.sortTime - a.sortTime);
    const tTotal = performance.now();

    // console.log(
    //   `[perf] findLogFileRefsForTask(${taskId}@${teamName}) ` +
    //     `total=${(tTotal - t0).toFixed(0)}ms | ` +
    //     `discovery=${(tDiscovery - t0).toFixed(0)}ms | ` +
    //     `lead=${(tLead - tDiscovery).toFixed(0)}ms | ` +
    //     `scan=${(tScan - tLead).toFixed(0)}ms (${totalFiles} files, ${mentionHits} hits) | ` +
    //     `owner=${(tOwner - tScan).toFixed(0)}ms | ` +
    //     `sessions=${sessionIds.length} | results=${sortedRefs.length}`
    // );

    return sortedRefs.map(({ filePath, memberName }) => ({ filePath, memberName }));
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

  /**
   * Fast marker probe for task-related logs.
   * Prefer structured MCP/TaskUpdate markers for modern sessions.
   */
  async hasTaskUpdateMarker(filePath: string, taskId: string): Promise<boolean> {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const trimmedId = taskId.trim();
    // CLI agents may use displayId (first 8 chars of UUID) in tool inputs.
    // Build regex that matches either form.
    const displayId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmedId)
        ? trimmedId.slice(0, 8).toLowerCase()
        : null;
    const idAlternation = displayId
      ? `(?:${trimmedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${displayId})`
      : trimmedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`"taskId"\\s*:\\s*"${idAlternation}"`);

    try {
      for await (const line of rl) {
        if (line.includes('TaskUpdate') && pattern.test(line)) {
          rl.close();
          stream.destroy();
          return true;
        }
        if (
          (line.includes('"task_start"') ||
            line.includes('"task_complete"') ||
            line.includes('"task_set_status"')) &&
          pattern.test(line)
        ) {
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
    // Check discovery cache — avoids re-reading config/dirs within rapid successive calls
    const cached = this.discoveryCache.get(teamName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

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

    const discoveredSessionIds = await this.listSessionDirs(projectDir);
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
      // Prefer config-backed sessions first, but also include any live session dirs that have
      // appeared on disk and are not yet reflected in config/sessionHistory.
      sessionIds = Array.from(new Set([...verified, ...discoveredSessionIds]));
    } else {
      sessionIds = discoveredSessionIds;
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

    const discovery = { projectDir, projectId, config, sessionIds, knownMembers };
    this.discoveryCache.set(teamName, {
      result: discovery,
      expiresAt: Date.now() + DISCOVERY_CACHE_TTL,
    });
    return discovery;
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
      config.members?.find((m) => isLeadAgentType(m?.agentType))?.name?.trim() || 'team-lead';
    const isLeadMember = leadMemberName.toLowerCase() === memberName.trim().toLowerCase();
    return { ...discovery, isLeadMember };
  }

  /**
   * Collect all subagent JSONL file candidates across session directories.
   * Filters out non-agent files and compact files (agent-acompact*).
   */
  private async collectSubagentCandidates(
    projectDir: string,
    sessionIds: string[]
  ): Promise<{ filePath: string; sessionId: string; fileName: string }[]> {
    const candidates: { filePath: string; sessionId: string; fileName: string }[] = [];
    for (const sessionId of sessionIds) {
      const subagentsDir = path.join(projectDir, sessionId, 'subagents');
      let dirFiles: string[];
      try {
        dirFiles = await fs.readdir(subagentsDir);
      } catch {
        continue;
      }
      for (const f of dirFiles) {
        if (!f.startsWith('agent-') || !f.endsWith('.jsonl') || f.startsWith('agent-acompact'))
          continue;
        candidates.push({ filePath: path.join(subagentsDir, f), sessionId, fileName: f });
      }
    }
    return candidates;
  }

  private deriveSinceMs(options?: {
    intervals?: { startedAt: string; completedAt?: string }[];
    since?: string;
  }): number | null {
    const sinceRaw = typeof options?.since === 'string' ? options.since : null;
    if (sinceRaw) {
      const ms = Date.parse(sinceRaw);
      return Number.isFinite(ms) ? ms : null;
    }
    const intervals = options?.intervals;
    if (!Array.isArray(intervals) || intervals.length === 0) return null;
    let earliest = Number.POSITIVE_INFINITY;
    for (const i of intervals) {
      if (typeof i.startedAt === 'string') {
        const ms = Date.parse(i.startedAt);
        if (Number.isFinite(ms) && ms < earliest) earliest = ms;
      }
    }
    if (!Number.isFinite(earliest) || earliest === Number.POSITIVE_INFINITY) return null;
    return earliest - TASK_SINCE_GRACE_MS;
  }

  private logOverlapsIntervals(
    logStartMs: number,
    logEndMs: number,
    intervals: { startMs: number; endMs: number | null }[],
    now: number,
    graceMs: number
  ): boolean {
    for (const it of intervals) {
      const start = it.startMs - graceMs;
      const end = (it.endMs ?? now) + graceMs;
      if (logStartMs <= end && logEndMs >= start) return true;
    }
    return false;
  }

  private async fileMentionsTaskIdCached(
    filePath: string,
    teamName: string,
    taskId: string,
    assumeTeam: boolean,
    sinceMs: number | null
  ): Promise<boolean> {
    let mtimeMs: number;
    try {
      const stat = await fs.stat(filePath);
      mtimeMs = stat.mtimeMs;
    } catch {
      return false;
    }
    if (sinceMs != null && mtimeMs < sinceMs - TASK_SINCE_GRACE_MS) {
      return false;
    }
    const cacheKey = `${filePath}:${mtimeMs}:${taskId}:${teamName}:${assumeTeam}`;
    const cached = this.fileMentionsCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = await this.fileMentionsTaskId(filePath, teamName, taskId, assumeTeam);
    this.fileMentionsCache.set(cacheKey, result);
    if (this.fileMentionsCache.size > FILE_MENTIONS_CACHE_MAX) {
      const keys = [...this.fileMentionsCache.keys()];
      for (let i = 0; i < Math.min(keys.length / 2, 50); i++) {
        this.fileMentionsCache.delete(keys[i]);
      }
    }
    return result;
  }

  private async fileMentionsTaskId(
    filePath: string,
    teamName: string,
    taskId: string,
    assumeTeam: boolean = false
  ): Promise<boolean> {
    const teamLower = teamName.trim().toLowerCase();
    const taskIdStr = taskId.trim();

    // CLI agents often use the short displayId (first 8 chars of UUID) in tool inputs,
    // while the UI passes the full UUID. Match both forms to bridge this gap.
    const taskIdDisplayForm =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskIdStr)
        ? taskIdStr.slice(0, 8).toLowerCase()
        : null;

    const matchesTaskId = (candidate: string): boolean =>
      candidate === taskIdStr ||
      (taskIdDisplayForm !== null && candidate.toLowerCase() === taskIdDisplayForm);

    const extractTaskIdFromUnknown = (raw: unknown): string | null => {
      if (typeof raw === 'string') return raw.trim();
      if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
      return null;
    };

    const extractTeamFromInput = (input: Record<string, unknown>): string | null => {
      const raw =
        typeof input.team_name === 'string'
          ? input.team_name
          : typeof input.teamName === 'string'
            ? input.teamName
            : typeof input.team === 'string'
              ? input.team
              : null;
      return typeof raw === 'string' ? raw.trim() : null;
    };

    const matchesTeamMentionText = (text: string): boolean => {
      const t = text.toLowerCase();
      if (!t.includes(teamLower)) return false;
      // Strongest signal: spawn/system prompt format includes: on team "X" (X)
      // Use substring checks to avoid regex word-boundary issues with kebab-case names.
      if (t.includes(`on team "${teamLower}"`)) return true;
      if (t.includes(`on team '${teamLower}'`)) return true;
      if (t.includes(`on team ${teamLower}`)) return true;
      if (t.includes(`(${teamLower})`)) return true;
      return false;
    };

    const extractTeamFromProcess = (entry: Record<string, unknown>): string | null => {
      const init = entry.init as Record<string, unknown> | undefined;
      const process = (entry.process ?? init?.process) as Record<string, unknown> | undefined;
      const team = process?.team as Record<string, unknown> | undefined;
      const raw =
        typeof team?.teamName === 'string'
          ? team.teamName
          : typeof team?.team_name === 'string'
            ? team.team_name
            : typeof team?.name === 'string'
              ? team.name
              : null;
      return typeof raw === 'string' ? raw.trim() : null;
    };

    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let teamSeen = assumeTeam;
      let taskSeenWithoutTeam = false;
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          // Team detection (for TaskUpdate without team_name): accept only if we can
          // confidently attribute the file to this team.
          if (!teamSeen) {
            const procTeam = extractTeamFromProcess(entry);
            if (procTeam?.toLowerCase() === teamLower) {
              teamSeen = true;
            }
          }
          if (!teamSeen) {
            const msg = entry.message as Record<string, unknown> | undefined;
            const rawContent = msg?.content ?? entry.content;
            if (typeof rawContent === 'string' && matchesTeamMentionText(rawContent)) {
              teamSeen = true;
            }
          }

          const content = this.extractEntryContent(entry);
          if (!Array.isArray(content)) continue;

          if (!teamSeen) {
            // Check message text blocks for team mention (common in Solo spawn prompts)
            for (const block of content) {
              if (!block || typeof block !== 'object') continue;
              const b = block as Record<string, unknown>;
              if (
                b.type === 'text' &&
                typeof b.text === 'string' &&
                matchesTeamMentionText(b.text)
              ) {
                teamSeen = true;
                break;
              }
            }
          }

          if (teamSeen && taskSeenWithoutTeam) {
            rl.close();
            stream.destroy();
            return true;
          }

          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const b = block as Record<string, unknown>;
            if (b.type !== 'tool_use') continue;

            // Skip read-only task tools — they reference taskId but don't indicate
            // that this session actually WORKED on the task. Agents commonly call
            // task_get to check dependencies from other tasks, producing false matches.
            const toolName = typeof b.name === 'string' ? b.name : '';
            if (
              toolName === 'task_get' ||
              toolName === 'mcp__agent-teams__task_get' ||
              toolName === 'TaskGet'
            )
              continue;

            const input = b.input as Record<string, unknown> | undefined;
            if (!input) continue;

            // Deterministic structured match: any tool whose input references this task+team.
            const inputTeam = extractTeamFromInput(input);
            const rawTaskId = input.taskId ?? input.task_id;
            const inputTaskId = extractTaskIdFromUnknown(rawTaskId);
            if (inputTaskId && matchesTaskId(inputTaskId)) {
              // If team is present in the input, require exact match.
              if (inputTeam) {
                if (inputTeam.toLowerCase() === teamLower) {
                  rl.close();
                  stream.destroy();
                  return true;
                }
              } else {
                // Some agents use TaskUpdate without team_name (common in Solo).
                // Only accept when we have a separate team marker for this file.
                if (teamSeen) {
                  rl.close();
                  stream.destroy();
                  return true;
                }
                taskSeenWithoutTeam = true;
              }
            }
          }

          if (teamSeen && taskSeenWithoutTeam) {
            rl.close();
            stream.destroy();
            return true;
          }
        } catch {
          // ignore parse errors
        }
      }
      rl.close();
      stream.destroy();
    } catch {
      // ignore
    }
    return false;
  }

  private extractEntryContent(entry: Record<string, unknown>): unknown[] | null {
    const message = entry.message as Record<string, unknown> | undefined;
    if (message && Array.isArray(message.content)) return message.content as unknown[];
    if (Array.isArray(entry.content)) return entry.content as unknown[];
    return null;
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
    knownMembers: Set<string>,
    precomputedAttribution?: SubagentAttribution
  ): Promise<MemberSubagentLogSummary | null> {
    const subagentId = fileName.replace(/^agent-/, '').replace(/\.jsonl$/, '');

    // ── Phase 1: Attribution (first N lines) ──
    // Reuse pre-computed attribution when available to avoid re-reading the file.
    const attribution =
      precomputedAttribution ?? (await this.attributeSubagent(filePath, knownMembers));
    if (!attribution) return null;

    const targetLower = targetMember.toLowerCase();
    if (attribution.detectedMember.toLowerCase() !== targetLower) {
      return null;
    }

    // ── Phase 2: Metadata (stream entire file) ──
    // Now that we know the file belongs to this member, collect
    // accurate timestamps and message count from the full file.
    const metadata = await this.streamFileMetadata(filePath);

    const firstTimestamp =
      metadata.firstTimestamp ?? attribution.firstTimestamp ?? (await this.getFileMtime(filePath));
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
      filePath,
      lastOutputPreview: metadata.lastOutputPreview ?? undefined,
    };
  }

  /**
   * Phase 1: Scan first ATTRIBUTION_SCAN_LINES lines for member detection signals
   * and extract a human-readable description from the first user message.
   * Returns null if the file is a warmup session or empty.
   *
   * Collects ALL detection signals, then selects the best one by precedence
   * (process_team > routing_sender > teammate_id > text_mention).
   */
  private async attributeSubagent(
    filePath: string,
    knownMembers: Set<string>
  ): Promise<SubagentAttribution | null> {
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
    const signals: DetectionSignal[] = [];
    let firstTimestamp: string | null = null;

    for (const line of lines) {
      if (!firstTimestamp) {
        firstTimestamp = this.extractTimestampFromLine(line);
      }

      try {
        const msg = JSON.parse(line) as Record<string, unknown>;

        const role = this.extractRole(msg);
        const textContent = this.extractTextContent(msg);

        // Skip warmup messages
        if (role === 'user' && textContent?.trim() === 'Warmup') {
          return null;
        }

        // Extract description from first user message + collect teammate_id signal
        if (role === 'user' && textContent) {
          if (textContent.trimStart().startsWith('<teammate-message')) {
            const parsed = parseAllTeammateMessages(textContent);
            if (!description) {
              description =
                parsed[0]?.summary || parsed[0]?.content?.slice(0, 200) || 'Teammate spawn';
            }

            // teammate_id identifies the MESSAGE SENDER (e.g. "team-lead"), not the agent
            // owning this file. Collected as a signal — higher-precedence sources override.
            if (parsed[0]?.teammateId) {
              const tmId = parsed[0].teammateId.trim().toLowerCase();
              if (tmId.length > 0 && knownMembers.has(tmId)) {
                signals.push({ member: parsed[0].teammateId.trim(), source: 'teammate_id' });
              }
            }
          } else if (!description) {
            description = textContent.slice(0, 200);
          }
        }

        // Collect text_mention signal (lowest reliability — exact one member name in text)
        const textMention = this.detectMemberFromMessage(msg, knownMembers);
        if (textMention) {
          signals.push({ member: textMention.name, source: 'text_mention' });
        }

        // Collect routing_sender signal (high reliability — identifies the actual agent)
        if (msg.toolUseResult && typeof msg.toolUseResult === 'object') {
          const routing = (msg.toolUseResult as Record<string, unknown>).routing as
            | Record<string, unknown>
            | undefined;
          if (routing && typeof routing.sender === 'string') {
            const sender = routing.sender.toLowerCase();
            if (knownMembers.has(sender)) {
              signals.push({ member: routing.sender, source: 'routing_sender' });
            }
          }
        }

        // Collect process_team signal (highest reliability — from system init message)
        const init = msg.init as Record<string, unknown> | undefined;
        const process = (msg.process ?? init?.process) as Record<string, unknown> | undefined;
        const team = process?.team as Record<string, unknown> | undefined;
        if (team && typeof team.memberName === 'string') {
          const memberNameLower = team.memberName.trim().toLowerCase();
          if (memberNameLower.length > 0 && knownMembers.has(memberNameLower)) {
            signals.push({ member: team.memberName.trim(), source: 'process_team' });
          }
        }
      } catch {
        // Skip malformed lines
      }

      // Early exit: reliable signal found and description extracted — no need to scan further.
      // Only process_team and routing_sender trigger this; teammate_id is unreliable (identifies
      // the message sender, not the agent) so we keep scanning for better signals.
      if (
        description &&
        signals.some((s) => s.source === 'process_team' || s.source === 'routing_sender')
      ) {
        break;
      }
    }

    if (signals.length === 0) return null;

    const best = TeamMemberLogsFinder.selectBestSignal(signals);
    if (!best) return null;

    return { detectedMember: best.member, description, firstTimestamp };
  }

  /**
   * Select the best detection signal by precedence.
   * Signals are collected in file order, so find() returns the earliest occurrence
   * of the highest-precedence source.
   */
  private static selectBestSignal(signals: DetectionSignal[]): DetectionSignal | null {
    for (const source of SIGNAL_PRECEDENCE) {
      const match = signals.find((s) => s.source === source);
      if (match) return match;
    }
    return null;
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
      filePath: jsonlPath,
      lastOutputPreview: metadata.lastOutputPreview ?? undefined,
    };
  }

  /**
   * Stream entire JSONL file collecting timestamps, message count, and last assistant output.
   * Lightweight — uses regex to extract fields without full JSON parse.
   */
  private async streamFileMetadata(filePath: string): Promise<StreamedMetadata> {
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;
    let messageCount = 0;
    let lastOutputPreview: string | null = null;

    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        messageCount++;

        // Fast timestamp extraction without full JSON parse.
        const ts = this.extractTimestampFromLine(trimmed);
        if (ts) {
          if (!firstTimestamp) firstTimestamp = ts;
          lastTimestamp = ts;
        }

        // Track last assistant text output (cheap regex, overwrites on each match).
        if (trimmed.includes('"role":"assistant"') || trimmed.includes('"role": "assistant"')) {
          const preview = TeamMemberLogsFinder.extractAssistantPreview(trimmed);
          if (preview) lastOutputPreview = preview;
        }
      }
      rl.close();
      stream.destroy();
    } catch {
      // ignore — return whatever we collected so far
    }

    return { firstTimestamp, lastTimestamp, messageCount, lastOutputPreview };
  }

  private extractTimestampFromLine(line: string): string | null {
    const tsMatch = /"timestamp"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/.exec(line);
    return tsMatch?.[1] ?? null;
  }

  /**
   * Extract a short text preview from an assistant message line.
   * Looks for the first text block content via regex (avoids full JSON parse).
   */
  private static extractAssistantPreview(line: string): string | null {
    // Match {"type":"text","text":"..."} blocks
    const textMatch = /"type"\s*:\s*"text"[^}]*"text"\s*:\s*"([^"]{1,200})/.exec(line);
    if (textMatch?.[1]) {
      const raw = textMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\t/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return raw.length > 120 ? raw.slice(0, 120) + '...' : raw;
    }
    // Fallback: top-level string content
    const contentMatch = /"content"\s*:\s*"([^"]{1,200})/.exec(line);
    if (contentMatch?.[1]) {
      const raw = contentMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\t/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return raw.length > 120 ? raw.slice(0, 120) + '...' : raw;
    }
    return null;
  }

  private async probeFirstTimestamp(
    filePath: string,
    maxLines = ATTRIBUTION_SCAN_LINES
  ): Promise<string | null> {
    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let seen = 0;

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const ts = this.extractTimestampFromLine(trimmed);
        if (ts) {
          rl.close();
          stream.destroy();
          return ts;
        }
        seen++;
        if (seen >= maxLines) break;
      }
      rl.close();
      stream.destroy();
    } catch {
      // ignore
    }
    return null;
  }

  private async getSortTime(filePath: string, timestamp: string | null): Promise<number> {
    const resolvedTimestamp = timestamp ?? (await this.getFileMtime(filePath));
    const sortTime = Date.parse(resolvedTimestamp);
    return Number.isFinite(sortTime) ? sortTime : 0;
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
