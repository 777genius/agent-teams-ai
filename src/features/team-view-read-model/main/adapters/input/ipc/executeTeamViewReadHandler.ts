import type { TeamViewReadModelIpcDependencies } from './TeamViewReadModelIpcDependencies';
import type { IpcResult } from '@shared/types';

export async function executeTeamViewReadHandler<T>(
  dependencies: TeamViewReadModelIpcDependencies,
  operation: string,
  handler: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    return { success: true, data: await handler() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.logger.error(`[teams:${operation}] ${message}`);
    return { success: false, error: message };
  }
}
