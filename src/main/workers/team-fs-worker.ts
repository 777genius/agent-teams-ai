import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort } from 'node:worker_threads';

import { estimateCachedValueBytes } from '@main/services/team/cacheMemoryEstimate';
import { readBootstrapLaunchSnapshot } from '@main/services/team/TeamBootstrapStateReader';
import { normalizePersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import {
  choosePreferredLaunchStateSummary,
  normalizePersistedLaunchSummaryProjection,
  shouldSuppressLegacyLaunchArtifactHeuristic,
  TEAM_LAUNCH_SUMMARY_FILE,
} from '@main/services/team/TeamLaunchSummaryProjection';
import { compactTeamTaskForSnapshot } from '@main/services/team/teamTaskSnapshotCompaction';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { isLeadMember } from '@shared/utils/leadDetection';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';

import type { TeamTask } from '@shared/types';

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
  projectionCacheBase?: string;
  maxTaskBytes: number;
  maxTaskReadMs: number;
  concurrency: number;
}

type WorkerRequest =
  | { id: string; op: 'warmup'; payload?: Record<string, never> }
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

function compactWorkerTaskProjection<T extends Record<string, unknown>>(task: T): T {
  return compactTeamTaskForSnapshot(task as unknown as TeamTask) as unknown as T;
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
  cacheHits: number;
  cacheMisses: number;
  cacheWriteSkips: number;
  cacheEvictions: number;
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
  cacheHits: number;
  cacheMisses: number;
  cacheWriteSkips: number;
  cacheEvictions: number;
  persistentCacheHits: number;
  persistentCacheMisses: number;
  persistentCacheLoads: number;
  persistentCacheWrites: number;
  persistentCacheReadFailures: number;
  persistentCacheWriteFailures: number;
  totalMs: number;
}

interface TaskReadDiag {
  skipped: number;
  skipReasons: Record<string, number>;
  cacheHits: number;
  cacheMisses: number;
  cacheWriteSkips: number;
  persistentCacheHits: number;
  persistentCacheMisses: number;
  persistentCacheLoads: number;
  persistentCacheWrites: number;
  persistentCacheReadFailures: number;
  persistentCacheWriteFailures: number;
}

const MAX_LAUNCH_STATE_BYTES = 32 * 1024;
const TEAM_LAUNCH_STATE_FILE = 'launch-state.json';
const REVIEW_LIFECYCLE_EVENTS = new Set([
  'review_requested',
  'review_changes_requested',
  'review_approved',
  'review_started',
]);
const REVIEW_RESET_STATUSES = new Set(['in_progress', 'deleted']);
const TEAM_SUMMARY_CACHE_MAX_ENTRIES = 1000;
const TASK_FILE_CACHE_MAX_ENTRIES = 512;
const TASK_FILE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const TASK_FILE_CACHE_MAX_ENTRY_BYTES = 3 * 1024 * 1024;
const PERSISTENT_TASK_PROJECTION_CACHE_VERSION = 1;
const PERSISTENT_TASK_PROJECTION_CACHE_DIR = 'v1';
const MAX_PERSISTENT_TASK_PROJECTION_CACHE_BYTES = 16 * 1024 * 1024;
const CACHEABLE_TASK_SKIP_REASONS = new Set(['task_internal', 'task_deleted']);
const BOOTSTRAP_STATE_FILE = 'bootstrap-state.json';
const BOOTSTRAP_JOURNAL_FILE = 'bootstrap-journal.jsonl';

interface PathFingerprint {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  highResolution?: boolean;
  size?: string;
  mode?: string;
  dev?: string;
  ino?: string;
  mtimeNs?: string;
  ctimeNs?: string;
  birthtimeNs?: string;
  mtimeMs?: number;
  ctimeMs?: number;
  birthtimeMs?: number;
  errorCode?: string;
}

interface TeamSummaryCacheEntry {
  fingerprint: string;
  summary: Record<string, unknown>;
  teamsDir: string;
  optionKey: string;
  lastUsedAt: number;
}

type CachedTaskReadResult =
  | { task: Record<string, unknown>; skipReason?: never }
  | { task?: never; skipReason: string };

interface TaskFileCacheEntry {
  fingerprint: string;
  result: CachedTaskReadResult;
  tasksBase: string;
  lastUsedAt: number;
  estimatedBytes: number;
}

interface PersistentTaskProjectionCacheEntry {
  fingerprint: string;
  result: CachedTaskReadResult;
}

const teamSummaryCache = new Map<string, TeamSummaryCacheEntry>();
const taskFileCache = new Map<string, TaskFileCacheEntry>();
let taskFileCacheBytes = 0;

interface TeamSummaryDependencyFingerprint {
  value: string;
  cacheSafe: boolean;
}

interface LaunchStateSummaryRead {
  summary: ReturnType<typeof choosePreferredLaunchStateSummary> | null;
  cacheable: boolean;
}

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
  cwd?: unknown;
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
  reviewIntervals?: unknown;
  historyEvents?: unknown;
  attachments?: unknown;
  sourceMessageId?: unknown;
  sourceMessage?: unknown;
}

interface RawWorkInterval {
  startedAt?: unknown;
  completedAt?: unknown;
}

interface RawReviewInterval {
  reviewer?: unknown;
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

function cloneCached<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

function dateFromFingerprintMs(ms: unknown): Date | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function statPathFingerprint(filePath: string): Promise<PathFingerprint> {
  try {
    const stat = await fs.promises.stat(filePath, { bigint: true });
    const mtimeNs =
      typeof (stat as fs.BigIntStats & { mtimeNs?: bigint }).mtimeNs === 'bigint'
        ? (stat as fs.BigIntStats & { mtimeNs: bigint }).mtimeNs
        : undefined;
    const ctimeNs =
      typeof (stat as fs.BigIntStats & { ctimeNs?: bigint }).ctimeNs === 'bigint'
        ? (stat as fs.BigIntStats & { ctimeNs: bigint }).ctimeNs
        : undefined;
    const birthtimeNs =
      typeof (stat as fs.BigIntStats & { birthtimeNs?: bigint }).birthtimeNs === 'bigint'
        ? (stat as fs.BigIntStats & { birthtimeNs: bigint }).birthtimeNs
        : undefined;
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      highResolution: typeof mtimeNs === 'bigint' && typeof ctimeNs === 'bigint',
      size: stat.size.toString(),
      mode: stat.mode.toString(),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      mtimeNs: mtimeNs?.toString(),
      ctimeNs: ctimeNs?.toString(),
      birthtimeNs: birthtimeNs?.toString(),
      mtimeMs: Number(stat.mtimeMs),
      ctimeMs: Number(stat.ctimeMs),
      birthtimeMs: Number(stat.birthtimeMs),
    };
  } catch (error) {
    return {
      exists: false,
      errorCode:
        typeof (error as NodeJS.ErrnoException | undefined)?.code === 'string'
          ? (error as NodeJS.ErrnoException).code
          : undefined,
    };
  }
}

function fingerprintToString(value: unknown): string {
  return JSON.stringify(value);
}

function isCacheSafeFingerprint(fingerprint: PathFingerprint): boolean {
  if (fingerprint.exists) {
    return fingerprint.highResolution === true;
  }
  return fingerprint.errorCode === 'ENOENT' || fingerprint.errorCode === 'ENOTDIR';
}

function makeTeamSummaryOptionKey(payload: ListTeamsPayload): string {
  return fingerprintToString({
    largeConfigBytes: payload.largeConfigBytes,
    configHeadBytes: payload.configHeadBytes,
    maxConfigBytes: payload.maxConfigBytes,
    maxConfigReadMs: payload.maxConfigReadMs,
    maxMembersMetaBytes: payload.maxMembersMetaBytes,
    maxSessionHistoryInSummary: payload.maxSessionHistoryInSummary,
    maxProjectPathHistoryInSummary: payload.maxProjectPathHistoryInSummary,
  });
}

function makeTeamSummaryCacheKey(teamsDir: string, teamName: string, optionKey: string): string {
  return `${teamsDir}\0${teamName}\0${optionKey}`;
}

function canCacheTeamSummary(summary: Record<string, unknown>): boolean {
  if (summary.teamLaunchState === 'partial_pending') {
    return false;
  }
  const pendingKeys = [
    'pendingCount',
    'runtimeAlivePendingCount',
    'shellOnlyPendingCount',
    'runtimeProcessPendingCount',
    'runtimeCandidatePendingCount',
    'noRuntimePendingCount',
    'permissionPendingCount',
  ];
  return pendingKeys.every((key) => {
    const value = summary[key];
    return typeof value !== 'number' || value <= 0;
  });
}

async function readInboxNamesFingerprint(inboxDir: string): Promise<{
  dir: PathFingerprint;
  names: string[];
  cacheSafe: boolean;
}> {
  const dir = await statPathFingerprint(inboxDir);
  if (!dir.exists || !dir.isDirectory) {
    return { dir, names: [], cacheSafe: isCacheSafeFingerprint(dir) };
  }
  try {
    const entries = await fs.promises.readdir(inboxDir, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    return { dir, names, cacheSafe: isCacheSafeFingerprint(dir) };
  } catch (error) {
    return {
      dir: {
        ...dir,
        errorCode:
          typeof (error as NodeJS.ErrnoException | undefined)?.code === 'string'
            ? (error as NodeJS.ErrnoException).code
            : 'READDIR_FAILED',
      },
      names: [],
      cacheSafe: false,
    };
  }
}

async function buildTeamSummaryFingerprint(
  teamsDir: string,
  teamName: string,
  optionKey: string
): Promise<TeamSummaryDependencyFingerprint> {
  const teamDir = path.join(teamsDir, teamName);
  const [
    config,
    teamMeta,
    membersMeta,
    launchState,
    launchSummary,
    bootstrapState,
    bootstrapJournal,
  ] = await Promise.all([
    statPathFingerprint(path.join(teamDir, 'config.json')),
    statPathFingerprint(path.join(teamDir, 'team.meta.json')),
    statPathFingerprint(path.join(teamDir, 'members.meta.json')),
    statPathFingerprint(path.join(teamDir, TEAM_LAUNCH_STATE_FILE)),
    statPathFingerprint(path.join(teamDir, TEAM_LAUNCH_SUMMARY_FILE)),
    statPathFingerprint(path.join(teamDir, BOOTSTRAP_STATE_FILE)),
    statPathFingerprint(path.join(teamDir, BOOTSTRAP_JOURNAL_FILE)),
  ]);
  const inbox = await readInboxNamesFingerprint(path.join(teamDir, 'inboxes'));

  const dependencyFingerprint = {
    version: 1,
    optionKey,
    config,
    teamMeta,
    membersMeta,
    launchState,
    launchSummary,
    bootstrapState,
    bootstrapJournal,
    inbox,
  };

  return {
    value: fingerprintToString(dependencyFingerprint),
    cacheSafe:
      [
        config,
        teamMeta,
        membersMeta,
        launchState,
        launchSummary,
        bootstrapState,
        bootstrapJournal,
      ].every(isCacheSafeFingerprint) && inbox.cacheSafe,
  };
}

async function cacheTeamSummaryIfStable(
  cacheKey: string,
  teamsDir: string,
  teamName: string,
  optionKey: string,
  fingerprintBefore: TeamSummaryDependencyFingerprint,
  summary: Record<string, unknown>,
  cacheAllowed: boolean,
  diag: ListTeamsDiag
): Promise<void> {
  if (!cacheAllowed) {
    teamSummaryCache.delete(cacheKey);
    diag.cacheWriteSkips++;
    return;
  }
  if (!canCacheTeamSummary(summary)) {
    teamSummaryCache.delete(cacheKey);
    diag.cacheWriteSkips++;
    return;
  }
  if (!fingerprintBefore.cacheSafe) {
    diag.cacheWriteSkips++;
    return;
  }
  const fingerprintAfter = await buildTeamSummaryFingerprint(teamsDir, teamName, optionKey);
  if (!fingerprintAfter.cacheSafe || fingerprintAfter.value !== fingerprintBefore.value) {
    diag.cacheWriteSkips++;
    return;
  }
  teamSummaryCache.set(cacheKey, {
    fingerprint: fingerprintAfter.value,
    summary: cloneCached(summary),
    teamsDir,
    optionKey,
    lastUsedAt: nowMs(),
  });
}

function pruneTeamSummaryCache(
  teamsDir: string,
  optionKey: string,
  liveTeamNames: ReadonlySet<string>,
  diag: ListTeamsDiag
): void {
  for (const [key, entry] of teamSummaryCache) {
    if (entry.teamsDir === teamsDir && entry.optionKey === optionKey) {
      const teamName = key.split('\0')[1] ?? '';
      if (!liveTeamNames.has(teamName)) {
        teamSummaryCache.delete(key);
        diag.cacheEvictions++;
      }
    }
  }
  while (teamSummaryCache.size > TEAM_SUMMARY_CACHE_MAX_ENTRIES) {
    const oldest = teamSummaryCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    teamSummaryCache.delete(oldest);
    diag.cacheEvictions++;
  }
}

function makeTaskOptionKey(payload: GetAllTasksPayload): string {
  return fingerprintToString({
    maxTaskBytes: payload.maxTaskBytes,
    maxTaskReadMs: payload.maxTaskReadMs,
  });
}

function makeTaskCacheKey(
  tasksBase: string,
  teamName: string,
  fileName: string,
  optionKey: string
): string {
  return `${tasksBase}\0${teamName}\0${fileName}\0${optionKey}`;
}

function deleteTaskFileCacheEntry(
  cacheKey: string,
  diag?: Pick<GetAllTasksDiag, 'cacheEvictions'>
): void {
  const cached = taskFileCache.get(cacheKey);
  if (!cached) {
    return;
  }
  taskFileCacheBytes = Math.max(0, taskFileCacheBytes - cached.estimatedBytes);
  taskFileCache.delete(cacheKey);
  if (diag) {
    diag.cacheEvictions++;
  }
}

function evictOldestTaskFileCacheEntry(diag?: Pick<GetAllTasksDiag, 'cacheEvictions'>): boolean {
  const oldest = taskFileCache.keys().next().value;
  if (typeof oldest !== 'string') {
    return false;
  }
  deleteTaskFileCacheEntry(oldest, diag);
  return true;
}

function trimTaskFileCache(diag?: Pick<GetAllTasksDiag, 'cacheEvictions'>): void {
  while (
    taskFileCache.size > TASK_FILE_CACHE_MAX_ENTRIES ||
    taskFileCacheBytes > TASK_FILE_CACHE_MAX_BYTES
  ) {
    if (!evictOldestTaskFileCacheEntry(diag)) {
      return;
    }
  }
}

function setTaskFileCacheEntry(
  cacheKey: string,
  entry: Omit<TaskFileCacheEntry, 'estimatedBytes'>,
  taskDiag: Pick<TaskReadDiag, 'cacheWriteSkips'>,
  diag?: Pick<GetAllTasksDiag, 'cacheEvictions'>
): boolean {
  const estimatedBytes = estimateCachedValueBytes(entry.result);
  deleteTaskFileCacheEntry(cacheKey);
  if (estimatedBytes > TASK_FILE_CACHE_MAX_ENTRY_BYTES) {
    taskDiag.cacheWriteSkips++;
    return false;
  }
  taskFileCache.set(cacheKey, {
    ...entry,
    estimatedBytes,
  });
  taskFileCacheBytes += estimatedBytes;
  trimTaskFileCache(diag);
  return true;
}

async function cacheTaskReadResultIfStable(
  cacheKey: string,
  taskPath: string,
  tasksBase: string,
  fingerprintBefore: string,
  fingerprintBeforeCacheSafe: boolean,
  result: CachedTaskReadResult,
  taskDiag: TaskReadDiag
): Promise<boolean> {
  if (!fingerprintBeforeCacheSafe) {
    taskDiag.cacheWriteSkips++;
    return false;
  }
  const after = await statPathFingerprint(taskPath);
  if (!isCacheSafeFingerprint(after) || fingerprintToString(after) !== fingerprintBefore) {
    taskDiag.cacheWriteSkips++;
    return false;
  }
  return setTaskFileCacheEntry(
    cacheKey,
    {
      fingerprint: fingerprintBefore,
      result: cloneCached(result),
      tasksBase,
      lastUsedAt: nowMs(),
    },
    taskDiag
  );
}

function applyCachedTaskReadResult(
  cached: CachedTaskReadResult,
  tasks: unknown[],
  taskDiag: TaskReadDiag
): void {
  if (cached.skipReason) {
    taskDiag.skipped++;
    bumpSkipReason(taskDiag.skipReasons, cached.skipReason);
    return;
  }
  tasks.push(cached.task);
}

function pruneTaskFileCache(
  tasksBase: string,
  liveCacheKeys: ReadonlySet<string>,
  diag: GetAllTasksDiag
): void {
  for (const [key, entry] of taskFileCache) {
    if (entry.tasksBase === tasksBase && !liveCacheKeys.has(key)) {
      deleteTaskFileCacheEntry(key, diag);
    }
  }
  trimTaskFileCache(diag);
}

function getPersistentTaskProjectionCachePath(
  payload: GetAllTasksPayload,
  teamName: string
): string | null {
  const base = typeof payload.projectionCacheBase === 'string' ? payload.projectionCacheBase : '';
  if (!base.trim()) return null;
  const digest = createHash('sha256')
    .update(payload.tasksBase)
    .update('\0')
    .update(teamName)
    .digest('hex');
  return path.join(base, PERSISTENT_TASK_PROJECTION_CACHE_DIR, `${digest}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeTaskProjectionFileName(file: string): boolean {
  return (
    file.endsWith('.json') &&
    !file.startsWith('.') &&
    !file.includes('/') &&
    !file.includes('\\') &&
    file !== '.lock' &&
    file !== '.highwatermark'
  );
}

function normalizePersistentTaskReadResult(
  value: unknown,
  teamName: string
): CachedTaskReadResult | null {
  if (!isRecord(value)) return null;

  const skipReason = value.skipReason;
  if (typeof skipReason === 'string') {
    return CACHEABLE_TASK_SKIP_REASONS.has(skipReason) ? { skipReason } : null;
  }

  const task = value.task;
  if (!isRecord(task)) return null;
  if (task.teamName !== teamName) return null;
  if (typeof task.id !== 'string') return null;
  if (typeof task.subject !== 'string') return null;
  const status =
    task.status === 'pending' ||
    task.status === 'in_progress' ||
    task.status === 'completed' ||
    task.status === 'deleted'
      ? task.status
      : null;
  if (!status) return null;
  if (status === 'deleted') return null;

  return { task: restorePersistentTaskProjectionShape(task, teamName, status) };
}

function restorePersistentTaskProjectionShape(
  task: Record<string, unknown>,
  teamName: string,
  status: string
): Record<string, unknown> {
  const id = typeof task.id === 'string' ? task.id : '';
  const subject = typeof task.subject === 'string' ? task.subject : '';
  const displayId = task.displayId;
  const reviewState = normalizeFallbackReviewState(task.reviewState, status);
  return compactWorkerTaskProjection({
    id,
    displayId:
      typeof displayId === 'string' && displayId.trim().length > 0
        ? displayId.trim()
        : deriveTaskDisplayId(id),
    subject,
    description: typeof task.description === 'string' ? task.description : undefined,
    descriptionTaskRefs: Array.isArray(task.descriptionTaskRefs)
      ? task.descriptionTaskRefs
      : undefined,
    activeForm: typeof task.activeForm === 'string' ? task.activeForm : undefined,
    prompt: typeof task.prompt === 'string' ? task.prompt : undefined,
    promptTaskRefs: Array.isArray(task.promptTaskRefs) ? task.promptTaskRefs : undefined,
    owner: typeof task.owner === 'string' ? task.owner : undefined,
    createdBy: typeof task.createdBy === 'string' ? task.createdBy : undefined,
    status,
    workIntervals: normalizeWorkIntervals(task),
    reviewIntervals: normalizeReviewIntervals(task),
    historyEvents: normalizeHistoryEvents(task),
    blocks: Array.isArray(task.blocks) ? task.blocks : undefined,
    blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : undefined,
    related: Array.isArray(task.related)
      ? (task.related as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined,
    createdAt: typeof task.createdAt === 'string' ? task.createdAt : undefined,
    updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : undefined,
    projectPath: typeof task.projectPath === 'string' ? task.projectPath : undefined,
    comments: normalizeComments(task),
    needsClarification:
      task.needsClarification === 'lead' || task.needsClarification === 'user'
        ? task.needsClarification
        : undefined,
    reviewState,
    deletedAt: undefined,
    attachments: Array.isArray(task.attachments) ? task.attachments : undefined,
    sourceMessageId:
      typeof task.sourceMessageId === 'string' && task.sourceMessageId.trim()
        ? task.sourceMessageId.trim()
        : undefined,
    sourceMessage:
      isRecord(task.sourceMessage) &&
      typeof task.sourceMessage.text === 'string' &&
      typeof task.sourceMessage.from === 'string' &&
      typeof task.sourceMessage.timestamp === 'string'
        ? task.sourceMessage
        : undefined,
    teamName,
  });
}

function normalizePersistentTaskProjectionEntry(
  value: unknown,
  teamName: string
): PersistentTaskProjectionCacheEntry | null {
  if (!isRecord(value) || typeof value.fingerprint !== 'string') return null;
  const result = normalizePersistentTaskReadResult(value.result, teamName);
  return result ? { fingerprint: value.fingerprint, result } : null;
}

async function readPersistentTaskProjectionCache(
  payload: GetAllTasksPayload,
  teamName: string,
  optionKey: string,
  taskDiag: TaskReadDiag
): Promise<Map<string, PersistentTaskProjectionCacheEntry> | null> {
  const cachePath = getPersistentTaskProjectionCachePath(payload, teamName);
  if (!cachePath) return null;

  try {
    const stat = await fs.promises.stat(cachePath);
    if (!stat.isFile() || stat.size > MAX_PERSISTENT_TASK_PROJECTION_CACHE_BYTES) {
      taskDiag.persistentCacheReadFailures++;
      await fs.promises.rm(cachePath, { force: true }).catch(() => undefined);
      return null;
    }
    const raw = await fs.promises.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      taskDiag.persistentCacheReadFailures++;
      await fs.promises.rm(cachePath, { force: true }).catch(() => undefined);
      return null;
    }
    if (
      parsed.version !== PERSISTENT_TASK_PROJECTION_CACHE_VERSION ||
      parsed.tasksBase !== payload.tasksBase ||
      parsed.teamName !== teamName ||
      parsed.optionKey !== optionKey
    ) {
      taskDiag.persistentCacheMisses++;
      await fs.promises.rm(cachePath, { force: true }).catch(() => undefined);
      return null;
    }
    if (!isRecord(parsed.entries)) {
      taskDiag.persistentCacheReadFailures++;
      await fs.promises.rm(cachePath, { force: true }).catch(() => undefined);
      return null;
    }

    const entries = new Map<string, PersistentTaskProjectionCacheEntry>();
    for (const [file, entry] of Object.entries(parsed.entries)) {
      if (!isSafeTaskProjectionFileName(file)) continue;
      const normalized = normalizePersistentTaskProjectionEntry(entry, teamName);
      if (normalized) {
        entries.set(file, normalized);
      }
    }
    taskDiag.persistentCacheLoads++;
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null;
    }
    taskDiag.persistentCacheReadFailures++;
    await fs.promises.rm(cachePath, { force: true }).catch(() => undefined);
    return null;
  }
}

function shouldWritePersistentTaskProjectionCache(
  previous: ReadonlyMap<string, PersistentTaskProjectionCacheEntry> | null,
  next: ReadonlyMap<string, PersistentTaskProjectionCacheEntry>,
  taskDiag: TaskReadDiag
): boolean {
  if (next.size === 0) return false;
  if (!previous) return true;
  if (previous.size !== next.size) return true;
  return taskDiag.persistentCacheMisses > 0 || taskDiag.cacheMisses > 0;
}

async function writePersistentTaskProjectionCache(
  payload: GetAllTasksPayload,
  teamName: string,
  optionKey: string,
  entries: ReadonlyMap<string, PersistentTaskProjectionCacheEntry>,
  taskDiag: TaskReadDiag
): Promise<void> {
  const cachePath = getPersistentTaskProjectionCachePath(payload, teamName);
  if (!cachePath || entries.size === 0) return;

  const body = {
    version: PERSISTENT_TASK_PROJECTION_CACHE_VERSION,
    tasksBase: payload.tasksBase,
    teamName,
    optionKey,
    writtenAt: nowMs(),
    entries: Object.fromEntries(entries),
  };
  const raw = JSON.stringify(body);
  if (Buffer.byteLength(raw, 'utf8') > MAX_PERSISTENT_TASK_PROJECTION_CACHE_BYTES) {
    taskDiag.persistentCacheWriteFailures++;
    await fs.promises.rm(cachePath, { force: true }).catch(() => undefined);
    return;
  }
  try {
    await atomicWriteAsync(cachePath, raw);
    taskDiag.persistentCacheWrites++;
  } catch {
    taskDiag.persistentCacheWriteFailures++;
  }
}

// ---------------------------------------------------------------------------
// listTeams
// ---------------------------------------------------------------------------

function isRawMember(v: unknown): v is RawMember {
  return !!v && typeof v === 'object';
}

function normalizeProjectPathCandidate(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getRawConfigMembers(config: Pick<ParsedConfig, 'members'>): RawMember[] {
  if (!Array.isArray(config.members)) {
    return [];
  }
  return config.members.filter(isRawMember);
}

function resolveProjectPathFromConfig(
  config: Pick<ParsedConfig, 'projectPath' | 'projectPathHistory' | 'members'>
): string | undefined {
  const direct = normalizeProjectPathCandidate(config.projectPath);
  if (direct) {
    return direct;
  }

  const members = getRawConfigMembers(config);
  const leadMemberCwd = members.find((member) => isLeadMember(member))?.cwd;
  const leadResolved = normalizeProjectPathCandidate(leadMemberCwd);
  if (leadResolved) {
    return leadResolved;
  }

  const distinctMemberCwds = Array.from(
    new Set(
      members
        .map((member) => normalizeProjectPathCandidate(member.cwd))
        .filter((cwd): cwd is string => Boolean(cwd))
    )
  );
  if (distinctMemberCwds.length === 1) {
    return distinctMemberCwds[0];
  }

  if (Array.isArray(config.projectPathHistory)) {
    for (let i = config.projectPathHistory.length - 1; i >= 0; i -= 1) {
      const historyValue = normalizeProjectPathCandidate(config.projectPathHistory[i]);
      if (historyValue) {
        return historyValue;
      }
    }
  }

  return undefined;
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
): Promise<LaunchStateSummaryRead> {
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

  const summary = choosePreferredLaunchStateSummary({
    bootstrapSnapshot,
    launchSnapshot,
    launchSummaryProjection,
  });
  if (launchSnapshot) {
    return { summary, cacheable: true };
  }
  if (!bootstrapSnapshot) {
    return { summary, cacheable: true };
  }
  if (
    bootstrapSnapshot.launchPhase === 'finished' &&
    bootstrapSnapshot.teamLaunchState !== 'partial_pending'
  ) {
    return { summary, cacheable: true };
  }
  return { summary, cacheable: false };
}

/**
 * Reads a draft team summary from team.meta.json when config.json is missing.
 * Returns null if team.meta.json doesn't exist or is invalid.
 */
async function readDraftTeamMeta(
  teamsDir: string,
  teamName: string,
  options: { maxConfigReadMs: number; maxMembersMetaBytes: number }
): Promise<Record<string, unknown> | null> {
  const metaPath = path.join(teamsDir, teamName, 'team.meta.json');
  try {
    const stat = await fs.promises.stat(metaPath);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const raw = await readFileUtf8WithTimeout(metaPath, options.maxConfigReadMs);
    const meta = JSON.parse(raw) as Record<string, unknown>;
    if (meta?.version !== 1 || typeof meta?.cwd !== 'string') return null;

    const displayName =
      typeof meta.displayName === 'string' && meta.displayName.trim()
        ? meta.displayName.trim()
        : teamName;

    // Read members.meta.json for member count
    let memberCount = 0;
    let leadName: string | undefined;
    let leadColor: string | undefined;
    try {
      const membersPath = path.join(teamsDir, teamName, 'members.meta.json');
      const membersStat = await fs.promises.stat(membersPath);
      if (!membersStat.isFile() || membersStat.size > options.maxMembersMetaBytes) {
        throw new Error('members_meta_too_large');
      }
      const membersRaw = await readFileUtf8WithTimeout(membersPath, options.maxConfigReadMs);
      const membersData = JSON.parse(membersRaw) as { members?: unknown[] };
      if (Array.isArray(membersData?.members)) {
        memberCount = membersData.members.filter((member) => {
          if (!isRawMember(member)) return false;
          const name = typeof member.name === 'string' ? member.name.trim() : '';
          if (!member.removedAt && isLeadMember(member)) {
            if (name) {
              leadName = name;
            }
            const color = typeof member.color === 'string' ? member.color.trim() : '';
            if (color) {
              leadColor = color;
            }
          }
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
      ...(leadName ? { leadName } : {}),
      ...(leadColor ? { leadColor } : {}),
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
    cacheHits: 0,
    cacheMisses: 0,
    cacheWriteSkips: 0,
    cacheEvictions: 0,
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
  const optionKey = makeTeamSummaryOptionKey(payload);
  const liveTeamNames = new Set(teamDirs.map((entry) => entry.name));

  const perTeam = await mapLimit(teamDirs, payload.concurrency, async (entry) => {
    const teamName = entry.name;
    const t0 = nowMs();
    const configPath = path.join(payload.teamsDir, teamName, 'config.json');
    const cacheKey = makeTeamSummaryCacheKey(payload.teamsDir, teamName, optionKey);
    const dependencyFingerprint = await buildTeamSummaryFingerprint(
      payload.teamsDir,
      teamName,
      optionKey
    );
    const cached = teamSummaryCache.get(cacheKey);
    if (dependencyFingerprint.cacheSafe && cached?.fingerprint === dependencyFingerprint.value) {
      cached.lastUsedAt = nowMs();
      diag.cacheHits++;
      return cached.summary;
    }
    diag.cacheMisses++;

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
      const draft = await readDraftTeamMeta(payload.teamsDir, teamName, payload);
      if (draft) {
        await cacheTeamSummaryIfStable(
          cacheKey,
          payload.teamsDir,
          teamName,
          optionKey,
          dependencyFingerprint,
          draft,
          true,
          diag
        );
        return draft;
      }
      return skip('config_stat_failed');
    }
    if (!stat.isFile()) {
      const draft = await readDraftTeamMeta(payload.teamsDir, teamName, payload);
      if (draft) {
        await cacheTeamSummaryIfStable(
          cacheKey,
          payload.teamsDir,
          teamName,
          optionKey,
          dependencyFingerprint,
          draft,
          true,
          diag
        );
        return draft;
      }
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
        projectPath = resolveProjectPathFromConfig(config);
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
    const metaRuntimeMembers: {
      name: string;
      providerId?: 'anthropic' | 'codex' | 'gemini' | 'opencode';
      removedAt?: unknown;
    }[] = [];
    let leadProviderId: 'anthropic' | 'codex' | 'gemini' | 'opencode' | undefined;
    let leadName: string | undefined;
    let leadColor: string | undefined;

    const captureLeadMember = (member: RawMember, overwrite = false): void => {
      if (member.removedAt) return;
      if (!isLeadMember(member)) return;
      const name = typeof member.name === 'string' ? member.name.trim() : '';
      if (name && (overwrite || !leadName)) {
        leadName = name;
      }
      const colorValue = typeof member.color === 'string' ? member.color.trim() : '';
      if (colorValue && (overwrite || !leadColor)) {
        leadColor = colorValue;
      }
    };

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
          captureLeadMember(member);
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
          captureLeadMember(member, true);
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
    const launchStateRead = await readLaunchState(payload.teamsDir, teamName);
    const fallbackLaunchStateSummary = (): ReturnType<typeof choosePreferredLaunchStateSummary> => {
      if (suppressLegacyLaunchArtifactHeuristic) {
        return null;
      }
      if (!leadSessionId || expectedTeammateNames.size === 0 || confirmedArtifactNames.size === 0) {
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
    };
    const launchStateSummary = launchStateRead.summary ?? fallbackLaunchStateSummary();
    const summary = {
      teamName,
      displayName,
      description,
      memberCount: memberMap.size,
      taskCount: 0,
      lastActivity: null,
      ...(coloredMembers.length > 0 ? { members: coloredMembers } : {}),
      ...(leadName ? { leadName } : {}),
      ...(leadColor ? { leadColor } : {}),
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
    await cacheTeamSummaryIfStable(
      cacheKey,
      payload.teamsDir,
      teamName,
      optionKey,
      dependencyFingerprint,
      summary,
      launchStateRead.cacheable,
      diag
    );
    return summary;
  });

  const teams = perTeam.filter((t): t is NonNullable<typeof t> => t !== null);
  pruneTeamSummaryCache(payload.teamsDir, optionKey, liveTeamNames, diag);
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

function normalizeReviewIntervals(
  parsed: ParsedTask
): { reviewer: string; startedAt: string; completedAt?: string }[] | undefined {
  if (!Array.isArray(parsed.reviewIntervals)) return undefined;
  return (parsed.reviewIntervals as unknown[])
    .filter(
      (i): i is RawReviewInterval =>
        Boolean(i) &&
        typeof i === 'object' &&
        typeof (i as RawReviewInterval).reviewer === 'string' &&
        typeof (i as RawReviewInterval).startedAt === 'string' &&
        ((i as RawReviewInterval).completedAt === undefined ||
          typeof (i as RawReviewInterval).completedAt === 'string')
    )
    .map((i) => ({
      reviewer: i.reviewer as string,
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

function normalizeReviewState(value: unknown): string {
  return value === 'review' || value === 'needsFix' || value === 'approved' ? value : 'none';
}

function normalizeFallbackReviewState(value: unknown, status: string): string {
  const reviewState = normalizeReviewState(value);
  if (reviewState === 'none') return 'none';
  if (status === 'in_progress' || status === 'deleted') return 'none';
  if (status === 'pending') return reviewState === 'needsFix' ? 'needsFix' : 'none';
  if (status === 'completed') {
    return reviewState === 'review' || reviewState === 'approved' || reviewState === 'needsFix'
      ? reviewState
      : 'none';
  }
  return reviewState;
}

function eventReviewState(event: RawHistoryEvent): string | null {
  const type = typeof event.type === 'string' ? event.type : '';
  if (!REVIEW_LIFECYCLE_EVENTS.has(type)) {
    return null;
  }
  return normalizeReviewState(event.to);
}

function derivePendingReviewState(events: RawHistoryEvent[], startIndex: number): string {
  for (let i = startIndex - 1; i >= 0; i--) {
    const previous = events[i];
    const reviewState = eventReviewState(previous);
    if (reviewState) {
      return reviewState === 'needsFix' ? 'needsFix' : 'none';
    }
    if (
      previous.type === 'task_created' ||
      (previous.type === 'status_changed' &&
        (REVIEW_RESET_STATUSES.has(String(previous.to || '')) || previous.to === 'pending'))
    ) {
      return 'none';
    }
  }
  return 'none';
}

/** Derive review state from historyEvents (inline reducer for worker isolation). */
function deriveReviewStateFromEvents(events: RawHistoryEvent[] | undefined): string | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const reviewState = eventReviewState(e);
    if (reviewState) {
      return reviewState;
    }
    if (e.type === 'status_changed' && REVIEW_RESET_STATUSES.has(String(e.to || ''))) {
      return 'none';
    }
    if (e.type === 'status_changed' && e.to === 'pending') {
      return derivePendingReviewState(events, i);
    }
  }
  return null;
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
): Promise<{ tasks: unknown[]; taskDiag: TaskReadDiag; liveCacheKeys: Set<string> }> {
  const taskDiag: TaskReadDiag = {
    skipped: 0,
    skipReasons: {},
    cacheHits: 0,
    cacheMisses: 0,
    cacheWriteSkips: 0,
    persistentCacheHits: 0,
    persistentCacheMisses: 0,
    persistentCacheLoads: 0,
    persistentCacheWrites: 0,
    persistentCacheReadFailures: 0,
    persistentCacheWriteFailures: 0,
  };
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tasksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { tasks: [], taskDiag, liveCacheKeys: new Set() };
    }
    throw error;
  }

  const tasks: unknown[] = [];
  const liveCacheKeys = new Set<string>();
  const optionKey = makeTaskOptionKey(payload);
  const persistentCache = await readPersistentTaskProjectionCache(
    payload,
    teamName,
    optionKey,
    taskDiag
  );
  const nextPersistentEntries = new Map<string, PersistentTaskProjectionCacheEntry>();
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
    const cacheKey = makeTaskCacheKey(payload.tasksBase, teamName, file, optionKey);
    liveCacheKeys.add(cacheKey);
    try {
      const pathFingerprint = await statPathFingerprint(taskPath);
      const taskSize = Number(pathFingerprint.size ?? Number.NaN);
      if (
        !pathFingerprint.isFile ||
        !Number.isFinite(taskSize) ||
        taskSize > payload.maxTaskBytes
      ) {
        taskDiag.skipped++;
        bumpSkipReason(taskDiag.skipReasons, 'task_not_file_or_large');
        continue;
      }
      const fingerprint = fingerprintToString(pathFingerprint);
      const fingerprintCacheSafe = isCacheSafeFingerprint(pathFingerprint);
      const cached = taskFileCache.get(cacheKey);
      if (fingerprintCacheSafe && cached?.fingerprint === fingerprint) {
        cached.lastUsedAt = nowMs();
        taskFileCache.delete(cacheKey);
        taskFileCache.set(cacheKey, cached);
        taskDiag.cacheHits++;
        applyCachedTaskReadResult(cached.result, tasks, taskDiag);
        nextPersistentEntries.set(file, {
          fingerprint,
          result: cloneCached(cached.result),
        });
        continue;
      }

      const persistentEntry = persistentCache?.get(file);
      if (fingerprintCacheSafe && persistentEntry?.fingerprint === fingerprint) {
        const result = cloneCached(persistentEntry.result);
        setTaskFileCacheEntry(
          cacheKey,
          {
            fingerprint,
            result: cloneCached(result),
            tasksBase: payload.tasksBase,
            lastUsedAt: nowMs(),
          },
          taskDiag
        );
        taskDiag.persistentCacheHits++;
        applyCachedTaskReadResult(result, tasks, taskDiag);
        nextPersistentEntries.set(file, {
          fingerprint,
          result: cloneCached(result),
        });
        continue;
      }
      if (persistentCache) {
        taskDiag.persistentCacheMisses++;
      }
      taskDiag.cacheMisses++;

      const raw = await readFileUtf8WithTimeout(taskPath, payload.maxTaskReadMs);
      const parsed = JSON.parse(raw) as ParsedTask;
      const metadata = parsed.metadata;
      if (metadata?._internal === true) {
        taskDiag.skipped++;
        bumpSkipReason(taskDiag.skipReasons, 'task_internal');
        const result: CachedTaskReadResult = { skipReason: 'task_internal' };
        const cachedStable = await cacheTaskReadResultIfStable(
          cacheKey,
          taskPath,
          payload.tasksBase,
          fingerprint,
          fingerprintCacheSafe,
          result,
          taskDiag
        );
        if (cachedStable) {
          nextPersistentEntries.set(file, {
            fingerprint,
            result: cloneCached(result),
          });
        }
        continue;
      }
      if (parsed.status === 'deleted') {
        taskDiag.skipped++;
        bumpSkipReason(taskDiag.skipReasons, 'task_deleted');
        const result: CachedTaskReadResult = { skipReason: 'task_deleted' };
        const cachedStable = await cacheTaskReadResultIfStable(
          cacheKey,
          taskPath,
          payload.tasksBase,
          fingerprint,
          fingerprintCacheSafe,
          result,
          taskDiag
        );
        if (cachedStable) {
          nextPersistentEntries.set(file, {
            fingerprint,
            result: cloneCached(result),
          });
        }
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
        const birthtime = dateFromFingerprintMs(pathFingerprint.birthtimeMs);
        const mtime = dateFromFingerprintMs(pathFingerprint.mtimeMs);
        if (!createdAt) {
          createdAt = (birthtime ?? mtime)?.toISOString();
        }
        updatedAt = mtime?.toISOString();
      } catch {
        /* ignore */
      }

      const needsClarification =
        parsed.needsClarification === 'lead' || parsed.needsClarification === 'user'
          ? (parsed.needsClarification as string)
          : undefined;
      const historyEvents = normalizeHistoryEvents(parsed);
      const status =
        parsed.status === 'pending' ||
        parsed.status === 'in_progress' ||
        parsed.status === 'completed' ||
        parsed.status === 'deleted'
          ? (parsed.status as string)
          : 'pending';
      const derivedReviewState = deriveReviewStateFromEvents(historyEvents);
      const reviewState =
        derivedReviewState !== null
          ? normalizeFallbackReviewState(derivedReviewState, status)
          : normalizeFallbackReviewState(parsed.reviewState, status);

      const task = compactWorkerTaskProjection({
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
        status,
        workIntervals: normalizeWorkIntervals(parsed),
        reviewIntervals: normalizeReviewIntervals(parsed),
        historyEvents,
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
      tasks.push(task);
      const result: CachedTaskReadResult = { task };
      const cachedStable = await cacheTaskReadResultIfStable(
        cacheKey,
        taskPath,
        payload.tasksBase,
        fingerprint,
        fingerprintCacheSafe,
        result,
        taskDiag
      );
      if (cachedStable) {
        nextPersistentEntries.set(file, {
          fingerprint,
          result: cloneCached(result),
        });
      }
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
  if (persistentCache && nextPersistentEntries.size === 0) {
    const cachePath = getPersistentTaskProjectionCachePath(payload, teamName);
    if (cachePath) {
      await fs.promises.rm(cachePath, { force: true }).catch(() => undefined);
    }
  } else if (
    shouldWritePersistentTaskProjectionCache(persistentCache, nextPersistentEntries, taskDiag)
  ) {
    await writePersistentTaskProjectionCache(
      payload,
      teamName,
      optionKey,
      nextPersistentEntries,
      taskDiag
    );
  }
  return { tasks, taskDiag, liveCacheKeys };
}

function mergeTaskDiag(target: GetAllTasksDiag, source: TaskReadDiag): void {
  target.skipped += source.skipped;
  target.cacheHits += source.cacheHits;
  target.cacheMisses += source.cacheMisses;
  target.cacheWriteSkips += source.cacheWriteSkips;
  target.persistentCacheHits += source.persistentCacheHits;
  target.persistentCacheMisses += source.persistentCacheMisses;
  target.persistentCacheLoads += source.persistentCacheLoads;
  target.persistentCacheWrites += source.persistentCacheWrites;
  target.persistentCacheReadFailures += source.persistentCacheReadFailures;
  target.persistentCacheWriteFailures += source.persistentCacheWriteFailures;
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
    cacheHits: 0,
    cacheMisses: 0,
    cacheWriteSkips: 0,
    cacheEvictions: 0,
    persistentCacheHits: 0,
    persistentCacheMisses: 0,
    persistentCacheLoads: 0,
    persistentCacheWrites: 0,
    persistentCacheReadFailures: 0,
    persistentCacheWriteFailures: 0,
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
  const liveCacheKeys = new Set<string>();

  const chunks = await mapLimit(dirs, payload.concurrency, async (entry) => {
    const teamName = entry.name;
    const t0 = nowMs();
    try {
      const tasksDir = path.join(payload.tasksBase, teamName);
      const {
        tasks,
        taskDiag,
        liveCacheKeys: teamLiveCacheKeys,
      } = await readTasksDirForTeam(tasksDir, teamName, payload);
      for (const key of teamLiveCacheKeys) {
        liveCacheKeys.add(key);
      }
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
  pruneTaskFileCache(payload.tasksBase, liveCacheKeys, diag);
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
    if (op === 'warmup') {
      post({
        id,
        ok: true,
        result: {
          ready: true,
          teamSummaryCacheEntries: teamSummaryCache.size,
          taskFileCacheEntries: taskFileCache.size,
        },
        diag: { op, totalMs: 0 },
      });
      return;
    }
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
