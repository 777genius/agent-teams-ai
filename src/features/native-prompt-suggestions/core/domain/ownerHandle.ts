import { parseHostTeamSelectionKey } from '@features/agent-backend/contracts/teamSelection';

/**
 * Reuse the canonical Host selection-key contract. A 256-character decoded
 * handle can exceed 512 characters after URI encoding; do not truncate it.
 */
export function isNativePromptOwnerHandle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseHostTeamSelectionKey(value);
    return true;
  } catch {
    return false;
  }
}
