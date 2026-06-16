import type {
  GlobalTask,
  TeamChangeEvent,
  TeamProvisioningProgress,
  TeamSummary,
} from '@shared/types';

export type LaunchIoGovernorOperationKey = 'teams:list' | 'teams:getAllTasks';

type GovernedPayload = TeamSummary[] | GlobalTask[];
type CloneFn<T> = (value: T) => T;

interface LaunchIoGovernorLogger {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface LaunchIoGovernorOptions {
  quietWindowMs?: number;
  maxStaleAgeMs?: number;
  stuckLaunchPressureMs?: number;
  warningCooldownMs?: number;
  now?: () => number;
  logger?: LaunchIoGovernorLogger;
}

interface ActiveLaunch {
  teamName: string;
  source: string;
  startedAt: number;
  updatedAt: number;
}

interface CachedValue<T> {
  value: T;
  cachedAt: number;
}

interface OperationState<T> {
  key: LaunchIoGovernorOperationKey;
  cache: CachedValue<T> | null;
  dirty: boolean;
  generation: number;
  inFlight: Promise<T> | null;
  loadFresh: (() => Promise<T>) | null;
  clone: CloneFn<T> | null;
  scheduledRefresh: ReturnType<typeof setTimeout> | null;
  lastWarningAt: number;
}

export const DEFAULT_LAUNCH_IO_QUIET_WINDOW_MS = 3_000;
export const DEFAULT_LAUNCH_IO_MAX_STALE_AGE_MS = 120_000;
export const DEFAULT_LAUNCH_IO_STUCK_PRESSURE_MS = 10 * 60_000;
const DEFAULT_WARNING_COOLDOWN_MS = 10_000;

const TERMINAL_PROVISIONING_STATES = new Set(['ready', 'failed', 'cancelled', 'disconnected']);

export function cloneLaunchIoGovernorPayload<T extends GovernedPayload>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export class LaunchIoGovernor {
  private readonly quietWindowMs: number;
  private readonly maxStaleAgeMs: number;
  private readonly stuckLaunchPressureMs: number;
  private readonly warningCooldownMs: number;
  private readonly now: () => number;
  private readonly logger: LaunchIoGovernorLogger;
  private readonly activeLaunches = new Map<string, ActiveLaunch>();
  private readonly operations = new Map<
    LaunchIoGovernorOperationKey,
    OperationState<GovernedPayload>
  >();
  private quietUntil = 0;

  constructor(options: LaunchIoGovernorOptions = {}) {
    this.quietWindowMs = options.quietWindowMs ?? DEFAULT_LAUNCH_IO_QUIET_WINDOW_MS;
    this.maxStaleAgeMs = options.maxStaleAgeMs ?? DEFAULT_LAUNCH_IO_MAX_STALE_AGE_MS;
    this.stuckLaunchPressureMs =
      options.stuckLaunchPressureMs ?? DEFAULT_LAUNCH_IO_STUCK_PRESSURE_MS;
    this.warningCooldownMs = options.warningCooldownMs ?? DEFAULT_WARNING_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? {};
    this.operations.set('teams:list', this.createOperationState('teams:list'));
    this.operations.set('teams:getAllTasks', this.createOperationState('teams:getAllTasks'));
  }

  noteLaunchIntent(teamName: string, source = 'unknown'): void {
    const normalized = this.normalizeTeamName(teamName);
    if (!normalized) {
      return;
    }
    const now = this.now();
    this.pruneStuckLaunches(now);
    this.activeLaunches.set(normalized, {
      teamName: normalized,
      source,
      startedAt: now,
      updatedAt: now,
    });
    this.markDirty('teams:list');
    this.scheduleDirtyRefreshes(false);
  }

  noteProvisioningProgress(progress: TeamProvisioningProgress): void {
    const teamName = this.normalizeTeamName(progress.teamName);
    if (!teamName) {
      return;
    }
    const now = this.now();
    this.pruneStuckLaunches(now);
    this.markDirty('teams:list');

    if (TERMINAL_PROVISIONING_STATES.has(String(progress.state))) {
      this.activeLaunches.delete(teamName);
      this.quietUntil = Math.max(this.quietUntil, now + this.quietWindowMs);
      this.scheduleDirtyRefreshes(true);
      return;
    }

    const existing = this.activeLaunches.get(teamName);
    this.activeLaunches.set(teamName, {
      teamName,
      source: existing?.source ?? 'progress',
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    });
    this.scheduleDirtyRefreshes(false);
  }

  noteTeamChange(event: TeamChangeEvent): void {
    if (event.type === 'config') {
      this.markDirty('teams:list');
      this.markDirty('teams:getAllTasks');
    } else if (event.type === 'task') {
      this.markDirty('teams:getAllTasks');
    }
    if (this.hasLaunchPressure(this.now())) {
      this.scheduleDirtyRefreshes(false);
    }
  }

  async runSummaryOperation<T extends GovernedPayload>(
    key: LaunchIoGovernorOperationKey,
    loadFresh: () => Promise<T>,
    options: { clone: CloneFn<T> }
  ): Promise<T> {
    const state = this.getOperationState<T>(key);
    state.loadFresh = loadFresh;
    state.clone = options.clone;

    if (this.canServeStale(state)) {
      if (state.dirty) {
        this.scheduleDeferredRefresh(key, state, false);
      }
      return options.clone(state.cache!.value);
    }

    return this.runFresh(key, state, false);
  }

  clearForTests(): void {
    for (const state of this.operations.values()) {
      if (state.scheduledRefresh) {
        clearTimeout(state.scheduledRefresh);
      }
    }
    this.activeLaunches.clear();
    this.quietUntil = 0;
    this.operations.clear();
    this.operations.set('teams:list', this.createOperationState('teams:list'));
    this.operations.set('teams:getAllTasks', this.createOperationState('teams:getAllTasks'));
  }

  hasLaunchPressureForTests(): boolean {
    return this.hasLaunchPressure(this.now());
  }

  private createOperationState<T extends GovernedPayload>(
    key: LaunchIoGovernorOperationKey
  ): OperationState<T> {
    return {
      key,
      cache: null,
      dirty: false,
      generation: 0,
      inFlight: null,
      loadFresh: null,
      clone: null,
      scheduledRefresh: null,
      lastWarningAt: Number.NEGATIVE_INFINITY,
    };
  }

  private getOperationState<T extends GovernedPayload>(
    key: LaunchIoGovernorOperationKey
  ): OperationState<T> {
    const state = this.operations.get(key);
    if (!state) {
      throw new Error(`Unknown launch IO governor operation: ${key}`);
    }
    return state as unknown as OperationState<T>;
  }

  private canServeStale<T extends GovernedPayload>(state: OperationState<T>): boolean {
    const now = this.now();
    if (!this.hasLaunchPressure(now) || !state.cache) {
      return false;
    }
    return now - state.cache.cachedAt <= this.maxStaleAgeMs;
  }

  private async runFresh<T extends GovernedPayload>(
    key: LaunchIoGovernorOperationKey,
    state: OperationState<T>,
    background: boolean
  ): Promise<T> {
    if (!state.loadFresh || !state.clone) {
      throw new Error(`Launch IO governor operation ${key} has no loader`);
    }

    if (state.inFlight) {
      try {
        const joined = await state.inFlight;
        return state.clone(joined);
      } catch (error) {
        if (background) {
          this.warnRefreshFailure(key, state, error);
        }
        throw error;
      }
    }

    const generationAtStart = state.generation;
    const loadFresh = state.loadFresh;
    const clone = state.clone;
    const promise = loadFresh();
    state.inFlight = promise;

    try {
      const fresh = await promise;
      if (state.generation === generationAtStart) {
        state.cache = {
          value: clone(fresh),
          cachedAt: this.now(),
        };
        state.dirty = false;
      }
      return clone(fresh);
    } catch (error) {
      if (background) {
        this.warnRefreshFailure(key, state, error);
      }
      throw error;
    } finally {
      if (state.inFlight === promise) {
        state.inFlight = null;
      }
    }
  }

  private markDirty(key: LaunchIoGovernorOperationKey): void {
    const state = this.getOperationState(key);
    state.dirty = true;
    state.generation += 1;
  }

  private scheduleDirtyRefreshes(force: boolean): void {
    for (const [key, state] of this.operations) {
      if (state.dirty) {
        this.scheduleDeferredRefresh(key, state, force);
      }
    }
  }

  private scheduleDeferredRefresh<T extends GovernedPayload>(
    key: LaunchIoGovernorOperationKey,
    state: OperationState<T>,
    force: boolean
  ): void {
    if (!state.loadFresh || !state.clone) {
      return;
    }
    if (state.scheduledRefresh) {
      if (!force) {
        return;
      }
      clearTimeout(state.scheduledRefresh);
      state.scheduledRefresh = null;
    }

    const delayMs = this.getDelayUntilFreshAllowed(this.now());
    state.scheduledRefresh = setTimeout(() => {
      state.scheduledRefresh = null;
      void this.flushOperation(key);
    }, delayMs);
    state.scheduledRefresh.unref?.();
  }

  private async flushOperation(key: LaunchIoGovernorOperationKey): Promise<void> {
    const state = this.getOperationState(key);
    const now = this.now();
    if (this.hasLaunchPressure(now)) {
      this.scheduleDeferredRefresh(key, state, true);
      return;
    }
    if (!state.dirty || !state.loadFresh || !state.clone) {
      return;
    }
    try {
      await this.runFresh(key, state, true);
    } catch {
      // runFresh already emitted a bounded warning. Keep dirty=true so the next
      // request or quiet-window timer can retry without losing the last-good cache.
    }
  }

  private getDelayUntilFreshAllowed(now: number): number {
    this.pruneStuckLaunches(now);
    if (this.activeLaunches.size > 0) {
      return this.quietWindowMs;
    }
    return Math.max(0, this.quietUntil - now);
  }

  private hasLaunchPressure(now: number): boolean {
    this.pruneStuckLaunches(now);
    return this.activeLaunches.size > 0 || now < this.quietUntil;
  }

  private pruneStuckLaunches(now: number): void {
    for (const [teamName, launch] of this.activeLaunches) {
      if (now - launch.updatedAt > this.stuckLaunchPressureMs) {
        this.activeLaunches.delete(teamName);
        this.logger.warn?.(
          `[LaunchIoGovernor] launch pressure expired team=${teamName} source=${launch.source} ageMs=${now - launch.startedAt}`
        );
      }
    }
  }

  private warnRefreshFailure<T extends GovernedPayload>(
    key: LaunchIoGovernorOperationKey,
    state: OperationState<T>,
    error: unknown
  ): void {
    const now = this.now();
    if (now - state.lastWarningAt < this.warningCooldownMs) {
      return;
    }
    state.lastWarningAt = now;
    const ageMs = state.cache ? now - state.cache.cachedAt : null;
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.logger.warn?.(
      `[LaunchIoGovernor] deferred refresh failed op=${key} ageMs=${ageMs ?? 'none'} dirty=${state.dirty} activeLaunchCount=${this.activeLaunches.size} error=${errorMessage}`
    );
  }

  private normalizeTeamName(teamName: string | undefined | null): string | null {
    const normalized = teamName?.trim();
    return normalized && normalized.length > 0 ? normalized : null;
  }
}
