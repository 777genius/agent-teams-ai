import { FatalTeamTaskLogWorkerFailure } from '../../../../core/application/errors/FatalTeamTaskLogWorkerFailure';

import type { TeamRuntimeLoggerPort } from '../../../../core/application/ports/TeamRuntimeOperationPorts';
import type { IpcResult } from '@shared/types';

export async function executeTeamRuntimeOperation<T>(
  logger: TeamRuntimeLoggerPort,
  operation: string,
  action: () => Promise<T> | T
): Promise<IpcResult<T>> {
  try {
    return { success: true, data: await action() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof FatalTeamTaskLogWorkerFailure)) {
      logger.error(`[teams:${operation}] ${message}`);
    }
    return { success: false, error: message };
  }
}
