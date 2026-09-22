import type {
  TeamProvisioningPrepareResult,
  TeamProvisioningSupportDiagnostic,
} from '@shared/types';

export type ProviderPrepareCheckStatus = 'ready' | 'notes' | 'failed';

export interface ProviderPrepareDiagnosticsModelResult {
  status: ProviderPrepareCheckStatus;
  line: string;
  warningLine?: string | null;
  experimentalOverrideAvailable?: boolean;
}

export interface ProviderPrepareDiagnosticsCachedSnapshot {
  status: ProviderPrepareCheckStatus | 'checking';
  details: string[];
  completedCount: number;
  totalCount: number;
}

export interface ProviderPrepareDiagnosticsResult {
  status: ProviderPrepareCheckStatus;
  details: string[];
  warnings: string[];
  modelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult>;
  experimentalOverrideAvailable?: boolean;
  supportDiagnostics?: TeamProvisioningSupportDiagnostic[];
}

export function buildReusableProviderPrepareModelResults(
  modelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult>
): Record<string, ProviderPrepareDiagnosticsModelResult> {
  return Object.fromEntries(
    Object.entries(modelResultsById).filter(([, result]) => result.status !== 'notes')
  );
}

export function mergeReusableProviderPrepareModelResults(
  existingModelResultsById:
    | Record<string, ProviderPrepareDiagnosticsModelResult>
    | null
    | undefined,
  modelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult>
): Record<string, ProviderPrepareDiagnosticsModelResult> {
  const mergedModelResultsById = { ...(existingModelResultsById ?? {}) };
  for (const [modelId, result] of Object.entries(modelResultsById)) {
    if (result.status === 'notes') {
      delete mergedModelResultsById[modelId];
      continue;
    }
    mergedModelResultsById[modelId] = result;
  }
  return mergedModelResultsById;
}

export function hasExperimentalLocalModelOverride(
  modelId: string,
  result: TeamProvisioningPrepareResult
): boolean {
  return (result.issues ?? []).some(
    (issue) =>
      issue.scope === 'model' &&
      issue.modelId === modelId &&
      issue.experimentalOverrideAvailable === true
  );
}
