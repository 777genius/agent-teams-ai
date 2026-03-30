import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import { gitIdentityResolver } from '../parsing/GitIdentityResolver';

import type { ProjectBranchChangeEvent } from '@shared/types';

const logger = createLogger('Service:BranchStatus');
const POLL_INTERVAL_MS = 20_000;

interface BranchResolver {
  getBranch(projectPath: string, options?: { forceRefresh?: boolean }): Promise<string | null>;
}

interface TrackedPathState {
  actualPath: string;
  refCount: number;
  token: number;
}

const UNSET_BRANCH = Symbol('unset-branch');

export class BranchStatusService {
  private readonly trackedPaths = new Map<string, TrackedPathState>();
  private readonly inFlightChecks = new Map<string, Promise<void>>();
  private readonly lastEmittedBranchByPath = new Map<string, string | null | typeof UNSET_BRANCH>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nextToken = 1;

  constructor(
    private readonly emitBranchChange: (event: ProjectBranchChangeEvent) => void,
    private readonly resolver: BranchResolver = gitIdentityResolver
  ) {}

  async setTracking(projectPath: string, enabled: boolean): Promise<void> {
    const trimmed = projectPath.trim();
    if (!trimmed) return;
    const normalizedPath = path.normalize(trimmed);

    if (!enabled) {
      this.unsubscribe(normalizedPath);
      return;
    }

    const existing = this.trackedPaths.get(normalizedPath);
    if (existing) {
      existing.refCount += 1;
      return;
    }
    this.trackedPaths.set(normalizedPath, {
      actualPath: normalizedPath,
      refCount: 1,
      token: this.nextToken++,
    });
    this.startPollingIfNeeded();
    await this.checkPath(normalizedPath, false);
  }

  dispose(): void {
    this.resetAllTracking();
  }

  resetAllTracking(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.trackedPaths.clear();
    this.inFlightChecks.clear();
    this.lastEmittedBranchByPath.clear();
  }

  private unsubscribe(normalizedPath: string): void {
    const existing = this.trackedPaths.get(normalizedPath);
    if (!existing) return;
    existing.refCount -= 1;
    if (existing.refCount > 0) return;
    this.trackedPaths.delete(normalizedPath);
    this.inFlightChecks.delete(normalizedPath);
    this.lastEmittedBranchByPath.delete(normalizedPath);
    if (this.trackedPaths.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startPollingIfNeeded(): void {
    if (this.pollTimer || this.trackedPaths.size === 0) return;
    this.pollTimer = setInterval(() => {
      for (const normalizedPath of this.trackedPaths.keys()) {
        void this.checkPath(normalizedPath, true);
      }
    }, POLL_INTERVAL_MS);
  }

  private async checkPath(normalizedPath: string, forceRefresh: boolean): Promise<void> {
    const tracked = this.trackedPaths.get(normalizedPath);
    if (!tracked) return;
    const expectedToken = tracked.token;
    if (this.inFlightChecks.has(normalizedPath)) {
      return this.inFlightChecks.get(normalizedPath);
    }

    const promise = (async () => {
      try {
        const branch = await this.resolver.getBranch(tracked.actualPath, { forceRefresh });
        const latestTracked = this.trackedPaths.get(normalizedPath);
        if (!latestTracked || latestTracked.token !== expectedToken) return;

        const previous = this.lastEmittedBranchByPath.get(normalizedPath) ?? UNSET_BRANCH;
        if (previous !== UNSET_BRANCH && previous === branch) {
          return;
        }

        this.lastEmittedBranchByPath.set(normalizedPath, branch);
        this.emitBranchChange({
          projectPath: latestTracked.actualPath,
          branch,
        });
      } catch (error) {
        logger.debug(
          `Failed to resolve branch for ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })().finally(() => {
      this.inFlightChecks.delete(normalizedPath);
    });

    this.inFlightChecks.set(normalizedPath, promise);
    return promise;
  }
}
