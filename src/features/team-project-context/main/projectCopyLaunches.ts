import type { ProjectContextProgressMapper } from './projectContextLaunch';

/**
 * Launches of project copies that are in flight in this app, the one source for "a launch of this
 * copy is running" (`resolveReadyProjectCopy`). A launch counts from the reservation of its copy
 * until its run settled and, for a ready run, the copy was confirmed; the provisioning run of the
 * copy lies inside that window. Each launch has its own in-memory entry. After the launch
 * returns, the provisioning runtime is consulted if a terminal progress event never arrives.
 */
const launches = new Map<string, Set<TrackedLaunch>>();
const RECONCILE_INTERVAL_MS = 30_000;

/** States after which a run of a copy no longer changes on its own. */
const SETTLED_STATES: ReadonlySet<string> = new Set([
  'ready',
  'failed',
  'cancelled',
  'disconnected',
]);

export interface ProjectCopyLaunch {
  /** Ends this launch; later calls do nothing. */
  end(): void;
  /** After the launch returns, consult its runtime ownership when progress is missing. */
  watchRun(isActive: () => boolean): void;
  /**
   * The progress mapper of this launch: it ends the launch once a settled progress has been
   * delivered, so a ready run ends only after its copy was confirmed (the mapper delivers `ready`
   * only then, or `failed` when the confirmation fails).
   */
  settleOn(mapper: ProjectContextProgressMapper): ProjectContextProgressMapper;
}

interface TrackedLaunch extends ProjectCopyLaunch {
  isActive(): boolean;
}

export function trackProjectCopyLaunch(executionTeamName: string): ProjectCopyLaunch {
  const entries = launches.get(executionTeamName) ?? new Set<TrackedLaunch>();
  launches.set(executionTeamName, entries);
  let ended = false;
  let confirming = false;
  let runIsActive: (() => boolean) | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  const end = (): void => {
    if (ended) return;
    ended = true;
    if (reconcileTimer) clearInterval(reconcileTimer);
    entries.delete(launch);
    if (entries.size === 0) launches.delete(executionTeamName);
  };
  const launch: TrackedLaunch = {
    end,
    watchRun: (isActive) => {
      if (ended) return;
      runIsActive = isActive;
      if (!reconcileTimer) {
        reconcileTimer = setInterval(() => launch.isActive(), RECONCILE_INTERVAL_MS);
        reconcileTimer.unref();
      }
    },
    isActive: () => {
      if (ended) return false;
      // A ready notification can remove the run before asynchronous confirmation completes.
      if (confirming || !runIsActive) return true;
      try {
        if (runIsActive()) return true;
        end();
        return false;
      } catch {
        // An unavailable runtime is not evidence that the launch has stopped.
        return true;
      }
    },
    settleOn: (mapper) => (progress, deliver) => {
      if (progress.state === 'ready') confirming = true;
      try {
        mapper(progress, (mapped) => {
          try {
            deliver(mapped);
          } finally {
            if (SETTLED_STATES.has(mapped.state)) end();
          }
        });
      } catch (error) {
        if (progress.state === 'ready') end();
        throw error;
      }
    },
  };
  entries.add(launch);
  return launch;
}

export function isProjectCopyLaunching(executionTeamName: string): boolean {
  const entries = launches.get(executionTeamName);
  if (!entries) return false;
  // Inspect every entry, including stale ones after an active concurrent launch.
  return [...entries].map((entry) => entry.isActive()).some(Boolean);
}

/**
 * Whether a pending copy is being launched: a launch of it is in flight in this app, or its team
 * process runs (`isTeamAlive`, when the caller can tell). Otherwise its launch failed or was
 * interrupted, and waiting does not help.
 */
export function createProjectLaunchProbe(
  isTeamAlive?: (teamName: string) => boolean
): (executionTeamName: string) => boolean {
  return (executionTeamName) =>
    isProjectCopyLaunching(executionTeamName) || isTeamAlive?.(executionTeamName) === true;
}
