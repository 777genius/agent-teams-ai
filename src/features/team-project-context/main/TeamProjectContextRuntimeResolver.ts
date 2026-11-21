import { readTeamProjectContextMode } from './projectContextMode';

import type { TeamModeMetaReader } from './projectContextMode';
import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';
import type { TeamProjectContextRegistry } from './TeamProjectContextRegistry';
import type { TeamProjectContextMode } from '@shared/types';

export interface TeamWorkContextAddress {
  logicalTeamName: string;
  /** Required only in per-project mode. */
  projectPath?: string;
}

export interface ResolvedTeamWorkContext {
  logicalTeamName: string;
  executionTeamName: string;
  mode: TeamProjectContextMode;
  workContextId?: string;
  projectPath?: string;
  /** Reservation does not authorize reads or writes to physical storage. */
  state: 'ready' | 'reserved';
}

type ContextRegistry = Pick<TeamProjectContextRegistry, 'find' | 'reserve' | 'confirmReady' | 'releaseUnusedReservation'>;

function physical(logicalTeamName: string, context: PersistedTeamWorkContext): ResolvedTeamWorkContext {
  return {
    logicalTeamName,
    executionTeamName: context.executionTeamName,
    workContextId: context.id,
    projectPath: context.projectPath,
    state: context.state,
    mode: 'per_project',
  };
}

/**
 * Resolve logical identities at the application boundary; native controllers,
 * task stores and message stores continue to operate on a physical team name.
 */
export class TeamProjectContextRuntimeResolver {
  constructor(
    private readonly metaReader: TeamModeMetaReader,
    private readonly registry: ContextRegistry
  ) {}

  getMode(teamName: string): Promise<TeamProjectContextMode> {
    return readTeamProjectContextMode(this.metaReader, teamName);
  }

  private requireProjectPath(address: TeamWorkContextAddress): string {
    if (!address.projectPath?.trim()) {
      throw new Error('Select a project for this team');
    }
    return address.projectPath;
  }

  /** Never creates context artifacts. A null result means a new project has no history. */
  async forRead(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext | null> {
    const mode = await this.getMode(address.logicalTeamName);
    if (mode === 'shared') {
      return {
        logicalTeamName: address.logicalTeamName,
        executionTeamName: address.logicalTeamName,
        state: 'ready',
        mode,
      };
    }
    const context = await this.registry.find(
      address.logicalTeamName,
      this.requireProjectPath(address)
    );
    return context ? physical(address.logicalTeamName, context) : null;
  }

  /**
   * Reserve a physical team name for a new run. A caller must still verify
   * other contexts are stopped, provision through the existing runtime path,
   * then confirm readiness from real native evidence.
   */
  async reserveForProvisioning(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext> {
    const mode = await this.getMode(address.logicalTeamName);
    if (mode === 'shared') {
      return {
        logicalTeamName: address.logicalTeamName,
        executionTeamName: address.logicalTeamName,
        state: 'ready',
        mode,
      };
    }
    const reserved = await this.registry.reserve(
      address.logicalTeamName,
      this.requireProjectPath(address)
    );
    return physical(address.logicalTeamName, reserved);
  }

  /**
   * Only the draft-failure path may discard a reservation, and only when
   * its physical files were never created. Safe no-op for ready contexts.
   */
  releaseUnusedReservation(
    logicalTeamName: string,
    executionTeamName: string,
    expectedContextId: string
  ): Promise<boolean> {
    return this.registry.releaseUnusedReservation(
      logicalTeamName, executionTeamName, expectedContextId
    );
  }

  async confirmProvisionedContext(
    address: TeamWorkContextAddress,
    executionTeamName: string
  ): Promise<ResolvedTeamWorkContext> {
    const mode = await this.getMode(address.logicalTeamName);
    if (mode !== 'per_project') throw new Error('Shared teams have no project context to confirm');
    const confirmed = await this.registry.confirmReady(
      address.logicalTeamName,
      this.requireProjectPath(address),
      executionTeamName
    );
    return physical(address.logicalTeamName, confirmed);
  }
}
