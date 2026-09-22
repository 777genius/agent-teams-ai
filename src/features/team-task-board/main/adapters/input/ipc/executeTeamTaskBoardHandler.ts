import type { TeamTaskBoardLoggerPort } from '../../../../core/application/ports/TeamTaskBoardPorts';
import type { IpcResult } from '@shared/types';

export async function executeTeamTaskBoardHandler<T>(
  logger: Pick<TeamTaskBoardLoggerPort, 'error'>,
  operation: string,
  handler: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    return { success: true, data: await handler() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[teams:${operation}] ${message}`);
    return { success: false, error: message };
  }
}
