import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';
import type { TeamRuntimeState } from '@shared/types';

type ContextRegistry = {
  list(logicalTeamName: string): Promise<readonly Pick<
    PersistedTeamWorkContext, 'executionTeamName' | 'state'
  >[]>;
};

type RuntimeStateReader = {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  hasProvisioningRun(teamName: string): boolean;
};

export class TeamProjectContextLaunchConflictError extends Error {
  readonly code = 'TEAM_PROJECT_CONTEXT_RUNNING';
}

function confirmedStopped(state: TeamRuntimeState): boolean {
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
      if (!confirmedStopped(state)) {
        throw new TeamProjectContextLaunchConflictError(
          'This team is running or has unresolved runtime ownership in another project'
        );
      }
    }
  }
}
