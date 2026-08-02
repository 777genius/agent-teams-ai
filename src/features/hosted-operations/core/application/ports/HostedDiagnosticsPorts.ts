import type {
  OperationalReferenceId,
  OperationCorrelationId,
  OperationEventKind,
  OperationOutcome,
} from '../../../contracts';
import type { QueryContext, RequestId } from '@shared/contracts/hosted';

/** Resolves a strict operations ID without narrowing the public QueryContext request-ID grammar. */
export interface HostedDiagnosticsCorrelationIdPort {
  resolveCorrelationId(requestId: RequestId): OperationCorrelationId;
}

/** Server-owned wall-clock scheduling used to enforce the authenticated query deadline. */
export interface HostedDiagnosticsDeadlineSchedulerPort {
  nowMs(): number;
  schedule(delayMs: number, onDeadline: () => void): () => void;
}

export interface HostedDiagnosticsSourceRecord {
  readonly kind: OperationEventKind;
  readonly outcome: OperationOutcome;
  readonly occurredAtMonotonicMs: number;
  /** Untrusted operational metadata; the use case applies the fixed hosted-operations allowlist. */
  readonly attributes: unknown;
}

export interface HostedDiagnosticsSourceResult {
  readonly value: HostedDiagnosticsSourceRecord;
  readonly byteLength: number;
}

/** Every reference read is scoped to host-authenticated identity, authority, deadline, and abort. */
export interface HostedDiagnosticsSourcePort {
  load(
    referenceId: OperationalReferenceId,
    context: QueryContext
  ): Promise<HostedDiagnosticsSourceResult>;
}
