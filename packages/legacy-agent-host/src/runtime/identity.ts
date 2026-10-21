import { createHash } from 'node:crypto';
import { RuntimeOwnerError } from './contracts.js';
import type { RuntimeBinding, RuntimeDelivery } from './contracts.js';

export function normalizeBinding(binding: RuntimeBinding): RuntimeBinding {
  const result = {
    backendId: binding.backendId,
    teamId: binding.teamId,
    runId: binding.runId,
    memberId: binding.memberId,
    generation: binding.generation,
  };
  if (
    Object.values(result).some((value) => typeof value !== 'string' || !value || value.length > 256)
  ) {
    throw new RuntimeOwnerError('invalid');
  }
  return result;
}

export function runtimeDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** One canonical receipt/admission fingerprint, independent of Team outbox metadata. */
export function deliveryFingerprint(intent: RuntimeDelivery): string {
  return runtimeDigest({
    binding: normalizeBinding(intent.binding),
    deliveryId: intent.deliveryId,
    inputId: intent.inputId,
    messageId: intent.messageId,
    content: intent.content,
  });
}
