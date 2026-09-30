import {
  createOperationCorrelationContext,
  type OperationCorrelationContext,
  parseDiagnosticId,
  propagateOperationCorrelation,
} from '../../contracts';

import type { DiagnosticIdGeneratorPort } from './ports';

/** Adds one opaque diagnostic ID and preserves it on every downstream propagation. */
export class DiagnosticContextService {
  constructor(private readonly generator: DiagnosticIdGeneratorPort) {}

  ensureDiagnosticId(correlation: OperationCorrelationContext): OperationCorrelationContext {
    const normalized = createOperationCorrelationContext(correlation);
    if (normalized.diagnosticId !== undefined) return normalized;

    const diagnosticId = parseDiagnosticId(this.generator.generateDiagnosticId());
    return propagateOperationCorrelation(normalized, { diagnosticId });
  }
}
