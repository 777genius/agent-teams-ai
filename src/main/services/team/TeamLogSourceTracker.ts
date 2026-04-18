import { createLogger } from '@shared/utils/logger';
import { watch } from 'chokidar';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  computeTaskChangePresenceProjectFingerprint,
  normalizeTaskChangePresenceFilePath,
} from './taskChangePresenceUtils';

import type { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import type { TeamChangeEvent } from '@shared/types';
import type { FSWatcher } from 'chokidar';

const logger = createLogger('Service:TeamLogSourceTracker');
const BOARD_TASK_LOG_FRESHNESS_DIRNAME = '.board-task-log-freshness';
const BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX = '.json';

interface TeamLogSourceSnapshot {
  projectFingerprint: string | null;
  logSourceGeneration: string | null;
}

export type TeamLogSourceTrackingConsumer = 'change_presence' | 'tool_activity' | 'task_log_stream';

interface TrackingState {
  watcher: FSWatcher | null;
  projectDir: string | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  initializePromise: Promise<TeamLogSourceSnapshot> | null;
  initializeVersion: number | null;
  recomputePromise: Promise<TeamLogSourceSnapshot> | null;
  recomputeVersion: number | null;
  snapshot: TeamLogSourceSnapshot;
  consumerCounts: Map<TeamLogSourceTrackingConsumer, number>;
  lifecycleVersion: number;
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

  async ensureTracking(teamName: string): Promise<TeamLogSourceSnapshot> {
    return this.enableTracking(teamName, 'change_presence');
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
      refreshTimer: null,
      initializePromise: null,
      initializeVersion: null,
      recomputePromise: null,
      recomputeVersion: null,
      snapshot: { projectFingerprint: null, logSourceGeneration: null },
      consumerCounts: new Map(),
      lifecycleVersion: 0,
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

    if (state.watcher) {
      await state.watcher.close().catch(() => undefined);
      state.watcher = null;
    }

    state.projectDir = null;
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
    const context = await this.logsFinder.getLogSourceWatchContext(teamName, {
      forceRefresh: true,
    });
    if (!this.isTrackingCurrent(teamName, expectedVersion)) {
      return this.getOrCreateState(teamName).snapshot;
    }
    if (!context) {
      state.snapshot = { projectFingerprint: null, logSourceGeneration: null };
      await this.rebuildWatcher(teamName, null, expectedVersion);
      return state.snapshot;
    }

    const snapshot = await this.computeSnapshot(context);
    if (!this.isTrackingCurrent(teamName, expectedVersion)) {
      return this.getOrCreateState(teamName).snapshot;
    }
    state.snapshot = snapshot;
    await this.rebuildWatcher(teamName, context.projectDir, expectedVersion);
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
    projectDir: string | null,
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
    if (state.projectDir === projectDir && state.watcher) {
      return;
    }

    if (state.watcher) {
      await state.watcher.close().catch(() => undefined);
      state.watcher = null;
    }

    state.projectDir = projectDir;
    if (!projectDir) {
      return;
    }

    if (!this.isTrackingCurrent(teamName, expectedVersion)) {
      state.projectDir = null;
      return;
    }

    state.watcher = watch(projectDir, {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
      depth: 3,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 50,
      },
    });

    const scheduleRecompute = (changedPath?: string): void => {
      const current = this.stateByTeam.get(teamName);
      if (!current || this.getActiveConsumerCount(current) === 0 || !current.projectDir) {
        return;
      }
      if (
        changedPath &&
        this.handleTaskLogFreshnessSignalChange(teamName, current.projectDir, changedPath)
      ) {
        return;
      }
      if (current.refreshTimer) {
        clearTimeout(current.refreshTimer);
      }
      current.refreshTimer = setTimeout(() => {
        current.refreshTimer = null;
        void this.recompute(teamName);
      }, 300);
    };

    state.watcher.on('add', scheduleRecompute);
    state.watcher.on('change', scheduleRecompute);
    state.watcher.on('unlink', scheduleRecompute);
    state.watcher.on('addDir', scheduleRecompute);
    state.watcher.on('unlinkDir', scheduleRecompute);
    state.watcher.on('error', (error) => {
      logger.warn(`Log-source watcher error for ${teamName}: ${String(error)}`);
    });
  }

  private handleTaskLogFreshnessSignalChange(
    teamName: string,
    projectDir: string,
    changedPath: string
  ): boolean {
    const signalDir = path.join(projectDir, BOARD_TASK_LOG_FRESHNESS_DIRNAME);
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

    const taskId = this.decodeTaskLogFreshnessTaskId(relativePath);
    if (!taskId) {
      return true;
    }

    this.emitter?.({
      type: 'task-log-change',
      teamName,
      taskId,
    });
    return true;
  }

  private decodeTaskLogFreshnessTaskId(fileName: string): string | null {
    if (!fileName.endsWith(BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX)) {
      return null;
    }

    const encodedTaskId = fileName.slice(0, -BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX.length);
    if (!encodedTaskId) {
      return null;
    }

    try {
      const taskId = decodeURIComponent(encodedTaskId);
      return taskId.trim().length > 0 ? taskId : null;
    } catch {
      return null;
    }
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
      const context = await this.logsFinder.getLogSourceWatchContext(teamName, {
        forceRefresh: true,
      });
      if (!this.isTrackingCurrent(teamName, recomputeVersion)) {
        return this.getOrCreateState(teamName).snapshot;
      }

      if (!context) {
        state.snapshot = { projectFingerprint: null, logSourceGeneration: null };
        await this.rebuildWatcher(teamName, null, recomputeVersion);
      } else {
        state.snapshot = await this.computeSnapshot(context);
        if (!this.isTrackingCurrent(teamName, recomputeVersion)) {
          return this.getOrCreateState(teamName).snapshot;
        }
        await this.rebuildWatcher(teamName, context.projectDir, recomputeVersion);
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
    this.emitter?.({
      type: 'log-source-change',
      teamName,
    });
    for (const listener of this.changeListeners) {
      try {
        listener(teamName);
      } catch (error) {
        logger.warn(`Log-source listener failed for ${teamName}: ${String(error)}`);
      }
    }
  }

  private async computeSnapshot(context: {
    projectDir: string;
    projectPath?: string;
    leadSessionId?: string;
    sessionIds: string[];
  }): Promise<TeamLogSourceSnapshot> {
    const projectFingerprint = computeTaskChangePresenceProjectFingerprint(context.projectPath);
    const parts: string[] = [];

    if (context.leadSessionId) {
      const leadLogPath = path.join(context.projectDir, `${context.leadSessionId}.jsonl`);
      parts.push(await this.describePath('lead', leadLogPath));
    }

    for (const sessionId of [...context.sessionIds].sort((a, b) => a.localeCompare(b))) {
      const sessionDir = path.join(context.projectDir, sessionId);
      const subagentsDir = path.join(sessionDir, 'subagents');
      parts.push(await this.describePath('session', sessionDir));
      parts.push(await this.describePath('subagents', subagentsDir));

      let entries: string[] = [];
      try {
        entries = await fs.readdir(subagentsDir);
      } catch {
        entries = [];
      }

      for (const fileName of entries
        .filter(
          (entry) =>
            entry.startsWith('agent-') &&
            entry.endsWith('.jsonl') &&
            !entry.startsWith('agent-acompact')
        )
        .sort((a, b) => a.localeCompare(b))) {
        parts.push(await this.describePath('subagent-log', path.join(subagentsDir, fileName)));
      }
    }

    const sourceMaterial =
      parts.length > 0
        ? parts.join('|')
        : `empty:${normalizeTaskChangePresenceFilePath(context.projectDir)}`;

    return {
      projectFingerprint,
      logSourceGeneration: createHash('sha256').update(sourceMaterial).digest('hex'),
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
