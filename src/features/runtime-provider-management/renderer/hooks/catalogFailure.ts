import { cleanRuntimeDiagnosticText } from '../../contracts';

import type { RuntimeProviderManagementErrorDto } from '../../contracts';

export interface OpenCodeCatalogFailure {
  operation: 'provider_directory' | 'provider_models';
  sourceProviderId: string | null;
  origin: 'main' | 'client_validation' | 'transport' | 'stale';
  message: string;
  diagnostics?: RuntimeProviderManagementErrorDto['diagnostics'];
}

export class CatalogFailureError extends Error {
  constructor(readonly failure: OpenCodeCatalogFailure) {
    super(failure.message);
  }
}

export function catalogFailure(
  operation: OpenCodeCatalogFailure['operation'],
  sourceProviderId: string | null,
  origin: OpenCodeCatalogFailure['origin'],
  error: unknown
): OpenCodeCatalogFailure {
  if (error instanceof CatalogFailureError) return error.failure;
  return {
    operation,
    sourceProviderId,
    origin,
    message:
      cleanRuntimeDiagnosticText(error instanceof Error ? error.message : String(error)) ??
      'Catalog request failed.',
  };
}

export function mainCatalogFailure(
  operation: OpenCodeCatalogFailure['operation'],
  sourceProviderId: string | null,
  error: RuntimeProviderManagementErrorDto
): CatalogFailureError {
  return new CatalogFailureError({
    ...catalogFailure(operation, sourceProviderId, 'main', error.message),
    diagnostics: error.diagnostics,
  });
}
