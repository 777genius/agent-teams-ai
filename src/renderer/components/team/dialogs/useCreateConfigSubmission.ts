import { useCallback, useEffect, useRef } from 'react';

import { api } from '@renderer/api';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { TeamCreateConfigRequest } from '@shared/types/team';

/** One original save intent per open form. No product data/outcomes are cached here. */
export function useCreateConfigSubmission(open: boolean) {
  const submitted = useRef<{ signature: string; commandId: string } | null>(null);
  useEffect(() => {
    if (!open) submitted.current = null;
  }, [open]);
  return useCallback(async (raw: TeamCreateConfigRequest) => {
    const request = structuredClone(raw),
      signature = JSON.stringify(request);
    const epoch = captureContextScopedRequestEpoch();
    if (submitted.current && submitted.current.signature !== signature)
      throw new Error(
        'Previous save result is uncertain. Refresh the team list or reopen the form.'
      );
    const intent = submitted.current ?? { signature, commandId: crypto.randomUUID() };
    submitted.current = intent;
    const result = await api.teams.createConfig({
      ...request,
      command: { commandId: intent.commandId, idempotencyKey: intent.commandId },
    });
    if (!isContextScopedRequestEpochCurrent(epoch))
      throw new Error('Team context changed after save.');
    return result;
  }, []);
}
