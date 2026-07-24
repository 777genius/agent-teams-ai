import {
  getFullTeamDataRequestKey,
  getTeamDataRequestKey,
  getThinTeamDataRequestKey,
  isTeamDataRequestKeyForTeam,
  normalizeTeamGetDataOptions,
} from './teamViewDataRequestKeys';

import type { TeamGetDataOptions, TeamViewSnapshot } from '@shared/types';

interface PostPaintHandle {
  rafId?: number;
  timerId?: ReturnType<typeof setTimeout>;
  fallbackTimerId?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  ran: boolean;
}

export interface TeamViewDataCoordinatorSnapshot {
  hasPendingFreshTeamDataRefresh: boolean;
  hasPostPaintTeamEnrichmentTimer: boolean;
  hasQueuedFullTeamDataRefreshAfterThin: boolean;
}

export class TeamViewDataCoordinator {
  private readonly dataRequests = new Map<string, Promise<TeamViewSnapshot>>();
  private readonly refreshCalls = new Map<string, Set<symbol>>();
  private readonly pendingFreshRefreshes = new Map<string, Promise<TeamViewSnapshot>>();
  private readonly queuedFullRefreshesAfterThin = new Set<string>();
  private readonly postPaintHandles = new Map<string, PostPaintHandle>();

  requestDataDeduped(
    teamName: string,
    options: TeamGetDataOptions | undefined,
    request: (normalizedOptions: TeamGetDataOptions | undefined) => Promise<TeamViewSnapshot>
  ): Promise<TeamViewSnapshot> {
    const normalizedOptions = normalizeTeamGetDataOptions(options);
    const key = getTeamDataRequestKey(teamName, normalizedOptions);
    const existing = this.dataRequests.get(key);
    if (existing) return existing;

    const nextRequest = request(normalizedOptions).finally(() => {
      if (this.dataRequests.get(key) === nextRequest) {
        this.dataRequests.delete(key);
      }
    });
    this.dataRequests.set(key, nextRequest);
    return nextRequest;
  }

  hasFullDataRequest(teamName: string): boolean {
    return this.getFullDataRequest(teamName) !== undefined;
  }

  getFullDataRequest(teamName: string): Promise<TeamViewSnapshot> | undefined {
    return this.dataRequests.get(getFullTeamDataRequestKey(teamName));
  }

  hasThinDataRequest(teamName: string): boolean {
    return this.dataRequests.has(getThinTeamDataRequestKey(teamName));
  }

  beginRefresh(teamName: string): symbol {
    const token = Symbol(teamName);
    const current = this.refreshCalls.get(teamName);
    if (current) {
      current.add(token);
    } else {
      this.refreshCalls.set(teamName, new Set([token]));
    }
    return token;
  }

  endRefresh(teamName: string, token: symbol): void {
    const current = this.refreshCalls.get(teamName);
    if (!current) return;
    current.delete(token);
    if (current.size === 0) {
      this.refreshCalls.delete(teamName);
    }
  }

  markFreshRefreshPending(teamName: string, request: Promise<TeamViewSnapshot>): void {
    this.pendingFreshRefreshes.set(teamName, request);
  }

  consumeFreshRefresh(teamName: string, request: Promise<TeamViewSnapshot>): boolean {
    if (this.pendingFreshRefreshes.get(teamName) !== request) return false;
    this.pendingFreshRefreshes.delete(teamName);
    return true;
  }

  queueFullRefreshAfterThin(teamName: string): void {
    this.queuedFullRefreshesAfterThin.add(teamName);
  }

  consumeQueuedFullRefreshAfterThin(teamName: string): boolean {
    return this.queuedFullRefreshesAfterThin.delete(teamName);
  }

  clearQueuedFullRefreshAfterThin(teamName: string): void {
    this.queuedFullRefreshesAfterThin.delete(teamName);
  }

  schedulePostPaint(teamName: string, run: () => void, fallbackDelayMs: number): void {
    this.cancelPostPaint(teamName);

    const handle: PostPaintHandle = {
      cancelled: false,
      ran: false,
    };
    const runOnce = (): void => {
      if (handle.cancelled || handle.ran) return;
      handle.ran = true;
      this.clearScheduledCallbacks(handle);
      if (this.postPaintHandles.get(teamName) === handle) {
        this.postPaintHandles.delete(teamName);
      }
      run();
    };
    const scheduleTimer = (): void => {
      handle.timerId = setTimeout(runOnce, 0);
    };

    handle.fallbackTimerId = setTimeout(runOnce, fallbackDelayMs);
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      handle.rafId = window.requestAnimationFrame(() => {
        handle.rafId = undefined;
        scheduleTimer();
      });
    } else {
      scheduleTimer();
    }
    this.postPaintHandles.set(teamName, handle);
  }

  cancelPostPaint(teamName: string): void {
    const handle = this.postPaintHandles.get(teamName);
    if (!handle) return;
    handle.cancelled = true;
    this.clearScheduledCallbacks(handle);
    this.postPaintHandles.delete(teamName);
  }

  isRefreshPending(teamName: string): boolean {
    return (
      this.hasFullDataRequest(teamName) ||
      (this.refreshCalls.get(teamName)?.size ?? 0) > 0 ||
      this.pendingFreshRefreshes.has(teamName) ||
      this.queuedFullRefreshesAfterThin.has(teamName)
    );
  }

  clearTeam(teamName: string): void {
    for (const key of this.dataRequests.keys()) {
      if (isTeamDataRequestKeyForTeam(key, teamName)) {
        this.dataRequests.delete(key);
      }
    }
    this.refreshCalls.delete(teamName);
    this.pendingFreshRefreshes.delete(teamName);
    this.queuedFullRefreshesAfterThin.delete(teamName);
    this.cancelPostPaint(teamName);
  }

  reset(): void {
    for (const teamName of this.postPaintHandles.keys()) {
      this.cancelPostPaint(teamName);
    }
    this.dataRequests.clear();
    this.refreshCalls.clear();
    this.pendingFreshRefreshes.clear();
    this.queuedFullRefreshesAfterThin.clear();
  }

  snapshot(teamName: string): TeamViewDataCoordinatorSnapshot {
    return {
      hasPendingFreshTeamDataRefresh: this.pendingFreshRefreshes.has(teamName),
      hasPostPaintTeamEnrichmentTimer: this.postPaintHandles.has(teamName),
      hasQueuedFullTeamDataRefreshAfterThin: this.queuedFullRefreshesAfterThin.has(teamName),
    };
  }

  private clearScheduledCallbacks(handle: PostPaintHandle): void {
    if (
      handle.rafId !== undefined &&
      typeof window !== 'undefined' &&
      typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(handle.rafId);
      handle.rafId = undefined;
    }
    if (handle.timerId !== undefined) {
      clearTimeout(handle.timerId);
      handle.timerId = undefined;
    }
    if (handle.fallbackTimerId !== undefined) {
      clearTimeout(handle.fallbackTimerId);
      handle.fallbackTimerId = undefined;
    }
  }
}

export const defaultTeamViewDataCoordinator = new TeamViewDataCoordinator();
