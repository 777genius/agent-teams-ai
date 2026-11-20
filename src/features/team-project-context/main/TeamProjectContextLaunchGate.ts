import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';
import type { TeamRuntimeState } from '@shared/types';

interface ContextRegistry {
  list(logicalTeamName: string): Promise<readonly Pick<
    PersistedTeamWorkContext, 'executionTeamName' | 'state'
  >[]>;
}

interface RuntimeStateReader {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  hasProvisioningRun(teamName: string): boolean;
}

export class TeamProjectContextLaunchConflictError extends Error {
  readonly code = 'TEAM_PROJECT_CONTEXT_RUNNING';
}

export function isConfirmedStoppedTeamRuntime(state: TeamRuntimeState): boolean {
  // A stale "disconnected" or "ready" progress is not proof a process
  // stopped. Retained secondaries and unknown run owners must fail closed.
  if (state.isAlive || state.runId !== null) return false;
  return state.progress === null ||
    state.progress.state === 'failed' ||
    state.progress.state === 'cancelled';
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
    const all = await this.contexts.list(logicalTeamName);
    if (all.some((context) => context.state !== 'ready')) {
      throw new TeamProjectContextLaunchConflictError(
        'A project of this team is still being prepared, or its last start was interrupted. '
          + 'Open that project and launch the team there again so it can finish, then edit the team'
      );
    }
    for (const name of [logicalTeamName, ...all.map((context) => context.executionTeamName)]) {
      if (this.runtime.hasProvisioningRun(name)) {
        throw new TeamProjectContextLaunchConflictError(
          'This team is still launching or stopping in a project; wait for it before editing the team'
        );
      }
      if (!isConfirmedStoppedTeamRuntime(await this.runtime.getRuntimeState(name))) {
        throw new TeamProjectContextLaunchConflictError(
          'This team is running in a project; stop it in every project before editing the team'
        );
      }
    }
  }

  async assertOtherContextsStopped(
    logicalTeamName: string,
    targetExecutionTeamName: string
  ): Promise<void> {
    const all = await this.contexts.list(logicalTeamName);
    const others = [
      logicalTeamName,
      ...all.filter((context) => context.executionTeamName !== targetExecutionTeamName)
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
