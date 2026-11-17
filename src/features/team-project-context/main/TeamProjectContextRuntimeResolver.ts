import { parsePersistedTeamProjectContextMode } from '../core';
import type { TeamProjectContextRegistry } from './TeamProjectContextRegistry';

import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';
import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
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

interface TeamMetaReader {
  getMeta(teamName: string): Promise<TeamMetaFile | null>;
}

type ContextRegistry = Pick<TeamProjectContextRegistry, 'find' | 'reserve' | 'confirmReady'>;

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
    private readonly metaReader: TeamMetaReader,
    private readonly registry: ContextRegistry
  ) {}

  private async getMode(teamName: string): Promise<TeamProjectContextMode> {
    const meta = await this.metaReader.getMeta(teamName);
    return parsePersistedTeamProjectContextMode(
      meta?.projectContextMode,
      meta !== null && Object.hasOwn(meta, 'projectContextMode')
    );
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
