import type { RuntimeInput } from './contracts.js';

/** Durable Runtime-owned disposition; claimed or uncertain work remains cleanup debt. */
export function settledRuntimeInput(input: Pick<RuntimeInput, 'phase'>): boolean {
  return input.phase === 'terminal' || input.phase === 'not-sent' ||
    input.phase === 'cancelled' || input.phase === 'rejected';
}
