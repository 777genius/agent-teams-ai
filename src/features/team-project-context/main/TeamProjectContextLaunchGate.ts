import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';
import type { TeamRuntimeState } from '@shared/types';

interface ContextRegistry {
  list(
    logicalTeamName: string
  ): Promise<readonly Pick<PersistedTeamWorkContext, 'executionTeamName' | 'state'>[]>;
}

export interface RunningProjectContextForEdit {
  executionTeamName: string;
  runId: string;
}

interface RuntimeStateReader {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  hasProvisioningRun(teamName: string): boolean;
}

/** Why a project context blocks an edit, for callers that map it to their own error codes. */
export type TeamProjectContextConflictReason = 'unreconciled' | 'launching' | 'running';

/**
 * A launch of a per-project team was refused by the state of its project copy
 * (an unowned or nested copy, missing settings). The app shows the message;
 * HTTP answers 409 with this code.
 */
export class TeamProjectContextLaunchRefusedError extends Error {
  readonly code = 'TEAM_PROJECT_CONTEXT_REFUSED';
}

export class TeamProjectContextLaunchConflictError extends Error {
  readonly code = 'TEAM_PROJECT_CONTEXT_RUNNING';

  constructor(
    message: string,
    readonly reason: TeamProjectContextConflictReason = 'running'
  ) {
    super(message);
  }
}

/**
 * Whether a team's runtime is down. The one rule both the launch gate and the
 * verification after an explicit stop build on:
 * - a live process is never down;
 * - no progress means down only without a tracked run (a run id that is not
 *   cleared yet is a stop still settling);
 * - a failed or cancelled progress is a dead run, even though a dead bootstrap
 *   owner is still reported with its run id, unless the failed run kept secondary
 *   lanes alive;
 * - a stale "ready" or "disconnected" progress is no proof a process stopped, and
 *   a progress still in flight is a run that is not down.
 */
export function isStoppedTeamRuntime(state: TeamRuntimeState): boolean {
  if (state.isAlive) return false;
  const progress = state.progress;
  if (progress === null) return state.runId === null;
  if (progress.retainedSecondaryRuntime === true) return false;
  return progress.state === 'failed' || progress.state === 'cancelled';
}

/**
 * The stricter reading used to admit a launch or an edit: a dead run that is
 * still tracked (its run id is not cleared) does not count, so nothing can start
 * on top of state that has not been released.
 */
export function isConfirmedStoppedTeamRuntime(state: TeamRuntimeState): boolean {
  return state.runId === null && isStoppedTeamRuntime(state);
}

/**
 * A logical team may have multiple durable work histories but only one live
 * runtime context. This is a preflight policy, not a substitute for the caller
 * holding a logical-team operation lock through native launch admission.
 */
export class TeamProjectContextLaunchGate {
  constructor(
    private readonly contexts: ContextRegistry,
    private readonly runtime: RuntimeStateReader
  ) {}

  /**
   * Editing the team definition is allowed only when no project context is
   * running, launching or stopping: a running roster must never silently
   * diverge from the definition it was started from.
   */
  async assertAllContextsStopped(logicalTeamName: string): Promise<void> {
    await this.inspectContextsForEdit(logicalTeamName, false);
  }

  /**
   * Identify the single live copy for an edit. The caller must hold the logical-team operation
   * lock and still fence the selected runtime through the actual mutation; this is a preflight.
   */
  async findRunningContextForEdit(
    logicalTeamName: string
  ): Promise<RunningProjectContextForEdit | null> {
    return this.inspectContextsForEdit(logicalTeamName, true);
  }

  private async inspectContextsForEdit(
    logicalTeamName: string,
    allowRunning: boolean
  ): Promise<RunningProjectContextForEdit | null> {
    const all = await this.contexts.list(logicalTeamName);
    if (all.some((context) => context.state !== 'ready')) {
      throw new TeamProjectContextLaunchConflictError(
        'A project of this team is still being prepared, or its last start was interrupted. ' +
          'Open that project and launch the team there again so it can finish, then edit the team',
        'unreconciled'
      );
    }
    let running: RunningProjectContextForEdit | null = null;
    for (const name of [logicalTeamName, ...all.map((context) => context.executionTeamName)]) {
      const state = await this.runtime.getRuntimeState(name);
      // A ready live run may retain its provisioning owner for its lifetime. Only accept that
      // owner when the same run is explicitly ready and alive; cancelled and transitional runs
      // still have to finish cleanup before an edit can start.
      const readyRun =
        allowRunning &&
        name !== logicalTeamName &&
        state.isAlive &&
        Boolean(state.runId) &&
        state.progress?.state === 'ready' &&
        state.progress.runId === state.runId &&
        state.progress.teamName === name &&
        !state.progress.retainedSecondaryRuntime;
      if (this.runtime.hasProvisioningRun(name) && !readyRun) {
        throw new TeamProjectContextLaunchConflictError(
          'This team is still launching or stopping in a project; wait for it before editing the team',
          'launching'
        );
      }
      if (readyRun) {
        if (running) {
          throw new TeamProjectContextLaunchConflictError(
            'This team is running in more than one project; stop the extra runtimes before editing'
          );
        }
        running = { executionTeamName: name, runId: state.runId! };
        continue;
      }
      if (!isConfirmedStoppedTeamRuntime(state)) {
        throw new TeamProjectContextLaunchConflictError(
          isStoppedTeamRuntime(state)
            ? // A stopped run that is still tracked: stopping again changes nothing.
              'A run of this team in a project has stopped but is not released yet. ' +
                'Open the team in that project in the app so it is reconciled, then edit the team'
            : 'This team is running in a project; stop it in every project before editing the team'
        );
      }
    }
    return running;
  }

  async assertOtherContextsStopped(
    logicalTeamName: string,
    targetExecutionTeamName: string
  ): Promise<void> {
    const all = await this.contexts.list(logicalTeamName);
    const others = [
      logicalTeamName,
      ...all
        .filter((context) => context.executionTeamName !== targetExecutionTeamName)
        .map((context) => {
          if (context.state !== 'ready') {
            throw new TeamProjectContextLaunchConflictError(
              'Another project context is not yet reconciled; finish or stop it first'
            );
          }
          return context.executionTeamName;
        }),
    ];
    for (const name of others) {
      if (name === targetExecutionTeamName) continue;
      if (this.runtime.hasProvisioningRun(name)) {
        throw new TeamProjectContextLaunchConflictError(
          'Another project context is still launching or stopping'
        );
      }
      const state = await this.runtime.getRuntimeState(name);
      if (!isConfirmedStoppedTeamRuntime(state)) {
        throw new TeamProjectContextLaunchConflictError(
          'This team is running or has unresolved runtime ownership in another project'
        );
      }
    }
  }
}
