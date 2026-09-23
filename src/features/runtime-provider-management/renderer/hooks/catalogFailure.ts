import { cleanRuntimeDiagnosticText } from '../../contracts';
import { type OpenCodeCatalogFailureClassificationInput } from '../../core/domain/openCodeCatalogFailure';

import type {
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderManagementErrorDto,
} from '../../contracts';

export interface OpenCodeCatalogFailure extends OpenCodeCatalogFailureClassificationInput {
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
    errorCode: error.code,
    timedOut: error.diagnostics?.timedOut,
    diagnostics: error.diagnostics,
  });
}

export function withCatalogProviderContext(
  failure: OpenCodeCatalogFailure,
  entry:
    | Pick<RuntimeProviderDirectoryEntryDto, 'displayName' | 'authMethods' | 'connectedAuthHint'>
    | undefined
): OpenCodeCatalogFailure {
  return {
    ...failure,
    displayName: entry?.displayName ?? failure.displayName,
    authMethods: entry?.authMethods ?? failure.authMethods,
    connectedAuthHint: entry?.connectedAuthHint ?? failure.connectedAuthHint,
  };
}
