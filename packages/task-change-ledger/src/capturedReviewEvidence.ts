import type { EvidenceEvent } from './ledgerTypes.js';

/** Host-only return metadata. Never copy it into a renderer/transport change-set DTO. */
export interface CapturedReviewEvidence {
  readonly eventId: string;
  readonly filePath: string;
  readonly actorId?: string;
  readonly taskId?: string;
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly workspaceRoot: string;
  readonly evidenceProof?: string;
  /** The Host validates its own original binding against persisted Runtime/Team records. */
  readonly causalBinding: unknown;
}
export interface ChangesWithEvidence<T> {
  readonly changes: T;
  readonly evidence: readonly CapturedReviewEvidence[];
}
/** Project the same already parsed, scope-filtered rows; no second I/O/parser or path authority. */
export function projectCapturedReviewEvidence(events: readonly EvidenceEvent[]): CapturedReviewEvidence[] {
  return events.flatMap(event => {
    if (!('causalBinding' in event)) return [];
    return [{ eventId: event.eventId, filePath: event.filePath,
      ...(event.agentId ? { actorId: event.agentId } : {}),
      ...('taskId' in event ? { taskId: event.taskId } : {}),
      sessionId: event.sessionId, toolUseId: event.toolUseId, workspaceRoot: event.workspaceRoot,
      ...(event.evidenceProof ? { evidenceProof: event.evidenceProof } : {}),
      causalBinding: structuredClone(event.causalBinding) }];
  });
}
