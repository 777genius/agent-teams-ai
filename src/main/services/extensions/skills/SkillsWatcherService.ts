import { isPathWithinRoot } from '@main/utils/pathValidation';
import { createLogger } from '@shared/utils/logger';
import { watch } from 'chokidar';

import { SkillRootsResolver } from './SkillRootsResolver';

import type { SkillWatcherEvent } from '@shared/types/extensions';
import type { FSWatcher } from 'chokidar';

const logger = createLogger('Extensions:SkillsWatcher');
const WATCHER_DEBOUNCE_MS = 250;

export class SkillsWatcherService {
  private watcher: FSWatcher | null = null;
  private subscriptions = new Map<string, string | null>();
  private pendingEvents = new Map<string, SkillWatcherEvent>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private emitChange: ((event: SkillWatcherEvent) => void) | null = null;
  private nextWatchId = 0;

  constructor(private readonly rootsResolver = new SkillRootsResolver()) {}

  setEmitter(emitChange: (event: SkillWatcherEvent) => void): void {
    this.emitChange = emitChange;
  }

  async start(projectPath?: string): Promise<string> {
    const watchId = `skills-watch-${++this.nextWatchId}`;
    this.subscriptions.set(watchId, projectPath ?? null);
    await this.rebuildWatcher();
    return watchId;
  }

  async stop(watchId: string): Promise<void> {
    this.subscriptions.delete(watchId);
    await this.rebuildWatcher();
  }

  private async rebuildWatcher(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingEvents.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    const roots = [
      ...new Set(
        [...this.subscriptions.values()].flatMap((projectPath) =>
          this.rootsResolver.resolve(projectPath ?? undefined).map((root) => root.rootPath)
        )
      ),
    ];

    if (roots.length === 0) {
      return;
    }

    this.watcher = watch(roots, {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
      depth: 5,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    const queue = (type: SkillWatcherEvent['type'], filePath: string): void => {
      this.enqueueEventsForPath(type, filePath);
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.emitChange) {
          for (const event of this.pendingEvents.values()) {
            this.emitChange(event);
          }
        }
        this.pendingEvents.clear();
      }, WATCHER_DEBOUNCE_MS);
    };

    this.watcher.on('add', (filePath) => queue('create', filePath));
    this.watcher.on('addDir', (filePath) => queue('create', filePath));
    this.watcher.on('change', (filePath) => queue('change', filePath));
    this.watcher.on('unlink', (filePath) => queue('delete', filePath));
    this.watcher.on('unlinkDir', (filePath) => queue('delete', filePath));
    this.watcher.on('error', (error) => logger.warn('Skills watcher error', error));
  }

  async stopAll(): Promise<void> {
    this.subscriptions.clear();
    await this.rebuildWatcher();
  }

  private enqueueEventsForPath(type: SkillWatcherEvent['type'], filePath: string): void {
    const matchedProjectPaths = new Set<string | null>();
    let matchedUserRoot = false;

    for (const projectPath of this.subscriptions.values()) {
      const roots = this.rootsResolver.resolve(projectPath ?? undefined);
      for (const root of roots) {
        if (!isPathWithinRoot(filePath, root.rootPath)) continue;
        if (root.scope === 'user') {
          matchedUserRoot = true;
        } else {
          matchedProjectPaths.add(projectPath ?? null);
        }
      }
    }

    if (matchedUserRoot) {
      this.pendingEvents.set(`user:${type}`, {
        scope: 'user',
        projectPath: null,
        path: filePath,
        type,
      });
    }

    for (const projectPath of matchedProjectPaths) {
      this.pendingEvents.set(`project:${projectPath ?? 'null'}:${type}`, {
        scope: 'project',
        projectPath,
        path: filePath,
        type,
      });
    }
  }
}
