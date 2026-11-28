import { createHash } from 'node:crypto';
import { validateTeamLifecycleReceipt } from './lifecycleContracts.js';
import type { TeamStore } from './ports.js';
import { TeamOwnerError } from './contracts.js';
import type { OwnerState } from './ownerState.js';

const maxClassificationBytes = 8 * 1024 * 1024;
const maxClassificationEntries = 256;
const classifications = new Map<string, { bytes: Buffer; blocked: boolean }>();
let classificationBytes = 0;

function decodeBlocksExecution(bytes: Uint8Array): boolean {
  const row = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')) as
    { family?: string } | null;
  // Preserve list's raw-JSON truthiness check; a decoded false classification is valid.
  if (!row) throw new TeamOwnerError('hold');
  return row.family === 'lifecycle' && validateTeamLifecycleReceipt(row).phase !== 'completed';
}

/** Only pure receipt classification is reused; every caller still reads all current file bytes. */
function receiptBlocksExecution(bytes: Uint8Array): boolean {
  if (bytes.byteLength > maxClassificationBytes) return decodeBlocksExecution(bytes);
  const key = createHash('sha256').update(bytes).digest('hex');
  const prior = classifications.get(key);
  // The digest only finds a candidate. Exact freshly read bytes establish reuse.
  if (prior?.bytes.equals(bytes)) {
    classifications.delete(key);
    classifications.set(key, prior);
    return prior.blocked;
  }
  // Own the exact bytes being classified without retaining a caller view or pooled slab.
  const owned = Buffer.allocUnsafeSlow(bytes.byteLength);
  owned.set(bytes);
  const blocked = decodeBlocksExecution(owned);
  if (prior) {
    classifications.delete(key);
    classificationBytes -= prior.bytes.byteLength;
  }
  while (classifications.size >= maxClassificationEntries ||
    classificationBytes + owned.byteLength > maxClassificationBytes) {
    const oldest = classifications.keys().next().value!;
    classificationBytes -= classifications.get(oldest)!.bytes.byteLength;
    classifications.delete(oldest);
  }
  classifications.set(key, { bytes: owned, blocked });
  classificationBytes += owned.byteLength;
  return blocked;
}

/** A restored product tombstone does not forgive unresolved original Runtime cleanup. */
export function teamExecutionAllowed(state: OwnerState, store: TeamStore): boolean {
  try {
    if (store.listDecoded) {
      if (store.listDecoded('commands', receiptBlocksExecution).some(Boolean)) return false;
    } else {
      for (const row of store.list<{ family?: string }>('commands')) {
        if (row.family === 'lifecycle' && validateTeamLifecycleReceipt(row).phase !== 'completed') return false;
      }
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
