import { parseHostedTaskCommandId, parseHostedTaskIdempotencyKey } from '../../contracts/hosted';

export function hostedMutationNonce(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid.length > 0) return uuid;
  } catch {
    // Process-local fallback only.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function hostedMutationIdentity() {
  const nonce = hostedMutationNonce();
  return Object.freeze({
    commandId: parseHostedTaskCommandId(`command_${nonce}`),
    idempotencyKey: parseHostedTaskIdempotencyKey(`mutation_${nonce}`),
  });
}
