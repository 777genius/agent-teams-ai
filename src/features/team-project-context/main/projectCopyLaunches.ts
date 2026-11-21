import type { ProjectContextProgressMapper } from './projectContextLaunch';

/**
 * Launches of project copies that are in flight in this app, the one source for "a launch of this
 * copy is running" (`resolveReadyProjectCopy`). A launch counts from the reservation of its copy
 * until its run settled and, for a ready run, the copy was confirmed; the provisioning run of the
 * copy lies inside that window. A pure in-memory count per copy: two launches of one copy (the
 * second one finding the first already running) each end their own.
 */
const launches = new Map<string, number>();

/** States after which a run of a copy no longer changes on its own. */
const SETTLED_STATES: ReadonlySet<string> = new Set(['ready', 'failed', 'cancelled', 'disconnected']);

export interface ProjectCopyLaunch {
  /** Ends this launch; later calls do nothing. */
  end(): void;
  /**
   * The progress mapper of this launch: it ends the launch once a settled progress has been
   * delivered, so a ready run ends only after its copy was confirmed (the mapper delivers `ready`
   * only then, or `failed` when the confirmation fails).
   */
  settleOn(mapper: ProjectContextProgressMapper): ProjectContextProgressMapper;
}

export function trackProjectCopyLaunch(executionTeamName: string): ProjectCopyLaunch {
  launches.set(executionTeamName, (launches.get(executionTeamName) ?? 0) + 1);
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    const left = (launches.get(executionTeamName) ?? 1) - 1;
    if (left > 0) launches.set(executionTeamName, left);
    else launches.delete(executionTeamName);
  };
  return {
    end,
    settleOn: (mapper) => (progress, deliver) =>
      mapper(progress, (mapped) => {
        deliver(mapped);
        if (SETTLED_STATES.has(mapped.state)) end();
      }),
  };
}

export function isProjectCopyLaunching(executionTeamName: string): boolean {
  return launches.has(executionTeamName);
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
