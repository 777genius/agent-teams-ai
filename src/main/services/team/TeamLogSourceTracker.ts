import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { watch } from 'chokidar';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  computeTaskChangePresenceProjectFingerprint,
  normalizeTaskChangePresenceFilePath,
} from './taskChangePresenceUtils';
import {
  BOARD_TASK_CHANGE_FRESHNESS_DIRNAME,
  BOARD_TASK_CHANGES_DIRNAME,
  BOARD_TASK_LOG_FRESHNESS_DIRNAME,
  BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX,
  classifyLogSourceWatcherEvent,
  getRelativeLogSourceParts,
  isAgentTranscriptFileName,
  MAX_PENDING_UNKNOWN_ROOT_REFRESH_ATTEMPTS,
  MAX_PENDING_UNKNOWN_ROOT_SESSIONS,
  normalizeLogSourceSessionId,
  PENDING_UNKNOWN_ROOT_SESSION_TTL_MS,
  TEAM_TASK_LOG_FRESHNESS_DIRNAME,
} from './teamLogSourceWatchScope';

import type { TeamLogSourceLiveContext, TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import type { TeamChangeEvent } from '@shared/types';
import type { FSWatcher } from 'chokidar';

const logger = createLogger('Service:TeamLogSourceTracker');
const CONTEXT_REFRESH_DEBOUNCE_MS = 300;
const PENDING_CONTEXT_REFRESH_RETRY_MS = 1_000;

interface TeamLogSourceSnapshot {
  projectFingerprint: string | null;
  logSourceGeneration: string | null;
}

export type TeamLogSourceTrackingConsumer =
  | 'change_presence'
  | 'change_presence_ensure'
  | 'tool_activity'
  | 'task_log_stream'
  | 'member_log_stream'
  | 'stall_monitor';

interface TrackingState {
  watcher: FSWatcher | null;
  projectDir: string | null;
  activeContext: TeamLogSourceLiveContext | null;
  scopedSessionIds: Set<string>;
  pendingUnknownSessionIds: Map<string, PendingUnknownSessionCandidate>;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  contextRefreshTimer: ReturnType<typeof setTimeout> | null;
  initializePromise: Promise<TeamLogSourceSnapshot> | null;
  initializeVersion: number | null;
  recomputePromise: Promise<TeamLogSourceSnapshot> | null;
  recomputeVersion: number | null;
  snapshot: TeamLogSourceSnapshot;
  consumerCounts: Map<TeamLogSourceTrackingConsumer, number>;
  lifecycleVersion: number;
  ensureIdleReleaseTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingUnknownSessionCandidate {
  sessionId: string;
  expiresAt: number;
  refreshAttempts: number;
}

type DecodedFreshnessTaskId =
  | { kind: 'task-id'; taskId: string }
  | { kind: 'opaque-safe-segment' }
  | { kind: 'invalid' };

type TaskFreshnessSignalKind = NonNullable<TeamChangeEvent['taskSignalKind']>;

function isOpaqueSafeTaskIdSegment(segment: string): boolean {
  return /^task-id-[0-9a-f]{32}$/.test(segment);
}

function pushUniqueNormalizedPath(paths: string[], candidate: string | undefined): void {
  if (!candidate || !path.isAbsolute(candidate)) {
    return;
  }
  const normalized = path.normalize(candidate);
  if (!paths.some((existing) => path.normalize(existing) === normalized)) {
    paths.push(normalized);
  }
}

function getTeamTaskLogFreshnessDir(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_TASK_LOG_FRESHNESS_DIRNAME);
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  const leftToRight = path.relative(normalizedLeft, normalizedRight);
  const rightToLeft = path.relative(normalizedRight, normalizedLeft);
  return (
    !leftToRight ||
    (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight)) ||
    !rightToLeft ||
    (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft))
  );
}

export function shouldIgnoreLogSourceWatcherPath(
  projectDir: string,
  watchedPath: string,
  scope?: {
    scopedSessionIds?: ReadonlySet<string>;
    pendingRootSessionIds?: ReadonlySet<string>;
  }
): boolean {
  const parts = getRelativeLogSourceParts(projectDir, watchedPath);
  if (!parts) {
    return false;
  }

  const first = parts[0];
  if (first === BOARD_TASK_CHANGES_DIRNAME) return true;
  if (parts.includes('tool-results')) return true;
  if (parts.includes('memory')) return true;
  if (first === BOARD_TASK_LOG_FRESHNESS_DIRNAME) return false;
  if (first === BOARD_TASK_CHANGE_FRESHNESS_DIRNAME) return false;

  const scopedSessionIds = scope?.scopedSessionIds;
  if (scopedSessionIds) {
    if (parts.length === 1) {
      if (first.endsWith('.jsonl')) {
        const sessionId = normalizeLogSourceSessionId(first.slice(0, -'.jsonl'.length));
        return (
          !sessionId ||
          (!scopedSessionIds.has(sessionId) && !scope?.pendingRootSessionIds?.has(sessionId))
        );
      }
      return !scopedSessionIds.has(first);
    }

    if (!scopedSessionIds.has(first)) {
      return true;
    }

    if (parts[1] === 'subagents') {
      if (parts.length === 2) return false;
      if (parts.length === 3) return !isAgentTranscriptFileName(parts[2]);
    }

    return true;
  }

  if (parts.length >= 2 && parts[1] === 'subagents') {
    if (parts.length === 2) return false;
    if (parts.length === 3) return !isAgentTranscriptFileName(parts[2]);
    return true;
  }

  return false;
}

export class TeamLogSourceTracker {
  private readonly stateByTeam = new Map<string, TrackingState>();
  private emitter: ((event: TeamChangeEvent) => void) | null = null;
  private readonly changeListeners = new Set<(teamName: string) => void>();

  constructor(private readonly logsFinder: TeamMemberLogsFinder) {}

  setEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void {
    this.emitter = emitter;
  }

  onLogSourceChange(listener: (teamName: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  getSnapshot(teamName: string): TeamLogSourceSnapshot | null {
    const state = this.stateByTeam.get(teamName);
    return state ? { ...state.snapshot } : null;
  }

  /**
   * Read-style "make sure tracking is warm" entry point used by change
   * extraction. Unlike enableTracking, repeated calls do NOT stack consumer
   * acquisitions: the dedicated 'change_presence_ensure' consumer is held at
   * most once and is auto-released after an idle window. Before this was
   * idempotent, every call permanently incremented 'change_presence', so the
   * per-team watcher (one fd per watched file) could never be released for the
   * app lifetime once a team's changes were viewed.
   */
  async ensureTracking(teamName: string): Promise<TeamLogSourceSnapshot> {
    const state = this.getOrCreateState(teamName);
    this.scheduleEnsureTrackingIdleRelease(teamName, state);

    if ((state.consumerCounts.get('change_presence_ensure') ?? 0) > 0) {
      if (
        state.initializePromise &&
        state.initializeVersion === state.lifecycleVersion &&
        this.getActiveConsumerCount(state) > 0
      ) {
        return state.initializePromise;
      }
      if (
        state.watcher !== null ||
        state.projectDir !== null ||
        state.snapshot.logSourceGeneration !== null
      ) {
        return { ...state.snapshot };
      }
      // Tracking was torn down while our acquisition record survived (e.g. an
      // explicit consumer released last). Drop the stale record and reacquire
      // through the normal initialization path.
      state.consumerCounts.delete('change_presence_ensure');
    }

    return this.enableTracking(teamName, 'change_presence_ensure');
  }

  private static readonly ENSURE_TRACKING_IDLE_RELEASE_MS = 10 * 60_000;

  private scheduleEnsureTrackingIdleRelease(teamName: string, state: TrackingState): void {
    if (state.ensureIdleReleaseTimer) {
      clearTimeout(state.ensureIdleReleaseTimer);
    }
    const timer = setTimeout(() => {
      const current = this.stateByTeam.get(teamName);
      if (!current || current.ensureIdleReleaseTimer !== timer) {
        return;
      }
      current.ensureIdleReleaseTimer = null;
      if ((current.consumerCounts.get('change_presence_ensure') ?? 0) > 0) {
        void this.disableTracking(teamName, 'change_presence_ensure').catch(() => undefined);
      }
    }, TeamLogSourceTracker.ENSURE_TRACKING_IDLE_RELEASE_MS);
    timer.unref?.();
    state.ensureIdleReleaseTimer = timer;
  }

  async enableTracking(
    teamName: string,
    consumer: TeamLogSourceTrackingConsumer
  ): Promise<TeamLogSourceSnapshot> {
    const state = this.getOrCreateState(teamName);
    const activeConsumerCountBefore = this.getActiveConsumerCount(state);
    state.consumerCounts.set(consumer, (state.consumerCounts.get(consumer) ?? 0) + 1);
    if (activeConsumerCountBefore === 0) {
      state.lifecycleVersion += 1;
    }

    if (
      state.initializePromise &&
      state.initializeVersion === state.lifecycleVersion &&
      this.getActiveConsumerCount(state) > 0
    ) {
      return state.initializePromise;
    }

    if (
      activeConsumerCountBefore > 0 &&
      (state.watcher !== null ||
        state.projectDir !== null ||
        state.snapshot.logSourceGeneration !== null)
    ) {
      return { ...state.snapshot };
    }

    const initializeVersion = state.lifecycleVersion;
    const initializePromise = this.initializeTeam(teamName, initializeVersion)
      .catch((error) => {
        logger.debug(`Failed to initialize log-source tracker for ${teamName}: ${String(error)}`);
        return { projectFingerprint: null, logSourceGeneration: null };
      })
      .finally(() => {
        const current = this.stateByTeam.get(teamName);
        if (current?.initializePromise === initializePromise) {
          current.initializePromise = null;
          current.initializeVersion = null;
        }
      });

    state.initializePromise = initializePromise;
    state.initializeVersion = initializeVersion;
    return initializePromise;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.stateByTeam.keys()].map((teamName) => this.stopTracking(teamName)));
  }

  private getOrCreateState(teamName: string): TrackingState {
    const existing = this.stateByTeam.get(teamName);
    if (existing) {
      return existing;
    }

    const created: TrackingState = {
      watcher: null,
      projectDir: null,
      activeContext: null,
      scopedSessionIds: new Set(),
      pendingUnknownSessionIds: new Map(),
      refreshTimer: null,
      contextRefreshTimer: null,
      initializePromise: null,
      initializeVersion: null,
      recomputePromise: null,
      recomputeVersion: null,
      snapshot: { projectFingerprint: null, logSourceGeneration: null },
      consumerCounts: new Map(),
      lifecycleVersion: 0,
      ensureIdleReleaseTimer: null,
    };
    this.stateByTeam.set(teamName, created);
    return created;
  }

  private getActiveConsumerCount(state: TrackingState): number {
    let count = 0;
    for (const value of state.consumerCounts.values()) {
      count += value;
    }
    return count;
  }

  async stopTracking(teamName: string): Promise<void> {
    const state = this.stateByTeam.get(teamName);
    if (state?.ensureIdleReleaseTimer) {
      clearTimeout(state.ensureIdleReleaseTimer);
      state.ensureIdleReleaseTimer = null;
    }
    await this.disableTracking(teamName, 'change_presence_ensure');
    await this.disableTracking(teamName, 'change_presence');
  }

  async disableTracking(
    teamName: string,
    consumer: TeamLogSourceTrackingConsumer
  ): Promise<TeamLogSourceSnapshot> {
    const state = this.stateByTeam.get(teamName);
    if (!state) {
      return { projectFingerprint: null, logSourceGeneration: null };
    }

    const currentConsumerCount = state.consumerCounts.get(consumer) ?? 0;
    if (currentConsumerCount > 1) {
      state.consumerCounts.set(consumer, currentConsumerCount - 1);
      return { ...state.snapshot };
    }

    if (currentConsumerCount === 1) {
      state.consumerCounts.delete(consumer);
    }

    if (this.getActiveConsumerCount(state) > 0) {
      return { ...state.snapshot };
    }

    if (currentConsumerCount > 0) {
      state.lifecycleVersion += 1;
    }

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.contextRefreshTimer) {
      clearTimeout(state.contextRefreshTimer);
      state.contextRefreshTimer = null;
    }

    if (state.watcher) {
      await state.watcher.close().catch(() => undefined);
      state.watcher = null;
    }

    state.projectDir = null;
    state.activeContext = null;
    state.scopedSessionIds.clear();
    state.pendingUnknownSessionIds.clear();
    state.snapshot = { projectFingerprint: null, logSourceGeneration: null };
    return { ...state.snapshot };
  }

  private isTrackingCurrent(teamName: string, expectedVersion: number): boolean {
    const state = this.stateByTeam.get(teamName);
    return (
      !!state &&
      this.getActiveConsumerCount(state) > 0 &&
      state.lifecycleVersion === expectedVersion
    );
  }

  private async initializeTeam(
    teamName: string,
    expectedVersion: number
  ): Promise<TeamLogSourceSnapshot> {
    const state = this.getOrCreateState(teamName);
    const previousGeneration = state.snapshot.logSourceGeneration;
    const context = await this.logsFinder.getLiveLogSourceWatchContext(teamName, {
      forceRefresh: true,
    });
    if (!this.isTrackingCurrent(teamName, expectedVersion)) {
      return this.getOrCreateState(teamName).snapshot;
    }
    if (!context) {
      state.activeContext = null;
      state.scopedSessionIds.clear();
      state.snapshot = { projectFingerprint: null, logSourceGeneration: null };
      await this.rebuildWatcher(teamName, null, expectedVersion);
      return state.snapshot;
    }

    state.activeContext = context;
    const snapshot = await this.computeSnapshot(context);
    if (!this.isTrackingCurrent(teamName, expectedVersion)) {
      return this.getOrCreateState(teamName).snapshot;
    }
    state.snapshot = snapshot;
    await this.rebuildWatcher(teamName, context, expectedVersion);
    if (
      this.isTrackingCurrent(teamName, expectedVersion) &&
      state.snapshot.logSourceGeneration &&
      previousGeneration !== state.snapshot.logSourceGeneration
    ) {
      this.emitLogSourceChange(teamName);
    }
    return snapshot;
  }

  private async rebuildWatcher(
    teamName: string,
    context: TeamLogSourceLiveContext | null,
    expectedVersion: number
  ): Promise<void> {
    const state = this.stateByTeam.get(teamName);
    if (
      !state ||
      this.getActiveConsumerCount(state) === 0 ||
      state.lifecycleVersion !== expectedVersion
    ) {
      return;
    }

    if (state.watcher) {
      await state.watcher.close().catch(() => undefined);
      state.watcher = null;
    }

    state.projectDir = context?.projectDir ?? null;
    state.scopedSessionIds.clear();
    if (!context?.projectDir) {
      return;
    }

    if (!this.isTrackingCurrent(teamName, expectedVersion)) {
      state.projectDir = null;
      return;
    }

    const taskFreshnessRootDirs = this.getTaskFreshnessRootDirs(context);
    const taskFreshnessDirs = await this.ensureLogSourceFreshnessDirs(
      teamName,
      context.projectDir,
      taskFreshnessRootDirs
    ).catch((error) => {
      logger.debug(`Failed to ensure log-source freshness dirs for ${teamName}: ${String(error)}`);
      return {
        legacyRootDirs: [path.normalize(context.projectDir)],
        logSignalDirs: [getTeamTaskLogFreshnessDir(teamName)],
      };
    });

    const { targets, scopedSessionIds } = await this.buildScopedWatchTargets(
      context.projectDir,
      context.watchSessionIds,
      this.getPendingUnknownSessionIds(state),
      taskFreshnessDirs
    );
    if (!this.isTrackingCurrent(teamName, expectedVersion)) {
      return;
    }
    state.scopedSessionIds = scopedSessionIds;

    state.watcher = watch(targets, {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
      depth: 0,
      ignored: (watchedPath) => {
        if (
          taskFreshnessDirs.logSignalDirs.some((logSignalDir) =>
            pathsOverlap(watchedPath, logSignalDir)
          )
        ) {
          return false;
        }
        return shouldIgnoreLogSourceWatcherPath(context.projectDir, watchedPath, {
          scopedSessionIds,
          pendingRootSessionIds: new Set(this.getPendingUnknownSessionIds(state)),
        });
      },
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 50,
      },
    });

    const handleWatcherEvent = (
      eventName: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir',
      changedPath?: string
    ): void => {
      const current = this.stateByTeam.get(teamName);
      if (
        !changedPath ||
        !current ||
        this.getActiveConsumerCount(current) === 0 ||
        !current.projectDir
      ) {
        return;
      }
      const eventTaskFreshnessRootDirs = this.getTaskFreshnessRootDirs(current.activeContext);
      const eventTaskFreshnessDirs = this.getTaskFreshnessDirsForContext(
        teamName,
        current.projectDir,
        eventTaskFreshnessRootDirs
      );
      if (
        this.handleTaskFreshnessSignalChangeForDirs(teamName, changedPath, eventTaskFreshnessDirs)
      ) {
        return;
      }

      const action = classifyLogSourceWatcherEvent({
        projectDir: current.projectDir,
        changedPath,
        eventName,
        scopedSessionIds: current.scopedSessionIds,
        pendingUnknownSessionIds: new Set(current.pendingUnknownSessionIds.keys()),
      });

      if (action.kind === 'task-freshness') {
        return;
      }

      if (action.kind === 'context-refresh') {
        this.scheduleContextRefresh(teamName, action.candidateSessionId);
        return;
      }

      if (action.kind === 'scoped-recompute') {
        this.scheduleScopedRecompute(teamName);
      }
    };

    state.watcher.on('add', (changedPath) => handleWatcherEvent('add', changedPath));
    state.watcher.on('change', (changedPath) => handleWatcherEvent('change', changedPath));
    state.watcher.on('unlink', (changedPath) => handleWatcherEvent('unlink', changedPath));
    state.watcher.on('addDir', (changedPath) => handleWatcherEvent('addDir', changedPath));
    state.watcher.on('unlinkDir', (changedPath) => handleWatcherEvent('unlinkDir', changedPath));
    state.watcher.on('error', (error) => {
      logger.warn(`Log-source watcher error for ${teamName}: ${String(error)}`);
    });
  }

  private getTaskFreshnessRootDirs(context: TeamLogSourceLiveContext | null): string[] {
    const roots: string[] = [];
    pushUniqueNormalizedPath(roots, context?.projectDir);
    pushUniqueNormalizedPath(roots, context?.projectPath);
    for (const rootDir of context?.taskFreshnessRootDirs ?? []) {
      pushUniqueNormalizedPath(roots, rootDir);
    }
    return roots;
  }

  private async ensureLogSourceFreshnessDirs(
    teamName: string,
    transcriptProjectDir: string,
    projectDirs: readonly string[]
  ): Promise<{ legacyRootDirs: string[]; logSignalDirs: string[] }> {
    const legacyRootDirs: string[] = [];
    const logSignalDirs: string[] = [];
    const normalizedTranscriptProjectDir = path.normalize(transcriptProjectDir);
    const teamLogFreshnessDir = getTeamTaskLogFreshnessDir(teamName);
    pushUniqueNormalizedPath(legacyRootDirs, normalizedTranscriptProjectDir);
    pushUniqueNormalizedPath(logSignalDirs, teamLogFreshnessDir);

    await Promise.all([
      fs.mkdir(teamLogFreshnessDir, { recursive: true }),
      fs.mkdir(path.join(normalizedTranscriptProjectDir, BOARD_TASK_CHANGE_FRESHNESS_DIRNAME), {
        recursive: true,
      }),
    ]);

    await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const normalizedProjectDir = path.normalize(projectDir);
          if (normalizedProjectDir === normalizedTranscriptProjectDir) {
            return;
          }
          if (!(await this.isDirectory(normalizedProjectDir))) {
            return;
          }
          await fs.mkdir(path.join(normalizedProjectDir, BOARD_TASK_CHANGE_FRESHNESS_DIRNAME), {
            recursive: true,
          });
          pushUniqueNormalizedPath(legacyRootDirs, normalizedProjectDir);
        } catch (error) {
          logger.debug(`Failed to ensure task freshness dirs in ${projectDir}: ${String(error)}`);
        }
      })
    );
    return { legacyRootDirs, logSignalDirs };
  }

  private async buildScopedWatchTargets(
    projectDir: string,
    confirmedSessionIds: readonly string[],
    pendingRootSessionIds: readonly string[],
    taskFreshnessDirs: {
      legacyRootDirs: readonly string[];
      logSignalDirs: readonly string[];
    } = { legacyRootDirs: [projectDir], logSignalDirs: [] }
  ): Promise<{ targets: string[]; scopedSessionIds: Set<string> }> {
    const targets = new Set<string>();
    const scopedSessionIds = new Set<string>();

    targets.add(projectDir);
    for (const logSignalDir of taskFreshnessDirs.logSignalDirs) {
      targets.add(logSignalDir);
    }
    for (const freshnessRootDir of taskFreshnessDirs.legacyRootDirs) {
      targets.add(path.join(freshnessRootDir, BOARD_TASK_LOG_FRESHNESS_DIRNAME));
      targets.add(path.join(freshnessRootDir, BOARD_TASK_CHANGE_FRESHNESS_DIRNAME));
    }

    for (const rawSessionId of confirmedSessionIds) {
      const sessionId = normalizeLogSourceSessionId(rawSessionId);
      if (!sessionId) {
        continue;
      }
      scopedSessionIds.add(sessionId);

      const rootTranscript = path.join(projectDir, `${sessionId}.jsonl`);
      const sessionDir = path.join(projectDir, sessionId);
      const subagentsDir = path.join(sessionDir, 'subagents');

      if (await this.isFile(rootTranscript)) targets.add(rootTranscript);
      if (await this.isDirectory(sessionDir)) targets.add(sessionDir);
      if (await this.isDirectory(subagentsDir)) targets.add(subagentsDir);
    }

    for (const rawSessionId of pendingRootSessionIds) {
      const sessionId = normalizeLogSourceSessionId(rawSessionId);
      if (!sessionId || scopedSessionIds.has(sessionId)) {
        continue;
      }
      const rootTranscript = path.join(projectDir, `${sessionId}.jsonl`);
      if (await this.isFile(rootTranscript)) targets.add(rootTranscript);
    }

    return { targets: [...targets], scopedSessionIds };
  }

  private async isFile(targetPath: string): Promise<boolean> {
    try {
      return (await fs.stat(targetPath)).isFile();
    } catch {
      return false;
    }
  }

  private async isDirectory(targetPath: string): Promise<boolean> {
    try {
      return (await fs.stat(targetPath)).isDirectory();
    } catch {
      return false;
    }
  }

  private getPendingUnknownSessionIds(state: TrackingState): string[] {
    this.prunePendingUnknownSessions(state);
    return [...state.pendingUnknownSessionIds.keys()];
  }

  private rememberPendingUnknownSession(
    state: TrackingState,
    rawSessionId: string | undefined
  ): void {
    const sessionId = normalizeLogSourceSessionId(rawSessionId);
    if (!sessionId || state.scopedSessionIds.has(sessionId)) {
      return;
    }

    const now = Date.now();
    state.pendingUnknownSessionIds.set(sessionId, {
      sessionId,
      expiresAt: now + PENDING_UNKNOWN_ROOT_SESSION_TTL_MS,
      refreshAttempts: state.pendingUnknownSessionIds.get(sessionId)?.refreshAttempts ?? 0,
    });

    while (state.pendingUnknownSessionIds.size > MAX_PENDING_UNKNOWN_ROOT_SESSIONS) {
      const oldest = [...state.pendingUnknownSessionIds.values()].sort(
        (left, right) => left.expiresAt - right.expiresAt
      )[0];
      if (!oldest) break;
      state.pendingUnknownSessionIds.delete(oldest.sessionId);
    }
  }

  private prunePendingUnknownSessions(state: TrackingState): void {
    const now = Date.now();
    for (const [sessionId, candidate] of state.pendingUnknownSessionIds.entries()) {
      if (
        candidate.expiresAt <= now ||
        candidate.refreshAttempts >= MAX_PENDING_UNKNOWN_ROOT_REFRESH_ATTEMPTS
      ) {
        state.pendingUnknownSessionIds.delete(sessionId);
      }
    }
  }

  private markPendingRefreshAttempt(state: TrackingState): void {
    for (const candidate of state.pendingUnknownSessionIds.values()) {
      candidate.refreshAttempts += 1;
    }
    this.prunePendingUnknownSessions(state);
  }

  private removeConfirmedPendingSessions(
    state: TrackingState,
    confirmedSessionIds: readonly string[]
  ): void {
    for (const rawSessionId of confirmedSessionIds) {
      const sessionId = normalizeLogSourceSessionId(rawSessionId);
      if (sessionId) {
        state.pendingUnknownSessionIds.delete(sessionId);
      }
    }
  }

  private scheduleScopedRecompute(teamName: string): void {
    const current = this.stateByTeam.get(teamName);
    if (!current || this.getActiveConsumerCount(current) === 0) {
      return;
    }
    if (current.refreshTimer) {
      clearTimeout(current.refreshTimer);
    }
    current.refreshTimer = setTimeout(() => {
      current.refreshTimer = null;
      void this.recompute(teamName);
    }, 300);
  }

  private scheduleContextRefresh(
    teamName: string,
    candidateSessionId?: string,
    delayMs: number = CONTEXT_REFRESH_DEBOUNCE_MS
  ): void {
    const state = this.stateByTeam.get(teamName);
    if (!state || this.getActiveConsumerCount(state) === 0) {
      return;
    }
    this.rememberPendingUnknownSession(state, candidateSessionId);
    if (state.contextRefreshTimer) {
      return;
    }
    state.contextRefreshTimer = setTimeout(() => {
      const current = this.stateByTeam.get(teamName);
      if (!current) return;
      current.contextRefreshTimer = null;
      if (this.getActiveConsumerCount(current) === 0) return;
      void this.refreshContextAndWatcher(teamName, current.lifecycleVersion);
    }, delayMs);
  }

  private async refreshContextAndWatcher(teamName: string, expectedVersion: number): Promise<void> {
    const state = this.stateByTeam.get(teamName);
    if (!state || !this.isTrackingCurrent(teamName, expectedVersion)) {
      return;
    }
    this.markPendingRefreshAttempt(state);

    const previousGeneration = state.snapshot.logSourceGeneration;
    const context = await this.logsFinder.getLiveLogSourceWatchContext(teamName, {
      forceRefresh: true,
    });
    if (!this.isTrackingCurrent(teamName, expectedVersion)) {
      return;
    }

    state.activeContext = context;
    if (!context) {
      state.scopedSessionIds.clear();
      state.snapshot = { projectFingerprint: null, logSourceGeneration: null };
      await this.rebuildWatcher(teamName, null, expectedVersion);
      return;
    }

    this.removeConfirmedPendingSessions(state, context.watchSessionIds);
    state.snapshot = await this.computeSnapshot(context);
    if (!this.isTrackingCurrent(teamName, expectedVersion)) {
      return;
    }
    await this.rebuildWatcher(teamName, context, expectedVersion);

    if (
      state.snapshot.logSourceGeneration &&
      previousGeneration !== state.snapshot.logSourceGeneration
    ) {
      this.emitLogSourceChange(teamName);
    }
    if (
      this.isTrackingCurrent(teamName, expectedVersion) &&
      state.pendingUnknownSessionIds.size > 0
    ) {
      this.scheduleContextRefresh(teamName, undefined, PENDING_CONTEXT_REFRESH_RETRY_MS);
    }
  }

  private handleTaskFreshnessSignalChange(
    teamName: string,
    changedPath: string,
    signalDir: string,
    taskSignalKind: TaskFreshnessSignalKind
  ): boolean {
    const relativePath = path.relative(signalDir, changedPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return path.normalize(changedPath) === path.normalize(signalDir);
    }

    if (relativePath === '.') {
      return true;
    }

    if (relativePath.includes(path.sep)) {
      return true;
    }

    const decoded = this.decodeTaskLogFreshnessTaskId(relativePath);
    if (decoded.kind === 'invalid') {
      return true;
    }
    if (decoded.kind === 'opaque-safe-segment') {
      void this.emitTaskFreshnessSignalFromFile(teamName, changedPath, taskSignalKind);
      return true;
    }

    this.emitter?.({
      type: 'task-log-change',
      teamName,
      taskId: decoded.taskId,
      taskSignalKind,
    });
    return true;
  }

  private decodeTaskLogFreshnessTaskId(fileName: string): DecodedFreshnessTaskId {
    if (!fileName.endsWith(BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX)) {
      return { kind: 'invalid' };
    }

    const encodedTaskId = fileName.slice(0, -BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX.length);
    if (!encodedTaskId) {
      return { kind: 'invalid' };
    }
    if (isOpaqueSafeTaskIdSegment(encodedTaskId)) {
      return { kind: 'opaque-safe-segment' };
    }

    try {
      const taskId = decodeURIComponent(encodedTaskId);
      return taskId.trim().length > 0 ? { kind: 'task-id', taskId } : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  private async emitTaskFreshnessSignalFromFile(
    teamName: string,
    filePath: string,
    taskSignalKind: TaskFreshnessSignalKind
  ): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const taskId =
        typeof parsed.taskId === 'string' && parsed.taskId.trim().length > 0
          ? parsed.taskId.trim()
          : null;
      if (taskId) {
        this.emitter?.({
          type: 'task-log-change',
          teamName,
          taskId,
          taskSignalKind,
        });
        return;
      }
    } catch {
      // Deletions or partially unavailable files still need a team-level refresh.
    }
    this.emitLogSourceChange(teamName);
  }

  private handleTaskFreshnessSignalChangeForRoots(
    teamName: string,
    changedPath: string,
    taskFreshnessRootDirs: readonly string[]
  ): boolean {
    for (const freshnessRootDir of taskFreshnessRootDirs) {
      if (
        this.handleTaskFreshnessSignalChange(
          teamName,
          changedPath,
          path.join(freshnessRootDir, BOARD_TASK_LOG_FRESHNESS_DIRNAME),
          'log'
        )
      ) {
        return true;
      }
      if (
        this.handleTaskFreshnessSignalChange(
          teamName,
          changedPath,
          path.join(freshnessRootDir, BOARD_TASK_CHANGE_FRESHNESS_DIRNAME),
          'change'
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private getTaskFreshnessDirsForContext(
    teamName: string,
    projectDir: string,
    taskFreshnessRootDirs: readonly string[]
  ): { legacyRootDirs: string[]; logSignalDirs: string[] } {
    const legacyRootDirs = [...taskFreshnessRootDirs];
    pushUniqueNormalizedPath(legacyRootDirs, projectDir);
    return {
      legacyRootDirs,
      logSignalDirs: [getTeamTaskLogFreshnessDir(teamName)],
    };
  }

  private handleTaskFreshnessSignalChangeForDirs(
    teamName: string,
    changedPath: string,
    taskFreshnessDirs: { legacyRootDirs: readonly string[]; logSignalDirs: readonly string[] }
  ): boolean {
    for (const logSignalDir of taskFreshnessDirs.logSignalDirs) {
      if (this.handleTaskFreshnessSignalChange(teamName, changedPath, logSignalDir, 'log')) {
        return true;
      }
    }
    return this.handleTaskFreshnessSignalChangeForRoots(
      teamName,
      changedPath,
      taskFreshnessDirs.legacyRootDirs
    );
  }

  private async recompute(teamName: string): Promise<TeamLogSourceSnapshot> {
    const state = this.getOrCreateState(teamName);
    if (this.getActiveConsumerCount(state) === 0) {
      return state.snapshot;
    }
    if (
      state.recomputePromise &&
      state.recomputeVersion === state.lifecycleVersion &&
      this.getActiveConsumerCount(state) > 0
    ) {
      return state.recomputePromise;
    }

    const recomputeVersion = state.lifecycleVersion;
    const recomputePromise = (async () => {
      const previousGeneration = state.snapshot.logSourceGeneration;
      const context = state.activeContext;

      if (!context) {
        state.snapshot = { projectFingerprint: null, logSourceGeneration: null };
      } else {
        state.snapshot = await this.computeSnapshot(context);
        if (!this.isTrackingCurrent(teamName, recomputeVersion)) {
          return this.getOrCreateState(teamName).snapshot;
        }
      }

      if (
        this.isTrackingCurrent(teamName, recomputeVersion) &&
        previousGeneration &&
        state.snapshot.logSourceGeneration &&
        previousGeneration !== state.snapshot.logSourceGeneration
      ) {
        this.emitLogSourceChange(teamName);
      }

      return state.snapshot;
    })().finally(() => {
      const current = this.stateByTeam.get(teamName);
      if (current?.recomputePromise === recomputePromise) {
        current.recomputePromise = null;
        current.recomputeVersion = null;
      }
    });

    state.recomputePromise = recomputePromise;
    state.recomputeVersion = recomputeVersion;
    return recomputePromise;
  }

  private emitLogSourceChange(teamName: string): void {
    for (const listener of this.changeListeners) {
      try {
        listener(teamName);
      } catch (error) {
        logger.warn(`Log-source listener failed for ${teamName}: ${String(error)}`);
      }
    }
    this.emitter?.({
      type: 'log-source-change',
      teamName,
    });
  }

  private async computeSnapshot(context: TeamLogSourceLiveContext): Promise<TeamLogSourceSnapshot> {
    const projectFingerprint = computeTaskChangePresenceProjectFingerprint(context.projectPath);
    const parts: string[] = [];
    const sessionIds =
      context.watchSessionIds.length > 0 ? context.watchSessionIds : context.sessionIds;

    for (const rawSessionId of [...sessionIds].sort((a, b) => a.localeCompare(b))) {
      const sessionId = normalizeLogSourceSessionId(rawSessionId);
      if (!sessionId) {
        continue;
      }
      const rootLogPath = path.join(context.projectDir, `${sessionId}.jsonl`);
      const sessionDir = path.join(context.projectDir, sessionId);
      const subagentsDir = path.join(sessionDir, 'subagents');
      parts.push(await this.describePath('root', rootLogPath));
      parts.push(await this.describePath('session', sessionDir));
      parts.push(await this.describePath('subagents', subagentsDir));

      let entries: string[] = [];
      try {
        entries = await fs.readdir(subagentsDir);
      } catch {
        entries = [];
      }

      for (const fileName of entries
        .filter((entry) => isAgentTranscriptFileName(entry))
        .sort((a, b) => a.localeCompare(b))) {
        parts.push(await this.describePath('subagent-log', path.join(subagentsDir, fileName)));
      }
    }

    if (parts.length === 0) {
      return { projectFingerprint, logSourceGeneration: null };
    }

    return {
      projectFingerprint,
      logSourceGeneration: createHash('sha256').update(parts.join('|')).digest('hex'),
    };
  }

  private async describePath(kind: string, targetPath: string): Promise<string> {
    const normalizedPath = normalizeTaskChangePresenceFilePath(targetPath);
    try {
      const stats = await fs.stat(targetPath);
      const type = stats.isDirectory() ? 'dir' : 'file';
      return `${kind}:${type}:${normalizedPath}:${stats.size}:${stats.mtimeMs}`;
    } catch {
      return `${kind}:missing:${normalizedPath}`;
    }
  }
}
