import type { CanonicalListTeamLifecycleResult } from '../../../../contracts/team-lifecycle-read';
import type { IpcResult, TeamSummary } from '@shared/types';

const TEAM_LIST_CHANNEL = 'team:list';

export interface TeamLifecycleReadIpcLogger {
  error(message: string): void;
  warn(message: string): void;
}

export interface TeamLifecycleReadIpcDependencies {
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
  readonly logger: TeamLifecycleReadIpcLogger;
}

export interface TeamLifecycleReadIpcHandler {
  handle(
    event: unknown,
    request?: unknown
  ): Promise<IpcResult<TeamSummary[] | CanonicalListTeamLifecycleResult>>;
}

export interface TeamLifecycleReadIpcRegistrar {
  handle(
    channel: string,
    handler: (
      event: unknown,
      request?: unknown
    ) => Promise<IpcResult<TeamSummary[] | CanonicalListTeamLifecycleResult>>
  ): void;
  removeHandler(channel: string): void;
}

async function wrapTeamRead<T>(
  dependencies: TeamLifecycleReadIpcDependencies,
  operation: string,
  read: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    return { success: true, data: await read() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.logger.error(`[teams:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

export function createTeamLifecycleReadIpcAdapter(
  dependencies: TeamLifecycleReadIpcDependencies
): TeamLifecycleReadIpcHandler {
  return Object.freeze({
    async handle(
      _event: unknown,
      request?: unknown
    ): Promise<IpcResult<TeamSummary[] | CanonicalListTeamLifecycleResult>> {
      if (request !== undefined) {
        return wrapTeamRead(dependencies, 'listTeamLifecycle', () =>
          dependencies.canonical.listTeamLifecycle(request)
        );
      }

      dependencies.operations.setCurrent('team.lifecycle.list');
      const startedAt = dependencies.clock.now();
      try {
        return await wrapTeamRead(dependencies, 'list', () => dependencies.legacy.listTeams());
      } finally {
        const elapsedMs = dependencies.clock.now() - startedAt;
        if (elapsedMs >= 1_500) {
          dependencies.logger.warn(`[teams:list] slow ms=${elapsedMs}`);
        }
        dependencies.operations.setCurrent(null);
      }
    },
  });
}

export function registerTeamLifecycleReadIpcAdapter(
  ipcMain: Pick<TeamLifecycleReadIpcRegistrar, 'handle'>,
  handler: TeamLifecycleReadIpcHandler
): void {
  ipcMain.handle(TEAM_LIST_CHANNEL, (event, request) => handler.handle(event, request));
}

export function removeTeamLifecycleReadIpcAdapter(
  ipcMain: Pick<TeamLifecycleReadIpcRegistrar, 'removeHandler'>
): void {
  ipcMain.removeHandler(TEAM_LIST_CHANNEL);
}
