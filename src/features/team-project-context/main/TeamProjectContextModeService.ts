import { parsePersistedTeamProjectContextMode } from '../core';

import { TeamProjectContextLaunchGate } from './TeamProjectContextLaunchGate';

import type { TeamProjectContextMode, TeamRuntimeState } from '@shared/types';

interface TeamMetadata {
  projectContextMode?: TeamProjectContextMode;
  deletedAt?: string;
}

export interface TeamProjectContextModePorts {
  getMeta(teamName: string): Promise<TeamMetadata | null>;
  metadataFileExists(teamName: string): Promise<boolean>;
  updateMode(teamName: string, mode: TeamProjectContextMode): Promise<void>;
  withLogicalTeamLock<T>(teamName: string, command: () => Promise<T>): Promise<T>;
  assertProfileOwnedForModeChange(teamName: string): Promise<void>;
  listContexts(teamName: string): Promise<readonly {
    executionTeamName: string;
    state: 'reserved' | 'ready';
  }[]>;
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  hasProvisioningRun(teamName: string): boolean;
  hasActiveSchedules(teamNames: readonly string[]): Promise<boolean>;
}

/**
 * Switching policy affects only the routing of NEW work, never existing
 * tasks/messages/sessions. Both old shared and project histories stay on disk.
 */
export async function changeTeamProjectContextMode(
  teamName: string,
  nextMode: TeamProjectContextMode,
  ports: TeamProjectContextModePorts
): Promise<void> {
  if (nextMode !== 'shared' && nextMode !== 'per_project') {
    throw new Error('Invalid project history mode');
  }
  await ports.withLogicalTeamLock(teamName, async () => {
    const meta = await ports.getMeta(teamName);
    if (!meta) {
      throw new Error(
        await ports.metadataFileExists(teamName)
          ? 'Team metadata is unreadable'
          : 'Team metadata is missing; launch and stop the legacy team before changing its mode'
      );
    }
    if (meta.deletedAt) throw new Error('TEAM_TRASHED: Restore the team before editing');
    const current = parsePersistedTeamProjectContextMode(
      meta.projectContextMode,
      Object.hasOwn(meta, 'projectContextMode')
    );
    if (current === nextMode) return;

    if (ports.hasProvisioningRun(teamName)) {
      throw new Error('Stop the team before changing project history mode');
    }
    const currentRun = await ports.getRuntimeState(teamName);
    if (currentRun.isAlive || currentRun.runId !== null ||
        currentRun.progress?.state === 'disconnected') {
      throw new Error('Stop the team before changing project history mode');
    }

    // A legacy shared team may have no marker until first explicit launch.
    // A mode switch is an explicit owner action; refuse known foreign owners.
    await ports.assertProfileOwnedForModeChange(teamName);
    const registry = {
      list: (name: string) => ports.listContexts(name),
    };
    const gate = new TeamProjectContextLaunchGate(registry, {
      getRuntimeState: (name) => ports.getRuntimeState(name),
      hasProvisioningRun: (name) => ports.hasProvisioningRun(name),
    });
    await gate.assertOtherContextsStopped(teamName, '__no_active_target__');
    const contexts = await ports.listContexts(teamName);
    if (await ports.hasActiveSchedules([
      teamName, ...contexts.map((row) => row.executionTeamName),
    ])) {
      throw new Error('Pause active team schedules before changing project history mode');
    }
    await ports.updateMode(teamName, nextMode);
  });
}
