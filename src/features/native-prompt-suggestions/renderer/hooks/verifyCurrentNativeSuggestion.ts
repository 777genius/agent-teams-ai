import { parseHostTeamSelectionKey } from '@features/agent-backend/contracts/teamSelection';

import type { AgentBackendApi } from '@features/agent-backend/contracts/operations';
import type { NativeNextPromptCandidate } from '../../contracts';

/**
 * Acceptance-time read of the original captured Runtime. The candidate is
 * never its own freshness proof. No new store, queue, or model request.
 */
export async function verifyCurrentNativeSuggestion(
  candidate: NativeNextPromptCandidate,
  backend: Pick<AgentBackendApi, 'getConnections' | 'invoke'> | undefined
): Promise<boolean> {
  if (!backend || typeof candidate.inputId !== 'string' ||
      candidate.inputId.length === 0 || candidate.inputId.length > 256 ||
      typeof candidate.operationRef !== 'string' ||
      candidate.operationRef.length === 0 || candidate.operationRef.length > 256) return false;
  try {
    const handleId = parseHostTeamSelectionKey(candidate.ownerHandle);
    const currentConnection = async (): Promise<boolean> => {
      const state = await backend.getConnections();
      return state.state === 'ready' &&
        state.bindings.filter(binding =>
          binding.handle.handleId === handleId &&
          binding.members.some(member => member.memberId === candidate.memberId)
        ).length === 1;
    };
    if (!await currentConnection()) return false;
    const result = await backend.invoke({
      handle: { handleId },
      commandId: crypto.randomUUID(),
      operation: 'runtime.read',
      payload: {
        memberId: candidate.memberId, expectedGeneration: candidate.generation,
        nativePromptProof: { inputId: candidate.inputId, operationRef: candidate.operationRef },
      },
    });
    if (!result.ok || !result.value ||
        typeof result.value !== 'object' || Array.isArray(result.value)) return false;
    const state = result.value as Record<string, unknown>;
    if (state.memberId !== candidate.memberId ||
        state.generation !== candidate.generation ||
        state.phase !== 'allocated' || state.sealed !== false ||
        state.custody !== 'owned' || state.nativeReady !== true ||
        state.nativePromptCurrent !== true ||
        state.attached !== true || !Array.isArray(state.inputs) ||
        state.inputs.length > 2048) return false;
    const rows = state.inputs as unknown[];
    const index = rows.findIndex(row => row !== null && typeof row === 'object' &&
      (row as Record<string, unknown>).inputId === candidate.inputId);
    if (index < 0 || rows.filter(row => row !== null && typeof row === 'object' &&
      (row as Record<string, unknown>).inputId === candidate.inputId).length !== 1) return false;
    const original = rows[index] as Record<string, unknown>;
    if (original.phase !== 'terminal' || original.terminal !== 'succeeded') return false;
    for (const row of rows.slice(index + 1)) {
      if (!row || typeof row !== 'object') return false;
      const phase = (row as Record<string, unknown>).phase;
      // A never-executed queue record is not a newer native operation.
      if (!['admitted', 'cancelled', 'rejected', 'not-sent'].includes(String(phase)))
        return false;
    }
    // The active descriptor can change while runtime.read is in flight.
    return await currentConnection();
  } catch {
    return false;
  }
}
