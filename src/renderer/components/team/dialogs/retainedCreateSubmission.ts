import { TeamCreationRefusal } from '@features/agent-backend/contracts';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { IpcError } from '@renderer/utils/unwrapIpc';
import { createdTeamSelectionSignature } from '@shared/utils/createdTeamReadiness';

import type { TeamCreateConfigRequest, TeamCreateRequest } from '@shared/types/team';

// The application has one Create form. Keep its single unresolved intent across dialog/tab
// unmounts; neither closing the form nor changing operation/owner frees another Create slot.
let submitted: { signature: string; commandId: string; inFlight: boolean } | null = null;

function currentOwner(): string | null {
  const state = useStore.getState();
  return state.isContextSwitching
    ? null
    : JSON.stringify([
        state.activeContextId,
        state.targetContextId,
        state.connectionMode,
        state.connectedHost,
        state.appConfig?.general?.claudeRootPath,
      ]);
}

export async function submitRetainedCreate<
  TRequest extends TeamCreateRequest | TeamCreateConfigRequest,
  T,
>(kind: 'launch' | 'config', raw: TRequest, create: (request: TRequest) => Promise<T>): Promise<T> {
  const owner = currentOwner();
  if (owner === null) throw new Error('Team context is switching. Wait before retrying Create.');
  const request = structuredClone(raw);
  // This shared wire-normalized signature also accepts save-only's optional cwd; it is not validation.
  const signature = JSON.stringify([
    owner,
    kind,
    createdTeamSelectionSignature(request as TeamCreateRequest),
  ]);
  if (submitted && submitted.signature !== signature)
    throw new Error(
      'Previous Create result is uncertain. The single Create slot is held: retry the unchanged draft at its original owner and operation.'
    );
  if (submitted?.inFlight)
    throw new Error('Previous Create is still pending. Wait for its result.');
  const intent = submitted ?? { signature, commandId: crypto.randomUUID(), inFlight: false };
  submitted = intent;
  intent.inFlight = true;
  const epoch = captureContextScopedRequestEpoch();
  try {
    const result = await create({
      ...request,
      command: { commandId: intent.commandId, idempotencyKey: intent.commandId },
    });
    if (!isContextScopedRequestEpochCurrent(epoch) || currentOwner() !== owner)
      throw new Error('Team context changed after Create. Original result remains uncertain.');
    if (submitted === intent) submitted = null;
    return result;
  } catch (error) {
    const refusal = error instanceof IpcError ? error.causeError : error;
    if (
      kind === 'launch' &&
      refusal instanceof TeamCreationRefusal &&
      isContextScopedRequestEpochCurrent(epoch) &&
      currentOwner() === owner &&
      submitted === intent
    )
      submitted = null;
    throw error;
  } finally {
    intent.inFlight = false;
  }
}

export function __resetRetainedCreateSubmissionForTests(): void {
  submitted = null;
}
