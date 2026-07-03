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
  /**
   * Optional provider for the set of team names whose team root/task artifacts
   * should be watched. The root directory is always watched to detect new or
   * removed teams. Return `null` (or omit the provider) to watch every team -
   * the original behavior and safe fallback.
   *
   * Scoping exists because idle historical teams are static, so watching all of
   * them is pure overhead that scales with the number of teams on disk.
   */
  getScopedTeamNames?: () => ReadonlySet<string> | null;
  /**
   * Optional provider for teams whose `inboxes/` directories should be watched
   * for live delivery. If omitted, inboxes follow getScopedTeamNames for
   * backward compatibility. Return `null` to watch every inbox as a safe
   * fallback.
   */
  getScopedInboxTeamNames?: () => ReadonlySet<string> | null;
}

const RECONCILE_INTERVAL_MS = 30_000;

// Coalesce bursts of directory add/remove events (e.g. a team launch creating
// many dirs/files) into a single target reconcile + watcher rebuild. collectTargets
// re-reads the current directory state, so a trailing reconcile still sees every
// change; this only avoids rebuilding the whole watcher once per event in a burst.
const RECONCILE_DEBOUNCE_MS = 250;

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
 *   Team root/task scope and inbox scope can differ: inboxes are normally only
 *   watched for live/running teams.
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
  private closed = false;
  private generation = 0;
  private reconcileInProgress = false;
  private reconcileAgain = false;
  private reconcileDebounceTimer: NodeJS.Timeout | null = null;

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

  /**
   * Force an immediate target reconciliation. Call this when the scoped team set
   * changes (a team launches, stops, or becomes engaged in the UI) so the watch
   * set updates without waiting for the periodic reconcile. Safe to call often:
   * it no-ops when the resulting target set is unchanged and coalesces with any
   * in-flight reconcile.
   */
  async requestReconcile(): Promise<void> {
    await this.reconcileTargets();
  }

  /**
   * Debounced target reconcile for high-frequency directory events. Bursts of
   * add/remove dir events (notably while a team launch creates many dirs/files)
   * collapse into a single rebuild after a short window instead of tearing down
   * and recreating the whole watcher once per event. Correctness is preserved:
   * collectTargets re-reads the current directory state, so the trailing reconcile
   * still sees every change, and emitExistingFilesForNewTargets backfills files
   * created before the rebuild.
   */
  private scheduleReconcile(): void {
    if (this.closed || this.reconcileDebounceTimer) {
      return;
    }
    this.reconcileDebounceTimer = setTimeout(() => {
      this.reconcileDebounceTimer = null;
      void this.reconcileTargets();
    }, RECONCILE_DEBOUNCE_MS);
    this.reconcileDebounceTimer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation += 1;

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.reconcileDebounceTimer) {
      clearTimeout(this.reconcileDebounceTimer);
      this.reconcileDebounceTimer = null;
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
        await this.applyTargetSet(targets, nextKey);
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

  private async applyTargetSet(targets: string[], nextKey: string): Promise<void> {
    if (this.closed) {
      return;
    }
    // First time: create the watcher with the full target set. ignoreInitial keeps
    // the app-startup baseline silent so old files are not replayed.
    if (!this.watcher) {
      this.createWatcher(targets, nextKey);
      return;
    }

    // Incrementally update the existing watcher rather than tearing it down and
    // recreating it. A full rebuild re-opens an fd for EVERY watched file (kqueue
    // on macOS opens one fd per file), so during a launch that adds dirs in bursts
    // it re-opened the entire (large) watched set repeatedly. add()/unwatch() touch
    // only the delta. emitExistingFilesForNewTargets still backfills files that
    // already exist in newly added dirs, preserving the previous event surface
    // (chokidar's own add() scan only re-confirms those same files, idempotently).
    const nextSet = new Set(targets);
    const addedTargets = targets.filter((target) => !this.targets.has(target));
    const removedTargets = [...this.targets].filter((target) => !nextSet.has(target));
    const generation = this.generation;

    if (removedTargets.length > 0) {
      this.watcher.unwatch(removedTargets);
    }
    if (addedTargets.length > 0) {
      this.watcher.add(addedTargets);
    }
    this.targets = nextSet;
    this.targetKey = nextKey;

    if (addedTargets.length > 0) {
      await this.emitExistingFilesForNewTargets(addedTargets, generation);
    }
  }

  private createWatcher(targets: string[], nextKey: string): void {
    const generation = this.generation + 1;
    this.generation = generation;

    const watcher = watch(targets, {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
      depth: 0,
    });

    this.watcher = watcher;
    this.targets = new Set(targets);
    this.targetKey = nextKey;

    const handleEvent = (eventType: TeamTaskWatchEventType, changedPath?: string): void => {
      if (this.closed || generation !== this.generation || !changedPath) {
        return;
      }

      const relativePath = this.toRelativePath(changedPath);
      if (!relativePath) {
        return;
      }

      // addDir/unlinkDir can make the watch target set stale immediately.
      // Debounced so a burst of dir events (e.g. a team launch) coalesces into one
      // reconcile; periodic reconciliation is the backup path if an event is missed.
      if (this.shouldReconcile(eventType, relativePath)) {
        this.scheduleReconcile();
      }

      if (!this.shouldEmit(eventType, relativePath)) {
        return;
      }

      this.options.onChange(eventType, relativePath);
    };

    watcher.on('add', (changedPath) => handleEvent('add', changedPath));
    watcher.on('change', (changedPath) => handleEvent('change', changedPath));
    watcher.on('unlink', (changedPath) => handleEvent('unlink', changedPath));
    watcher.on('addDir', (changedPath) => handleEvent('addDir', changedPath));
    watcher.on('unlinkDir', (changedPath) => handleEvent('unlinkDir', changedPath));
    watcher.on('error', (error) => {
      if (!this.closed && generation === this.generation) {
        this.options.onError(error);
      }
    });
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
    // null => no scoping: watch every team (original behavior / safe fallback).
    const scopedTeams = this.options.getScopedTeamNames?.() ?? null;
    const scopedInboxTeams =
      this.options.kind !== 'teams'
        ? scopedTeams
        : this.options.getScopedInboxTeamNames
          ? this.options.getScopedInboxTeamNames()
          : scopedTeams;

    for (const entry of rootEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const teamPath = path.join(this.options.rootPath, entry.name);
      const artifactInScope = scopedTeams === null || scopedTeams.has(entry.name);
      const inboxInScope =
        this.options.kind === 'teams' &&
        (scopedInboxTeams === null || scopedInboxTeams.has(entry.name));

      // Watch root/task artifacts for running or recently opened teams, but
      // watch inboxes only for live teams. If either scope falls back to all,
      // include the team root too so newly created inbox dirs are still seen.
      if (!artifactInScope && !inboxInScope) {
        continue;
      }
      if (artifactInScope || inboxInScope) {
        targets.add(path.normalize(teamPath));
      }

      if (inboxInScope) {
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
