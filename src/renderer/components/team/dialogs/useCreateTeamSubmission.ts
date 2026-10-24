import { useCallback, useRef } from 'react';

import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { createdTeamSelectionSignature } from '@shared/utils/createdTeamReadiness';

import type { TeamCreateRequest } from '@shared/types/team';

/** An uncertain Create keeps its original command across proof renewal and form reopening. */
export function useCreateTeamSubmission() {
  const owner = useStore((state) =>
    JSON.stringify([
      state.activeContextId,
      state.targetContextId,
      state.connectionMode,
      state.connectedHost,
      state.appConfig?.general?.claudeRootPath,
    ])
  );
  const submitted = useRef<{ signature: string; commandId: string } | null>(null);
  return useCallback(
    async <T>(
      raw: TeamCreateRequest,
      create: (request: TeamCreateRequest) => Promise<T>
    ): Promise<T> => {
      const request = structuredClone(raw);
      const signature = JSON.stringify([owner, createdTeamSelectionSignature(request)]);
      if (submitted.current && submitted.current.signature !== signature)
        throw new Error(
          'Previous Create result is uncertain. Resolve the original team before changing this draft.'
        );
      const intent = submitted.current ?? { signature, commandId: crypto.randomUUID() };
      submitted.current = intent;
      const epoch = captureContextScopedRequestEpoch();
      const result = await create({
        ...request,
        command: { commandId: intent.commandId, idempotencyKey: intent.commandId },
      });
      if (!isContextScopedRequestEpochCurrent(epoch))
        throw new Error('Team context changed after Create.');
      submitted.current = null;
      return result;
    },
    [owner]
  );
}
