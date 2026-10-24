import type { TeamReadFailureMetadata } from '../../contracts';

/** Validate untrusted transport metadata without inferring status from human text. */
export function parseTeamReadFailure(value: unknown): TeamReadFailureMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'recovering':
      if (
        typeof record.retryAt !== 'number' ||
        !Number.isSafeInteger(record.retryAt) ||
        record.retryAt <= 0 ||
        typeof record.recoveryId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(record.recoveryId)
      )
        return undefined;
      return { kind: 'recovering', retryAt: record.retryAt, recoveryId: record.recoveryId };
    case 'busy':
    case 'fatal':
    case 'operation':
    case 'disposed':
      return { kind: record.kind };
    default:
      return undefined;
  }
}
