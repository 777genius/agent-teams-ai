import { OPENCODE_TASK_LOG_ATTRIBUTION_FILE } from '@shared/constants/opencodeTaskLogAttribution';
import { watch } from 'chokidar';
import * as fsp from 'fs/promises';
import * as path from 'path';

import type { FSWatcher } from 'chokidar';
import type { Dirent } from 'fs';

export type TeamTaskWatchKind = 'teams' | 'tasks';
export type TeamTaskWatchEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface TeamTaskWatchRegistryOptions {
  kind: TeamTaskWatchKind;
  rootPath: string;
  onChange: (eventType: TeamTaskWatchEventType, relativePath: string) => void;
  onError: (error: unknown) => void;
}

const RECONCILE_INTERVAL_MS = 30_000;

// Keep this list aligned with FileWatcher.processTeamsChange().
// If a new team artifact should produce TeamChangeEvent, add it here too.
const TEAM_ROOT_FILES = new Set([
  'config.json',
  'kanban-state.json',
  'processes.json',
  'sentMessages.json',
  'team.meta.json',
  'members.meta.json',
  OPENCODE_TASK_LOG_ATTRIBUTION_FILE,
]);

/**
 * Shallow watcher registry for team and task artifacts.
 *
 * Why this exists:
 * - Node recursive fs.watch on Linux expands into many inotify subscriptions.
 *   Large ~/.claude/teams trees can hit EMFILE/ENOSPC and freeze startup work.
 * - FileWatcher only consumes a small set of team/task JSON artifacts, so a
 *   broad recursive watcher mostly watches runtime/log/member noise.
 *
 * Contract:
 * - Watch only teams/, teams/<team>/, teams/<team>/inboxes/, tasks/, tasks/<team>/.
 * - Do not enable Chokidar polling here. Polling is owned by FileWatcher fallback.
 * - Initial app startup baseline must stay silent to avoid replaying old files.
 * - Newly discovered targets are scanned once so files created before rebuild
 *   are not lost.
 */
export class TeamTaskWatchRegistry {
  private watcher: FSWatcher | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private targets = new Set<string>();
  private targetKey = '';
  private initialTargetsCaptured = false;
  private closed = false;
  private generation = 0;
  private reconcileInProgress = false;
  private reconcileAgain = false;

  constructor(private readonly options: TeamTaskWatchRegistryOptions) {}

  async start(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.reconcileTargets({ rethrowErrors: true });
    if (this.closed || this.reconcileTimer) {
      return;
    }

    // This is target reconciliation, not content polling. It only rebuilds the
    // shallow watch set when team/task/inbox directories appear or disappear.
    this.reconcileTimer = setInterval(() => {
      void this.reconcileTargets();
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation += 1;

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    const watcher = this.watcher;
    this.watcher = null;
    this.targets.clear();
    this.targetKey = '';
    if (watcher) {
      await this.closeWatcher(watcher);
    }
  }

  private async reconcileTargets(options: { rethrowErrors?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.reconcileInProgress) {
      this.reconcileAgain = true;
      return;
    }

    this.reconcileInProgress = true;
    try {
      const targets = await this.collectTargets();
      const nextKey = targets.join('\n');
      if (nextKey !== this.targetKey) {
        const addedTargets = targets.filter((target) => !this.targets.has(target));
        await this.rebuildWatcher(targets, nextKey, addedTargets);
      }
    } catch (error) {
      if (options.rethrowErrors) {
        throw error;
      }
      if (!this.closed) {
        this.options.onError(error);
      }
    } finally {
      this.reconcileInProgress = false;
    }

    if (this.reconcileAgain && !this.closed) {
      this.reconcileAgain = false;
      await this.reconcileTargets();
    }
  }

  private async rebuildWatcher(
    targets: string[],
    nextKey: string,
    addedTargets: string[]
  ): Promise<void> {
    const generation = this.generation + 1;
    this.generation = generation;

    const previousWatcher = this.watcher;
    this.watcher = null;
    if (previousWatcher) {
      await this.closeWatcher(previousWatcher);
    }

    if (this.closed || generation !== this.generation) {
      return;
    }

    const nextWatcher = watch(targets, {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
      depth: 0,
    });

    this.watcher = nextWatcher;
    this.targets = new Set(targets);
    this.targetKey = nextKey;
    // First registry build is app startup baseline and must not emit old files.
    // Later rebuilds can emit existing files only for newly added targets.
    const shouldEmitExistingFiles = this.initialTargetsCaptured;
    this.initialTargetsCaptured = true;

    const handleEvent = (eventType: TeamTaskWatchEventType, changedPath?: string): void => {
      if (this.closed || generation !== this.generation || !changedPath) {
        return;
      }

      const relativePath = this.toRelativePath(changedPath);
      if (!relativePath) {
        return;
      }

      // addDir/unlinkDir can make the watch target set stale immediately.
      // Periodic reconciliation is the backup path if the directory event is missed.
      if (this.shouldReconcile(eventType, relativePath)) {
        void this.reconcileTargets();
      }

      if (!this.shouldEmit(eventType, relativePath)) {
        return;
      }

      this.options.onChange(eventType, relativePath);
    };

    nextWatcher.on('add', (changedPath) => handleEvent('add', changedPath));
    nextWatcher.on('change', (changedPath) => handleEvent('change', changedPath));
    nextWatcher.on('unlink', (changedPath) => handleEvent('unlink', changedPath));
    nextWatcher.on('addDir', (changedPath) => handleEvent('addDir', changedPath));
    nextWatcher.on('unlinkDir', (changedPath) => handleEvent('unlinkDir', changedPath));
    nextWatcher.on('error', (error) => {
      if (!this.closed && generation === this.generation) {
        this.options.onError(error);
      }
    });

    if (shouldEmitExistingFiles) {
      await this.emitExistingFilesForNewTargets(addedTargets, generation);
    }
  }

  private async emitExistingFilesForNewTargets(
    targets: string[],
    generation: number
  ): Promise<void> {
    const normalizedRoot = path.normalize(this.options.rootPath);
    for (const targetPath of targets) {
      if (this.closed || generation !== this.generation) {
        return;
      }
      if (path.normalize(targetPath) === normalizedRoot) {
        continue;
      }
      // Covers the race where a new team/task/inbox dir is created with JSON
      // files before Chokidar has rebuilt its target list. Only immediate files
      // are scanned, matching depth: 0.
      const entries = await this.readDirectory(targetPath);
      for (const entry of entries) {
        if (this.closed || generation !== this.generation) {
          return;
        }
        if (!entry.isFile()) {
          continue;
        }
        const relativePath = this.toRelativePath(path.join(targetPath, entry.name));
        if (relativePath && this.shouldEmit('add', relativePath)) {
          this.options.onChange('add', relativePath);
        }
      }
    }
  }

  private async collectTargets(): Promise<string[]> {
    // Keep this intentionally shallow. Do not add members/, runtime/,
    // .opencode-runtime/, logs, or other deep trees unless FileWatcher starts
    // emitting user-visible events for those artifacts.
    const targets = new Set<string>([path.normalize(this.options.rootPath)]);
    const rootEntries = await this.readDirectory(this.options.rootPath);

    for (const entry of rootEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const teamPath = path.join(this.options.rootPath, entry.name);
      targets.add(path.normalize(teamPath));

      if (this.options.kind === 'teams') {
        const inboxPath = path.join(teamPath, 'inboxes');
        if (await this.isDirectory(inboxPath)) {
          targets.add(path.normalize(inboxPath));
        }
      }
    }

    return [...targets].sort((left, right) => left.localeCompare(right));
  }

  private async readDirectory(dirPath: string): Promise<Dirent[]> {
    try {
      return await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async closeWatcher(watcher: FSWatcher): Promise<void> {
    try {
      await watcher.close();
    } catch {
      // Best-effort cleanup only. Chokidar close can fail if the underlying
      // watcher is already torn down during startup or limit-error recovery.
    }
  }

  private async isDirectory(dirPath: string): Promise<boolean> {
    try {
      return (await fsp.stat(dirPath)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private toRelativePath(changedPath: string): string | null {
    const absolutePath = path.isAbsolute(changedPath)
      ? changedPath
      : path.join(this.options.rootPath, changedPath);
    const relativePath = path.relative(this.options.rootPath, absolutePath);

    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }

    return relativePath.replace(/\\/g, '/');
  }

  private shouldReconcile(eventType: TeamTaskWatchEventType, relativePath: string): boolean {
    if (eventType !== 'addDir' && eventType !== 'unlinkDir') {
      return false;
    }

    const parts = relativePath.split('/').filter(Boolean);
    if (parts.length === 1) {
      return true;
    }

    return this.options.kind === 'teams' && parts.length === 2 && parts[1] === 'inboxes';
  }

  private shouldEmit(eventType: TeamTaskWatchEventType, relativePath: string): boolean {
    if (eventType === 'addDir' || eventType === 'unlinkDir') {
      return false;
    }

    // This is the event gate. Expanding it changes the FileWatcher public event
    // surface, so update tests and TeamChangeEvent consumers together.
    const parts = relativePath.split('/').filter(Boolean);
    if (this.options.kind === 'tasks') {
      return parts.length === 2 && !parts[1].startsWith('.') && parts[1].endsWith('.json');
    }

    if (parts.length === 2) {
      return TEAM_ROOT_FILES.has(parts[1]);
    }

    return parts.length === 3 && parts[1] === 'inboxes' && parts[2].endsWith('.json');
  }
}
