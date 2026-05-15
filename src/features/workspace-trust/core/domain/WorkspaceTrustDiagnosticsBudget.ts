import type {
  WorkspaceTrustDiagnosticsManifest,
  WorkspaceTrustDiagnosticStrategyResult,
} from './WorkspaceTrustTypes';

export interface WorkspaceTrustDiagnosticsBudgetLimits {
  maxStrategyResults: number;
  maxWorkspaceIdsPerResult: number;
  maxEvidencePerResult: number;
  maxEvidenceLength: number;
  maxRawTailLength: number;
}

export const DEFAULT_WORKSPACE_TRUST_DIAGNOSTICS_BUDGET: WorkspaceTrustDiagnosticsBudgetLimits = {
  maxStrategyResults: 20,
  maxWorkspaceIdsPerResult: 20,
  maxEvidencePerResult: 5,
  maxEvidenceLength: 600,
  maxRawTailLength: 8192,
};

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 16))}[truncated]`;
}

function budgetStringArray(
  values: string[] | undefined,
  limit: number,
  maxStringLength?: number
): { values: string[] | undefined; omitted: number } {
  if (!values || values.length === 0) {
    return { values: undefined, omitted: 0 };
  }
  const limited = values.slice(0, limit);
  const mapped =
    typeof maxStringLength === 'number'
      ? limited.map((value) => truncate(value, maxStringLength))
      : limited;
  return { values: mapped, omitted: Math.max(0, values.length - limited.length) };
}

export function budgetWorkspaceTrustDiagnosticsManifest(
  manifest: WorkspaceTrustDiagnosticsManifest,
  limits: Partial<WorkspaceTrustDiagnosticsBudgetLimits> = {}
): WorkspaceTrustDiagnosticsManifest {
  const effectiveLimits = {
    ...DEFAULT_WORKSPACE_TRUST_DIAGNOSTICS_BUDGET,
    ...limits,
  };
  const omittedCounts: Record<string, number> = { ...(manifest.omittedCounts ?? {}) };
  const results = manifest.strategyResults.slice(0, effectiveLimits.maxStrategyResults);

  const strategyResultOmitted = manifest.strategyResults.length - results.length;
  if (strategyResultOmitted > 0) {
    omittedCounts.strategyResults = (omittedCounts.strategyResults ?? 0) + strategyResultOmitted;
  }

  const budgetedResults: WorkspaceTrustDiagnosticStrategyResult[] = results.map((result) => {
    const workspaceIds = budgetStringArray(
      result.workspaceIds,
      effectiveLimits.maxWorkspaceIdsPerResult
    );
    if (workspaceIds.omitted > 0) {
      omittedCounts.workspaceIds = (omittedCounts.workspaceIds ?? 0) + workspaceIds.omitted;
    }

    const evidence = budgetStringArray(
      result.evidence,
      effectiveLimits.maxEvidencePerResult,
      effectiveLimits.maxEvidenceLength
    );
    if (evidence.omitted > 0) {
      omittedCounts.evidence = (omittedCounts.evidence ?? 0) + evidence.omitted;
    }

    return {
      ...result,
      workspaceIds: workspaceIds.values ?? [],
      evidence: evidence.values,
      rawTail:
        typeof result.rawTail === 'string'
          ? truncate(result.rawTail, effectiveLimits.maxRawTailLength)
          : undefined,
    };
  });

  return {
    ...manifest,
    strategyResults: budgetedResults,
    omittedCounts: Object.keys(omittedCounts).length > 0 ? omittedCounts : undefined,
  };
}
