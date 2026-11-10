import { validateTeamLifecycleReceipt } from './lifecycleContracts.js';
import type { TeamStore } from './ports.js';
import { TeamOwnerError } from './contracts.js';
import type { OwnerState } from './ownerState.js';

/** A restored product tombstone does not forgive unresolved original Runtime cleanup. */
export function teamExecutionAllowed(state: OwnerState, store: TeamStore): boolean {
  try {
    for (const row of store.list<{ family?: string }>('commands')) {
      if (row.family === 'lifecycle' && validateTeamLifecycleReceipt(row).phase !== 'completed') return false;
    }
  } catch { return false; }
  const value = state.lifecycle;
  if (value === undefined) return true;
  return !!value && typeof value.cleanupCommandId === 'string' && !!value.cleanupCommandId &&
    typeof value.cleanupPending === 'boolean' && value.deletedAt === undefined &&
    value.cleanupPending === false;
}
export function assertTeamExecutionAllowed(state: OwnerState, store: TeamStore): void {
  if (!teamExecutionAllowed(state, store)) throw new TeamOwnerError('hold');
}
