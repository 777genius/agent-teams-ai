const OWNER_SESSION_PATTERN = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OWNER_AUTHORITY_PATTERN = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

/** Exclusive practical ceiling; generations at or above it are never admitted or persisted. */
export const HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT = 1_000_000;

export interface HostedLifecycleOwnerHighWaterBinding {
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
}

export function parseOwnerAuthorityMarker(value: unknown): string {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<PropertyKey, unknown>)
      : null;
  if (
    record === null ||
    Reflect.ownKeys(record).length !== 1 ||
    !Object.hasOwn(record, 'ownerAuthority') ||
    typeof record.ownerAuthority !== 'string' ||
    !OWNER_AUTHORITY_PATTERN.test(record.ownerAuthority)
  ) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  return record.ownerAuthority;
}

export function ownerAuthorityPayload(ownerAuthority: string): string {
  return `${JSON.stringify({ ownerAuthority })}\n`;
}

export function assertMarkerPayload(
  value: unknown,
  expectedGeneration: number | null
): Readonly<{ ownerSessionId: string; generation: number }> {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<PropertyKey, unknown>)
      : null;
  if (
    record === null ||
    Reflect.ownKeys(record).length !== 2 ||
    !Object.hasOwn(record, 'ownerSessionId') ||
    !Object.hasOwn(record, 'generation') ||
    typeof record.ownerSessionId !== 'string' ||
    !OWNER_SESSION_PATTERN.test(record.ownerSessionId) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    (record.generation as number) >= HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT ||
    (expectedGeneration !== null && record.generation !== expectedGeneration)
  ) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  return Object.freeze({
    ownerSessionId: record.ownerSessionId,
    generation: record.generation as number,
  });
}

export function markerPayload(binding: HostedLifecycleOwnerHighWaterBinding): string {
  return `${JSON.stringify({
    ownerSessionId: binding.ownerSessionId,
    generation: binding.ownerGeneration,
  })}\n`;
}

export function assertBinding(binding: HostedLifecycleOwnerHighWaterBinding): void {
  if (
    !OWNER_AUTHORITY_PATTERN.test(binding.ownerAuthority) ||
    !Number.isSafeInteger(binding.ownerGeneration) ||
    binding.ownerGeneration < 1 ||
    binding.ownerGeneration >= HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT ||
    !OWNER_SESSION_PATTERN.test(binding.ownerSessionId)
  ) {
    throw new TypeError('hosted-lifecycle-orchestrator-owner-binding-invalid');
  }
}
