import { healStaleIncarnationStatuses } from './memberWorkSyncStaleIncarnationHeal';

import type { StaleIncarnationHealInput } from './memberWorkSyncStaleIncarnationHeal';

/** Runs inside the caller's lifecycle fence and replica mutex; never retries a prepared action. */
export async function withMemberWorkSyncPreparationHeal<T>(
  attempt: () => Promise<T>,
  canHeal: () => boolean,
  input: Omit<StaleIncarnationHealInput, 'error'>
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    // Evaluate after failure: the attempt may already have prepared or executed the action.
    if (!canHeal() || (await healStaleIncarnationStatuses({ ...input, error })) !== 'healed')
      throw error;
  }
  // Exactly one retry, outside the catch, even if the mismatch survives healing.
  return attempt();
}
