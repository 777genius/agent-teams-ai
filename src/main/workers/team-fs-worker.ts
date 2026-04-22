import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort } from 'node:worker_threads';

import { readBootstrapLaunchSnapshot } from '@main/services/team/TeamBootstrapStateReader';
import { normalizePersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import {
  choosePreferredLaunchStateSummary,
  normalizePersistedLaunchSummaryProjection,
  shouldSuppressLegacyLaunchArtifactHeuristic,
  TEAM_LAUNCH_SUMMARY_FILE,
} from '@main/services/team/TeamLaunchSummaryProjection';
import { isLeadMember } from '@shared/utils/leadDetection';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';

interface ListTeamsPayload {
  teamsDir: string;
  largeConfigBytes: number;
  configHeadBytes: number;
  maxConfigBytes: number;
  maxConfigReadMs: number;
  maxMembersMetaBytes: number;
  maxSessionHistoryInSummary: number;
  maxProjectPathHistoryInSummary: number;
  concurrency: number;
}

interface GetAllTasksPayload {
  tasksBase: string;
  maxTaskBytes: number;
  maxTaskReadMs: number;
  concurrency: number;
}

type WorkerRequest =
  | { id: string; op: 'listTeams'; payload: ListTeamsPayload }
  | { id: string; op: 'getAllTasks'; payload: GetAllTasksPayload };

type WorkerResponse =
  | { id: string; ok: true; result: unknown; diag?: unknown }
  | { id: string; ok: false; error: string };

const UUID_TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function deriveTaskDisplayId(taskId: string): string {
  const normalized = taskId.trim();
  if (!normalized) return normalized;
  return UUID_TASK_ID_PATTERN.test(normalized) ? normalized.slice(0, 8).toLowerCase() : normalized;
}

/**
 * Normalise escaped newline sequences (`\\n`) that some MCP/CLI sources
 * write as literal two-character strings instead of real line-breaks.
 */
function unescapeLiteralNewlines(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

// ---------------------------------------------------------------------------
// Diagnostic types
// ---------------------------------------------------------------------------

interface SlowEntry {
  teamName: string;
  ms: number;
}

interface ListTeamsDiag {
  op: string;
  startedAt: number;
  teamsDir: string;
  totalDirs: number;
  returned: number;
  skipped: number;
  skipReasons: Record<string, number>;
  slowest: SlowEntry[];
  totalMs: number;
}

interface GetAllTasksDiag {
  op: string;
  startedAt: number;
  tasksBase: string;
  teamDirs: number;
  returned: number;
  skipped: number;
  skipReasons: Record<string, number>;
  slowestTeams: SlowEntry[];
  totalMs: number;
}

interface TaskReadDiag {
  skipped: number;
  skipReasons: Record<string, number>;
}

const MAX_LAUNCH_STATE_BYTES = 32 * 1024;
const TEAM_LAUNCH_STATE_FILE = 'launch-state.json';

// ---------------------------------------------------------------------------
// Parsed JSON types (loose shapes from disk)
// ---------------------------------------------------------------------------

interface ParsedConfig {
  name?: unknown;
  description?: unknown;
  color?: unknown;
  projectPath?: unknown;
  leadSessionId?: unknown;
  deletedAt?: unknown;
  projectPathHistory?: unknown;
  sessionHistory?: unknown;
  members?: unknown;
}

interface RawMember {
  name?: unknown;
  agentType?: unknown;
  role?: unknown;
  color?: unknown;
  providerId?: unknown;
  provider?: unknown;
  removedAt?: unknown;
}

interface ParsedTask {
  id?: unknown;
  displayId?: unknown;
  subject?: unknown;
  title?: unknown;
  description?: unknown;
  descriptionTaskRefs?: unknown;
  activeForm?: unknown;
  prompt?: unknown;
  promptTaskRefs?: unknown;
  owner?: unknown;
  createdBy?: unknown;
  status?: unknown;
  blocks?: unknown;
  blockedBy?: unknown;
  related?: unknown;
  createdAt?: unknown;
  projectPath?: unknown;
  comments?: unknown;
  needsClarification?: unknown;
  reviewState?: unknown;
  metadata?: { _internal?: unknown };
  workIntervals?: unknown;
  historyEvents?: unknown;
  attachments?: unknown;
  sourceMessageId?: unknown;
  sourceMessage?: unknown;
}

interface RawWorkInterval {
  startedAt?: unknown;
  completedAt?: unknown;
}

interface RawHistoryEvent {
  id?: unknown;
  type?: unknown;
  timestamp?: unknown;
  actor?: unknown;
  [key: string]: unknown;
}

interface RawComment {
  id?: unknown;
  author?: unknown;
  text?: unknown;
  createdAt?: unknown;
  type?: unknown;
  taskRefs?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

async function readFileUtf8WithTimeout(filePath: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fs.promises.readFile(filePath, { encoding: 'utf8', signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) {
      const err = new Error('READ_TIMEOUT');
      (err as NodeJS.ErrnoException).code = 'READ_TIMEOUT';
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readFileHeadUtf8(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.max(0, Math.min(stat.size, maxBytes));
    if (bytesToRead === 0) return '';
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function extractQuotedString(head: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`);
  const match = re.exec(head);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function nowMs(): number {
  return Date.now();
}

function bumpSkipReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

function pushSlowest(list: SlowEntry[], entry: SlowEntry, maxLen: number): void {
  list.push(entry);
  list.sort((a, b) => b.ms - a.ms);

  if (list.length > maxLen) list.length = maxLen;
}

// ---------------------------------------------------------------------------
// listTeams
// ---------------------------------------------------------------------------

function isRawMember(v: unknown): v is RawMember {
  return !!v && typeof v === 'object';
}

function mergeMember(
  m: RawMember,
  memberMap: Map<string, { name: string; role?: string; color?: string }>,
  removedKeys: ReadonlySet<string>
): void {
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name) return;
  if (name === 'user' || isLeadMember(m)) return;
  const key = name.toLowerCase();
  if (removedKeys.has(key)) return;
  const existing = memberMap.get(key);
  memberMap.set(key, {
    name: existing?.name ?? name,
    role: (typeof m.role === 'string' && m.role.trim()) || existing?.role,
    color: (typeof m.color === 'string' && m.color.trim()) || existing?.color,
  });
}

function dropCliAutoSuffixedMembers(
  memberMap: Map<string, { name: string; role?: string; color?: string }>
): void {
  const keys = Array.from(memberMap.keys());
  const allLower = new Set(keys); // keys are already lowercased
  for (const key of keys) {
    const member = memberMap.get(key);
    const name = member?.name ?? '';
    const match = /^(.+)-(\d+)$/.exec(name.trim());
    if (!match?.[1] || !match[2]) continue;
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix < 2) continue;
    const baseLower = match[1].toLowerCase();
    if (allLower.has(baseLower)) {
      memberMap.delete(key);
    }
  }
}

const PROVISIONER_SUFFIX = '-provisioner';

/**
 * Drop CLI provisioner artifacts ("{name}-provisioner") unconditionally.
 * These are temporary internal agents created during team provisioning
 * and should never be shown to the user.
 */
function dropCliProvisionerMembers(
  memberMap: Map<string, { name: string; role?: string; color?: string }>
): void {
  for (const [key, member] of Array.from(memberMap.entries())) {
    const lower = member.name.trim().toLowerCase();
    if (!lower.endsWith(PROVISIONER_SUFFIX)) continue;
    const base = lower.slice(0, -PROVISIONER_SUFFIX.length);
    if (base) {
      memberMap.delete(key);
    }
  }
}

async function readLaunchState(
  teamsDir: string,
  teamName: string
): Promise<ReturnType<typeof choosePreferredLaunchStateSummary>> {
  const bootstrapSnapshot = await readBootstrapLaunchSnapshot(teamName);
  const launchStatePath = path.join(teamsDir, teamName, TEAM_LAUNCH_STATE_FILE);
  const launchSummaryPath = path.join(teamsDir, teamName, TEAM_LAUNCH_SUMMARY_FILE);
  const [launchSnapshot, launchSummaryProjection] = await Promise.all([
    (async () => {
      try {
        const stat = await fs.promises.stat(launchStatePath);
        if (!stat.isFile() || stat.size > MAX_LAUNCH_STATE_BYTES) {
          return null;
        }
        const raw = await fs.promises.readFile(launchStatePath, 'utf8');
        return normalizePersistedLaunchSnapshot(teamName, JSON.parse(raw));
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        const stat = await fs.promises.stat(launchSummaryPath);
        if (!stat.isFile() || stat.size > MAX_LAUNCH_STATE_BYTES) {
          return null;
        }
        const raw = await fs.promises.readFile(launchSummaryPath, 'utf8');
        return normalizePersistedLaunchSummaryProjection(teamName, JSON.parse(raw));
      } catch {
        return null;
      }
    })(),
  ]);

  return choosePreferredLaunchStateSummary({
    bootstrapSnapshot,
    launchSnapshot,
    launchSummaryProjection,
  });
}

/**
 * Reads a draft team summary from team.meta.json when config.json is missing.
 * Returns null if team.meta.json doesn't exist or is invalid.
 */
async function readDraftTeamMeta(
  teamsDir: string,
  teamName: string
): Promise<Record<string, unknown> | null> {
  const metaPath = path.join(teamsDir, teamName, 'team.meta.json');
  try {
    const stat = await fs.promises.stat(metaPath);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const raw = await fs.promises.readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw) as Record<string, unknown>;
    if (meta?.version !== 1 || typeof meta?.cwd !== 'string') return null;

    const displayName =
      typeof meta.displayName === 'string' && meta.displayName.trim()
        ? meta.displayName.trim()
        : teamName;

    // Read members.meta.json for member count
    let memberCount = 0;
    try {
      const membersPath = path.join(teamsDir, teamName, 'members.meta.json');
      const membersRaw = await fs.promises.readFile(membersPath, 'utf8');
      const membersData = JSON.parse(membersRaw) as { members?: unknown[] };
      if (Array.isArray(membersData?.members)) {
        memberCount = membersData.members.filter((member) => {
          if (!isRawMember(member)) return false;
          const name = typeof member.name === 'string' ? member.name.trim() : '';
          if (!name || name === 'user' || isLeadMember(member)) return false;
          return !member.removedAt;
        }).length;
      }
    } catch {
      // best-effort
    }

    return {
      teamName,
      displayName,
      description: typeof meta.description === 'string' ? meta.description : '',
      memberCount,
      taskCount: 0,
      lastActivity:
        typeof meta.createdAt === 'number' ? new Date(meta.createdAt).toISOString() : null,
      color: typeof meta.color === 'string' ? meta.color : undefined,
      projectPath: typeof meta.cwd === 'string' ? meta.cwd : undefined,
      pendingCreate: true,
    };
  } catch {
    return null;
  }
}

async function listTeams(
  payload: ListTeamsPayload
): Promise<{ teams: unknown[]; diag: ListTeamsDiag }> {
  const startedAt = nowMs();
  const diag: ListTeamsDiag = {
    op: 'listTeams',
    startedAt,
    teamsDir: payload.teamsDir,
    totalDirs: 0,
    returned: 0,
    skipped: 0,
    skipReasons: {},
    slowest: [],
    totalMs: 0,
  };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(payload.teamsDir, { withFileTypes: true });
  } catch {
    diag.totalMs = nowMs() - startedAt;
    return { teams: [], diag };
  }

  const teamDirs = entries.filter((e) => e.isDirectory());
  diag.totalDirs = teamDirs.length;

  const perTeam = await mapLimit(teamDirs, payload.concurrency, async (entry) => {
    const teamName = entry.name;
    const t0 = nowMs();
    const configPath = path.join(payload.teamsDir, teamName, 'config.json');

    const skip = (reason: string): null => {
      diag.skipped++;
      bumpSkipReason(diag.skipReasons, reason);
      return null;
    };

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(configPath);
    } catch {
      // Fallback: check for draft team (team.meta.json without config.json)
      const draft = await readDraftTeamMeta(payload.teamsDir, teamName);
      if (draft) return draft;
      return skip('config_stat_failed');
    }
    if (!stat.isFile()) {
      const draft = await readDraftTeamMeta(payload.teamsDir, teamName);
      if (draft) return draft;
      return skip('config_not_file');
    }
    if (stat.size > payload.maxConfigBytes) return skip('config_too_large');

    let config: ParsedConfig | null = null;
    let displayName: string | null = null;
    let description = '';
    let color: string | undefined;
    let projectPath: string | undefined;
    let leadSessionId: string | undefined;
    let deletedAt: string | undefined;
    let projectPathHistory: string[] | undefined;
    let sessionHistory: string[] | undefined;

    try {
      if (stat.size > payload.largeConfigBytes) {
        const head = await readFileHeadUtf8(configPath, payload.configHeadBytes);
        displayName = extractQuotedString(head, 'name');
        const desc = extractQuotedString(head, 'description');
        description = typeof desc === 'string' ? desc : '';
        const c = extractQuotedString(head, 'color');
        color = typeof c === 'string' && c.trim().length > 0 ? c : undefined;
        const pp = extractQuotedString(head, 'projectPath');
        projectPath = typeof pp === 'string' && pp.trim().length > 0 ? pp : undefined;
        const lead = extractQuotedString(head, 'leadSessionId');
        leadSessionId = typeof lead === 'string' && lead.trim().length > 0 ? lead : undefined;
        const del = extractQuotedString(head, 'deletedAt');
        deletedAt = typeof del === 'string' ? del : undefined;
      } else {
        const raw = await readFileUtf8WithTimeout(configPath, payload.maxConfigReadMs);
        config = JSON.parse(raw) as ParsedConfig;
        displayName = typeof config.name === 'string' ? config.name : null;
        description = typeof config.description === 'string' ? config.description : '';
        color =
          typeof config.color === 'string' && config.color.trim().length > 0
            ? config.color
            : undefined;
        projectPath =
          typeof config.projectPath === 'string' && config.projectPath.trim().length > 0
            ? config.projectPath
            : undefined;
        leadSessionId =
          typeof config.leadSessionId === 'string' && config.leadSessionId.trim().length > 0
            ? config.leadSessionId
            : undefined;
        projectPathHistory = Array.isArray(config.projectPathHistory)
          ? (config.projectPathHistory as string[]).slice(-payload.maxProjectPathHistoryInSummary)
          : undefined;
        sessionHistory = Array.isArray(config.sessionHistory)
          ? (config.sessionHistory as string[]).slice(-payload.maxSessionHistoryInSummary)
          : undefined;
        deletedAt = typeof config.deletedAt === 'string' ? config.deletedAt : undefined;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'READ_TIMEOUT') return skip('config_read_timeout');
      return skip('config_parse_failed');
    }

    if (typeof displayName !== 'string' || displayName.trim() === '') {
      return skip('invalid_display_name');
    }

    const memberMap = new Map<string, { name: string; role?: string; color?: string }>();
    const removedKeys = new Set<string>();
    const expectedTeammateNames = new Set<string>();
    const confirmedArtifactNames = new Set<string>();
    const metaRuntimeMembers: Array<{
      name: string;
      providerId?: 'anthropic' | 'codex' | 'gemini' | 'opencode';
      removedAt?: unknown;
    }> = [];
    let leadProviderId: 'anthropic' | 'codex' | 'gemini' | 'opencode' | undefined;

    try {
      const teamMetaPath = path.join(payload.teamsDir, teamName, 'team.meta.json');
      const teamMetaStat = await fs.promises.stat(teamMetaPath);
      if (teamMetaStat.isFile() && teamMetaStat.size <= 256 * 1024) {
        const raw = await readFileUtf8WithTimeout(teamMetaPath, payload.maxConfigReadMs);
        const parsed = JSON.parse(raw) as { providerId?: unknown };
        leadProviderId =
          parsed?.providerId === 'anthropic' ||
          parsed?.providerId === 'codex' ||
          parsed?.providerId === 'gemini' ||
          parsed?.providerId === 'opencode'
            ? parsed.providerId
            : undefined;
      }
    } catch {
      leadProviderId = undefined;
    }

    try {
      const metaPath = path.join(payload.teamsDir, teamName, 'members.meta.json');
      const metaStat = await fs.promises.stat(metaPath);
      if (metaStat.isFile() && metaStat.size <= payload.maxMembersMetaBytes) {
        const raw = await readFileUtf8WithTimeout(metaPath, payload.maxConfigReadMs);
        const parsed = JSON.parse(raw) as { members?: unknown };
        const members: unknown[] = Array.isArray(parsed?.members) ? parsed.members : [];
        for (const member of members) {
          if (!isRawMember(member)) continue;
          const rawProviderId = member.providerId ?? member.provider;
          const providerId =
            rawProviderId === 'anthropic' ||
            rawProviderId === 'codex' ||
            rawProviderId === 'gemini' ||
            rawProviderId === 'opencode'
              ? rawProviderId
              : undefined;
          const name = typeof member.name === 'string' ? member.name.trim() : '';
          if (!name) continue;
          if (isLeadMember(member)) continue;
          const key = name.toLowerCase();
          if (member.removedAt) {
            removedKeys.add(key);
            metaRuntimeMembers.push({
              name,
              providerId,
              removedAt: member.removedAt,
            });
            continue;
          }
          expectedTeammateNames.add(name);
          metaRuntimeMembers.push({
            name,
            providerId,
          });
          mergeMember(member, memberMap, removedKeys);
        }
      }
    } catch {
      // ignore
    }

    // Merge config members AFTER meta so removedAt can suppress stale config entries.
    if (config && Array.isArray(config.members)) {
      for (const member of config.members as unknown[]) {
        if (isRawMember(member)) {
          const name = typeof member.name === 'string' ? member.name.trim() : '';
          if (name && name !== 'user' && !isLeadMember(member)) {
            confirmedArtifactNames.add(name);
          }
          mergeMember(member, memberMap, removedKeys);
        }
      }
    }

    try {
      const inboxDir = path.join(payload.teamsDir, teamName, 'inboxes');
      const inboxEntries = await fs.promises.readdir(inboxDir, { withFileTypes: true });
      for (const entry of inboxEntries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const inboxName = entry.name.slice(0, -'.json'.length).trim();
        if (!inboxName || inboxName === 'user' || isLeadMember({ name: inboxName })) continue;
        confirmedArtifactNames.add(inboxName);
      }
    } catch {
      // best-effort
    }

    dropCliAutoSuffixedMembers(memberMap);
    dropCliProvisionerMembers(memberMap);

    const members = Array.from(memberMap.values());
    const memberColors = buildTeamMemberColorMap(members, { preferProvidedColors: false });
    const coloredMembers = members.map((member) => ({
      ...member,
      color: memberColors.get(member.name) ?? member.color,
    }));
    const suppressLegacyLaunchArtifactHeuristic = shouldSuppressLegacyLaunchArtifactHeuristic({
      leadProviderId,
      members: metaRuntimeMembers,
    });
    const launchStateSummary =
      (await readLaunchState(payload.teamsDir, teamName)) ??
      (() => {
        if (suppressLegacyLaunchArtifactHeuristic) {
          return null;
        }
        if (
          !leadSessionId ||
          expectedTeammateNames.size === 0 ||
          confirmedArtifactNames.size === 0
        ) {
          return null;
        }
        const missingMembers = Array.from(expectedTeammateNames).filter(
          (name) => !confirmedArtifactNames.has(name)
        );
        if (missingMembers.length === 0) {
          return null;
        }
        return {
          partialLaunchFailure: true as const,
          expectedMemberCount: expectedTeammateNames.size,
          confirmedMemberCount: confirmedArtifactNames.size,
          missingMembers,
        };
      })();
    const summary = {
      teamName,
      displayName,
      description,
      memberCount: memberMap.size,
      taskCount: 0,
      lastActivity: null,
      ...(coloredMembers.length > 0 ? { members: coloredMembers } : {}),
      ...(color ? { color } : {}),
      ...(projectPath ? { projectPath } : {}),
      ...(leadSessionId ? { leadSessionId } : {}),
      ...(projectPathHistory ? { projectPathHistory } : {}),
      ...(sessionHistory ? { sessionHistory } : {}),
      ...(deletedAt ? { deletedAt } : {}),
      ...(launchStateSummary ?? {}),
    };

    const ms = nowMs() - t0;
    if (ms >= 250) {
      pushSlowest(diag.slowest, { teamName, ms }, 10);
    }
    return summary;
  });

  const teams = perTeam.filter((t): t is NonNullable<typeof t> => t !== null);
  diag.returned = teams.length;
  diag.totalMs = nowMs() - startedAt;
  return { teams, diag };
}

// ---------------------------------------------------------------------------
// Task normalization helpers
// ---------------------------------------------------------------------------

function normalizeWorkIntervals(
  parsed: ParsedTask
): { startedAt: string; completedAt?: string }[] | undefined {
  if (!Array.isArray(parsed.workIntervals)) return undefined;
  return (parsed.workIntervals as unknown[])
    .filter(
      (i): i is RawWorkInterval =>
        Boolean(i) &&
        typeof i === 'object' &&
        typeof (i as RawWorkInterval).startedAt === 'string' &&
        ((i as RawWorkInterval).completedAt === undefined ||
          typeof (i as RawWorkInterval).completedAt === 'string')
    )
    .map((i) => ({
      startedAt: i.startedAt as string,
      completedAt: i.completedAt as string | undefined,
    }));
}

function normalizeHistoryEvents(parsed: ParsedTask): RawHistoryEvent[] | undefined {
  if (!Array.isArray(parsed.historyEvents)) return undefined;
  return (parsed.historyEvents as unknown[])
    .filter(
      (i): i is RawHistoryEvent =>
        Boolean(i) &&
        typeof i === 'object' &&
        typeof (i as RawHistoryEvent).id === 'string' &&
        typeof (i as RawHistoryEvent).timestamp === 'string' &&
        typeof (i as RawHistoryEvent).type === 'string'
    )
    .map((i) => ({ ...i }));
}

/** Derive review state from historyEvents (inline reducer for worker isolation). */
function deriveReviewStateFromEvents(events: RawHistoryEvent[] | undefined): string {
  if (!Array.isArray(events) || events.length === 0) return 'none';
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const t = e.type;
    if (
      t === 'review_requested' ||
      t === 'review_changes_requested' ||
      t === 'review_approved' ||
      t === 'review_started'
    ) {
      const to = typeof e.to === 'string' ? e.to : 'none';
      return to === 'review' || to === 'needsFix' || to === 'approved' ? to : 'none';
    }
    if (t === 'status_changed' && e.to === 'in_progress') {
      return 'none';
    }
  }
  return 'none';
}

function normalizeComments(parsed: ParsedTask): unknown[] | undefined {
  if (!Array.isArray(parsed.comments)) return undefined;
  return (parsed.comments as unknown[])
    .filter(
      (c): c is RawComment =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as RawComment).id === 'string' &&
        typeof (c as RawComment).author === 'string' &&
        typeof (c as RawComment).text === 'string' &&
        typeof (c as RawComment).createdAt === 'string'
    )
    .map((c) => ({
      id: c.id as string,
      author: c.author as string,
      text: unescapeLiteralNewlines(c.text as string),
      createdAt: c.createdAt as string,
      taskRefs: Array.isArray(c.taskRefs) ? c.taskRefs : undefined,
      type:
        c.type === 'regular' || c.type === 'review_request' || c.type === 'review_approved'
          ? (c.type as string)
          : 'regular',
    }));
}

// ---------------------------------------------------------------------------
// getAllTasks
// ---------------------------------------------------------------------------

async function readTasksDirForTeam(
  tasksDir: string,
  teamName: string,
  payload: GetAllTasksPayload
): Promise<{ tasks: unknown[]; taskDiag: TaskReadDiag }> {
  const taskDiag: TaskReadDiag = { skipped: 0, skipReasons: {} };
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tasksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { tasks: [], taskDiag };
    }
    throw error;
  }

  const tasks: unknown[] = [];
  for (const file of entries) {
    if (
      !file.endsWith('.json') ||
      file.startsWith('.') ||
      file === '.lock' ||
      file === '.highwatermark'
    ) {
      continue;
    }

    const taskPath = path.join(tasksDir, file);
    try {
      const stat = await fs.promises.stat(taskPath);
      if (!stat.isFile() || stat.size > payload.maxTaskBytes) {
        taskDiag.skipped++;
        bumpSkipReason(taskDiag.skipReasons, 'task_not_file_or_large');
        continue;
      }

      const raw = await readFileUtf8WithTimeout(taskPath, payload.maxTaskReadMs);
      const parsed = JSON.parse(raw) as ParsedTask;
      const metadata = parsed.metadata;
      if (metadata?._internal === true) {
        taskDiag.skipped++;
        bumpSkipReason(taskDiag.skipReasons, 'task_internal');
        continue;
      }
      if (parsed.status === 'deleted') {
        taskDiag.skipped++;
        bumpSkipReason(taskDiag.skipReasons, 'task_deleted');
        continue;
      }

      const subject =
        typeof parsed.subject === 'string'
          ? parsed.subject
          : typeof parsed.title === 'string'
            ? parsed.title
            : '';

      let createdAt: string | undefined =
        typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined;
      let updatedAt: string | undefined;
      try {
        if (!createdAt) {
          const bt = stat.birthtime.getTime();
          createdAt = (bt > 0 ? stat.birthtime : stat.mtime).toISOString();
        }
        updatedAt = stat.mtime.toISOString();
      } catch {
        /* ignore */
      }

      const needsClarification =
        parsed.needsClarification === 'lead' || parsed.needsClarification === 'user'
          ? (parsed.needsClarification as string)
          : undefined;
      const historyEvents = normalizeHistoryEvents(parsed);
      const reviewState = deriveReviewStateFromEvents(historyEvents);

      tasks.push({
        id: typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : '',
        displayId:
          typeof parsed.displayId === 'string' && parsed.displayId.trim().length > 0
            ? parsed.displayId.trim()
            : deriveTaskDisplayId(
                typeof parsed.id === 'string' || typeof parsed.id === 'number'
                  ? String(parsed.id)
                  : ''
              ),
        subject,
        description:
          typeof parsed.description === 'string'
            ? unescapeLiteralNewlines(parsed.description)
            : undefined,
        descriptionTaskRefs: Array.isArray(parsed.descriptionTaskRefs)
          ? (parsed.descriptionTaskRefs as unknown[])
          : undefined,
        activeForm: typeof parsed.activeForm === 'string' ? parsed.activeForm : undefined,
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
        promptTaskRefs: Array.isArray(parsed.promptTaskRefs)
          ? (parsed.promptTaskRefs as unknown[])
          : undefined,
        owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
        createdBy: typeof parsed.createdBy === 'string' ? parsed.createdBy : undefined,
        status:
          parsed.status === 'pending' ||
          parsed.status === 'in_progress' ||
          parsed.status === 'completed' ||
          parsed.status === 'deleted'
            ? (parsed.status as string)
            : 'pending',
        workIntervals: normalizeWorkIntervals(parsed),
        historyEvents: normalizeHistoryEvents(parsed),
        blocks: Array.isArray(parsed.blocks) ? (parsed.blocks as unknown[]) : undefined,
        blockedBy: Array.isArray(parsed.blockedBy) ? (parsed.blockedBy as unknown[]) : undefined,
        related: Array.isArray(parsed.related)
          ? (parsed.related as unknown[]).filter((id): id is string => typeof id === 'string')
          : undefined,
        createdAt,
        updatedAt,
        projectPath: typeof parsed.projectPath === 'string' ? parsed.projectPath : undefined,
        comments: normalizeComments(parsed),
        needsClarification,
        reviewState,
        deletedAt: undefined,
        attachments: Array.isArray(parsed.attachments)
          ? (parsed.attachments as unknown[])
          : undefined,
        sourceMessageId:
          typeof parsed.sourceMessageId === 'string' && parsed.sourceMessageId.trim()
            ? parsed.sourceMessageId.trim()
            : undefined,
        sourceMessage:
          parsed.sourceMessage &&
          typeof parsed.sourceMessage === 'object' &&
          typeof (parsed.sourceMessage as Record<string, unknown>).text === 'string' &&
          typeof (parsed.sourceMessage as Record<string, unknown>).from === 'string' &&
          typeof (parsed.sourceMessage as Record<string, unknown>).timestamp === 'string'
            ? (parsed.sourceMessage as Record<string, unknown>)
            : undefined,
        teamName,
      });
    } catch (error) {
      taskDiag.skipped++;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'READ_TIMEOUT') {
        bumpSkipReason(taskDiag.skipReasons, 'task_read_timeout');
      } else {
        bumpSkipReason(taskDiag.skipReasons, 'task_parse_failed');
      }
    }
  }
  return { tasks, taskDiag };
}

function mergeTaskDiag(target: GetAllTasksDiag, source: TaskReadDiag): void {
  target.skipped += source.skipped;
  for (const [reason, count] of Object.entries(source.skipReasons)) {
    target.skipReasons[reason] = (target.skipReasons[reason] || 0) + count;
  }
}

async function getAllTasks(
  payload: GetAllTasksPayload
): Promise<{ tasks: unknown[]; diag: GetAllTasksDiag }> {
  const startedAt = nowMs();
  const diag: GetAllTasksDiag = {
    op: 'getAllTasks',
    startedAt,
    tasksBase: payload.tasksBase,
    teamDirs: 0,
    returned: 0,
    skipped: 0,
    skipReasons: {},
    slowestTeams: [],
    totalMs: 0,
  };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(payload.tasksBase, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      diag.totalMs = nowMs() - startedAt;
      return { tasks: [], diag };
    }
    throw error;
  }

  const dirs = entries.filter((e) => e.isDirectory());
  diag.teamDirs = dirs.length;

  const chunks = await mapLimit(dirs, payload.concurrency, async (entry) => {
    const teamName = entry.name;
    const t0 = nowMs();
    try {
      const tasksDir = path.join(payload.tasksBase, teamName);
      const { tasks, taskDiag } = await readTasksDirForTeam(tasksDir, teamName, payload);
      mergeTaskDiag(diag, taskDiag);
      const ms = nowMs() - t0;
      if (ms >= 250) {
        pushSlowest(diag.slowestTeams, { teamName, ms }, 10);
      }
      return tasks;
    } catch {
      diag.skipped++;
      bumpSkipReason(diag.skipReasons, 'team_dir_failed');
      return [];
    }
  });

  const tasks = chunks.flat();
  diag.returned = tasks.length;
  diag.totalMs = nowMs() - startedAt;
  return { tasks, diag };
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

function post(msg: WorkerResponse): void {
  parentPort?.postMessage(msg);
}

parentPort?.on('message', async (msg: WorkerRequest) => {
  const { id, op } = msg;
  try {
    if (op === 'listTeams') {
      const { teams, diag } = await listTeams(msg.payload);
      post({ id, ok: true, result: teams, diag });
      return;
    }
    if (op === 'getAllTasks') {
      const { tasks, diag } = await getAllTasks(msg.payload);
      post({ id, ok: true, result: tasks, diag });
      return;
    }
    post({ id, ok: false, error: `Unknown op: ${String(op)}` });
  } catch (error) {
    post({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
