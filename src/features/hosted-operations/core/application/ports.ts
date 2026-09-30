import type { DiagnosticId, OperationalReferenceId, SafeOperationsEvent } from '../../contracts';

export interface MonotonicClockPort {
  nowMs(): number;
}

export interface DiagnosticIdGeneratorPort {
  generateDiagnosticId(): DiagnosticId;
}

export interface OperationsEventSinkPort {
  write(event: SafeOperationsEvent, context: { readonly signal: AbortSignal }): Promise<void>;
}

export interface ReferenceSourceResult<T> {
  readonly value: T;
  readonly byteLength: number;
}

export interface OperationalReferenceSourcePort<T> {
  load(
    referenceId: OperationalReferenceId,
    context: { readonly signal: AbortSignal }
  ): Promise<ReferenceSourceResult<T>>;
}
