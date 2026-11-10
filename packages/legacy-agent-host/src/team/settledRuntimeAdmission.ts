import type { DeliveryAdmission } from './contracts.js';

/** Existing Task notification retraction settlement policy; cancellation never means a claimed input was not sent. */
export function settledRuntimeAdmission(proof: DeliveryAdmission): boolean {
  const receipt = proof.receipt;
  return proof.outcome === 'admitted' && !!receipt && typeof receipt === 'object' &&
    !Array.isArray(receipt) && ['not-sent', 'terminal'].includes(String(receipt.phase));
}
