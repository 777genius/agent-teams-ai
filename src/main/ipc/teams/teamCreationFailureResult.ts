import {
  isHostTeamHistoryModeRefusal,
  TeamCreationRefusal,
} from '@features/agent-backend/contracts';

import type { IpcResult } from '@shared/types/ipc';

/** Only proven Create refusals carry this finite correction proof across contextBridge. */
export function teamCreationFailureResult<T>(error: unknown, message: string): IpcResult<T> {
  return {
    success: false,
    error: isHostTeamHistoryModeRefusal(error) ? error.message : message,
    ...(error instanceof TeamCreationRefusal
      ? {
          failure: {
            kind: 'captured-team-create-refusal',
            code: error.code,
            outcome: error.outcome,
          },
        }
      : {}),
  };
}
