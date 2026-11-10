import { checkpointAvailabilityReasons } from '../../../contracts/checkpoints';

import type { BackendMemberCheckpoints } from '../../../contracts/checkpoints';
import type { BackendOperationRequest } from '../../../contracts/operations';

function invalid(): never {
  throw new Error('Invalid checkpoint availability');
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    return invalid();
  return value;
}
function state(
  value: Record<string, unknown>
): Pick<BackendMemberCheckpoints, 'status' | 'reason'> {
  if (
    !checkpointAvailabilityReasons.includes(value.reason as BackendMemberCheckpoints['reason']) ||
    !['owner-eligible', 'unavailable'].includes(String(value.status)) ||
    (value.status === 'owner-eligible') !== (value.reason === 'native-backing-unverified')
  )
    return invalid();
  return {
    status: value.status as BackendMemberCheckpoints['status'],
    reason: value.reason as BackendMemberCheckpoints['reason'],
  };
}

/** Bound to the caller's exact source generation; native IDs and private payloads are omitted. */
export function projectMemberCheckpoints(
  raw: unknown,
  request: BackendOperationRequest
): BackendMemberCheckpoints {
  if (request.operation !== 'runtime.checkpoints.read') return invalid();
  const source = row(raw);
  if (
    source.memberId !== request.payload.memberId ||
    source.sourceGeneration !== request.payload.expectedGeneration ||
    source.nativeBacking !== 'unverified' ||
    !Array.isArray(source.checkpoints) ||
    source.checkpoints.length > 128
  )
    return invalid();
  const seen = new Set<string>();
  const checkpoints = source.checkpoints.map((value) => {
    const item = row(value),
      checkpointId = text(item.checkpointId),
      reference = text(item.reference);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(checkpointId) ||
      !/^cp1-[a-f0-9]{64}$/.test(reference) ||
      seen.has(reference)
    )
      return invalid();
    seen.add(reference);
    return { checkpointId, reference, ...state(item) };
  });
  const summary = state(source);
  if (
    (summary.status === 'owner-eligible') !==
    checkpoints.some((item) => item.status === 'owner-eligible')
  )
    return invalid();
  return {
    memberId: text(source.memberId),
    sourceGeneration: text(source.sourceGeneration),
    ...summary,
    nativeBacking: 'unverified',
    checkpoints,
  };
}
