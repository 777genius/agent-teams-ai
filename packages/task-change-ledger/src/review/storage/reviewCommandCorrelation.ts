/** Optional original Host command identity; existing Desktop records have no such metadata. */
export interface ReviewCommandCorrelation {
  commandId: string;
  fingerprint: string;
  origin: { taskId?: string; memberName?: string };
}
export function validReviewCommandCorrelation(value: unknown): value is ReviewCommandCorrelation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ReviewCommandCorrelation>;
  if (
    typeof candidate.commandId !== 'string' ||
    !candidate.commandId ||
    candidate.commandId.length > 256 ||
    typeof candidate.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.fingerprint) ||
    !candidate.origin ||
    typeof candidate.origin !== 'object' ||
    Array.isArray(candidate.origin) ||
    (!candidate.origin.taskId && !candidate.origin.memberName)
  )
    return false;
  return [candidate.origin.taskId, candidate.origin.memberName].every(
    (part) =>
      part === undefined ||
      (typeof part === 'string' && !!part && part.length <= 128 && !part.includes('\0'))
  );
}
