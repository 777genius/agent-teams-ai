import {
  createTeamLifecycleReadIpcAdapter,
  registerTeamLifecycleReadIpcAdapter,
  removeTeamLifecycleReadIpcAdapter,
} from '../adapters/input/ipc/TeamLifecycleReadIpcAdapter';

import type { CanonicalListTeamLifecycleResult } from '../../contracts/team-lifecycle-read';
import type { IpcResult, TeamSummary } from '@shared/types';

export interface TeamLifecycleReadIpcFeatureDependencies {
  readonly legacy: {
    listTeams(): Promise<TeamSummary[]>;
  };
  readonly canonical: {
    listTeamLifecycle(request: unknown): Promise<CanonicalListTeamLifecycleResult>;
  };
  readonly operations: {
    setCurrent(operation: string | null): void;
  };
  readonly clock: {
    now(): number;
  };
  readonly logger: {
    error(message: string): void;
    warn(message: string): void;
  };
}

export interface TeamLifecycleReadIpcFeature {
  handle(
    event: unknown,
    request?: unknown
  ): Promise<IpcResult<TeamSummary[] | CanonicalListTeamLifecycleResult>>;
}

interface TeamLifecycleReadIpcRegistrar {
  handle(
    channel: string,
    handler: (
      event: unknown,
      request?: unknown
    ) => Promise<IpcResult<TeamSummary[] | CanonicalListTeamLifecycleResult>>
  ): void;
  removeHandler(channel: string): void;
}

export function createTeamLifecycleReadIpcFeature(
  dependencies: TeamLifecycleReadIpcFeatureDependencies
): TeamLifecycleReadIpcFeature {
  return createTeamLifecycleReadIpcAdapter(dependencies);
}

export function registerTeamLifecycleReadIpc(
  ipcMain: Pick<TeamLifecycleReadIpcRegistrar, 'handle'>,
  feature: TeamLifecycleReadIpcFeature
): void {
  registerTeamLifecycleReadIpcAdapter(ipcMain, feature);
}

export function removeTeamLifecycleReadIpc(
  ipcMain: Pick<TeamLifecycleReadIpcRegistrar, 'removeHandler'>
): void {
  removeTeamLifecycleReadIpcAdapter(ipcMain);
}
