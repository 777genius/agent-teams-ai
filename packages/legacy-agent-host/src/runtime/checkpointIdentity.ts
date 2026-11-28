import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import type { JsonValue } from '../contracts.js';
import type { CheckpointPayload } from './checkpointContracts.js';
import { RuntimeOwnerError } from './contracts.js';
import { normalizeBinding, runtimeDigest } from './identity.js';
import type { RuntimeBinding, RuntimeSessionRecord } from './contracts.js';

export function checkpointFingerprint(
  binding: RuntimeBinding,
  profileId: string,
  config: OpenConfig,
  checkpointId: string
): string {
  return runtimeDigest({ binding: normalizeBinding(binding), profileId, config, checkpointId });
}

export function checkpointPayloadDigest(payload: Omit<CheckpointPayload, 'digest'>): string {
  return runtimeDigest(payload);
}

export function completedOperations(
  record: RuntimeSessionRecord
): CheckpointPayload['completedOperations'] {
  return record.inputs
    .filter((input) => input.phase === 'terminal')
    .map((input) => {
      if (!input.terminal) throw new RuntimeOwnerError('hold');
      return {
        inputId: input.intent.inputId,
        operationRef: input.operationRef,
        fingerprint: input.fingerprint,
        outcome: input.terminal,
      };
    });
}

/** No lossy conversion of opaque tokens, class instances, undefined or non-finite numbers. */
export function checkpointJson(value: unknown, seen = new Set<unknown>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new RuntimeOwnerError('hold');
  seen.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, (item) => checkpointJson(item, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new RuntimeOwnerError('hold');
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, checkpointJson(item, seen)])
    );
  } finally {
    seen.delete(value);
  }
}
