import { getProviderScopedTeamModelLabel } from '@renderer/utils/teamModelCatalog';
import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';

import type {
  TeamProviderId,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
} from '@shared/types';

export type ProviderPrepareCheckStatus = 'ready' | 'notes' | 'failed';

type PrepareProvisioningFn = (
  cwd?: string,
  providerId?: TeamProviderId,
  providerIds?: TeamProviderId[],
  selectedModels?: string[],
  limitContext?: boolean,
  modelVerificationMode?: TeamProvisioningModelVerificationMode
) => Promise<TeamProvisioningPrepareResult>;

interface ProviderPrepareDiagnosticsProgress {
  status: ProviderPrepareCheckStatus | 'checking';
  details: string[];
  completedCount: number;
  totalCount: number;
}

export interface ProviderPrepareDiagnosticsModelResult {
  status: 'ready' | 'notes' | 'failed';
  line: string;
  warningLine?: string | null;
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
}

export function buildReusableProviderPrepareModelResults(
  modelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult>
): Record<string, ProviderPrepareDiagnosticsModelResult> {
  return Object.fromEntries(
    Object.entries(modelResultsById).filter(([, result]) => result.status !== 'notes')
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getModelLabel(providerId: TeamProviderId, modelId: string): string {
  if (isDefaultProviderModelSelection(modelId)) {
    return 'Default';
  }
  return getProviderScopedTeamModelLabel(providerId, modelId) ?? modelId;
}

export function buildProviderPrepareModelCheckingLine(
  providerId: TeamProviderId,
  modelId: string
): string {
  return `${getModelLabel(providerId, modelId)} - checking...`;
}

function buildModelSuccessLine(providerId: TeamProviderId, modelId: string): string {
  return `${getModelLabel(providerId, modelId)} - verified`;
}

function buildModelAvailableLine(providerId: TeamProviderId, modelId: string): string {
  return `${getModelLabel(providerId, modelId)} - available for launch`;
}

function buildModelCompatibilityPendingLine(providerId: TeamProviderId, modelId: string): string {
  return `${getModelLabel(providerId, modelId)} - compatible, deep verification pending...`;
}

export function getProviderPrepareCachedSnapshot({
  providerId,
  selectedModelIds,
  cachedModelResultsById,
}: {
  providerId: TeamProviderId;
  selectedModelIds: string[];
  cachedModelResultsById?: Record<string, ProviderPrepareDiagnosticsModelResult>;
}): ProviderPrepareDiagnosticsCachedSnapshot {
  const reusableModelResultsById = cachedModelResultsById ?? {};
  const orderedModelIds = Array.from(
    new Set(selectedModelIds.map((modelId) => modelId.trim()).filter(Boolean))
  );

  let completedCount = 0;
  let hasFailure = false;
  let hasNotes = false;
  let hasChecking = false;

  const details = orderedModelIds.map((modelId) => {
    const cachedResult = reusableModelResultsById[modelId];
    if (!cachedResult) {
      hasChecking = true;
      return buildProviderPrepareModelCheckingLine(providerId, modelId);
    }

    completedCount += 1;
    if (cachedResult.status === 'failed') {
      hasFailure = true;
    } else if (cachedResult.status === 'notes') {
      hasNotes = true;
    }
    return cachedResult.line;
  });

  return {
    status: hasChecking ? 'checking' : hasFailure ? 'failed' : hasNotes ? 'notes' : 'ready',
    details,
    completedCount,
    totalCount: orderedModelIds.length,
  };
}

function stripSelectedModelPrefix(modelId: string, message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return trimmed;
  }

  const patterns = [
    new RegExp(`^Selected model ${escapeRegExp(modelId)} is unavailable\\.\\s*`, 'i'),
    new RegExp(`^Selected model ${escapeRegExp(modelId)} could not be verified\\.\\s*`, 'i'),
    new RegExp(`^Selected model ${escapeRegExp(modelId)} verified for launch\\.\\s*`, 'i'),
    new RegExp(`^Selected model ${escapeRegExp(modelId)} is available for launch\\.\\s*`, 'i'),
    new RegExp(
      `^Selected model ${escapeRegExp(modelId)} is compatible\\. Deep verification pending\\.\\s*`,
      'i'
    ),
  ];
  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, '').trim();
    }
  }

  return trimmed;
}

function decodeQuotedJsonString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value;
  }
}

function normalizeModelReason(rawReason: string | null | undefined): string | null {
  const trimmed = rawReason?.trim() ?? '';
  if (!trimmed) {
    return null;
  }

  if (
    /The '[^']+' model is not supported when using Codex with a ChatGPT account\./i.test(trimmed)
  ) {
    return 'Not available on this Codex native runtime';
  }
  if (/The requested model is not available for your account\./i.test(trimmed)) {
    return 'Not available for this account';
  }
  if (/token refresh failed:\s*401/i.test(trimmed)) {
    return 'OpenCode provider authentication failed (token refresh 401)';
  }
  if (/unauthorized|forbidden|\b401\b|\b403\b/i.test(trimmed)) {
    return 'OpenCode provider authentication failed';
  }
  if (
    trimmed.toLowerCase().includes('timeout running:') ||
    trimmed.toLowerCase().includes('timed out') ||
    trimmed.toLowerCase().includes('etimedout')
  ) {
    return 'Model verification timed out';
  }

  const detailMatch = /"detail":"((?:\\"|[^"])*)"/i.exec(trimmed);
  if (detailMatch?.[1]) {
    return normalizeModelReason(detailMatch[1].replace(/\\"/g, '"').trim());
  }

  const messageMatch = /"message":"((?:\\"|[^"])*)"/i.exec(trimmed);
  if (messageMatch?.[1]) {
    const decodedMessage = messageMatch[1].replace(/\\"/g, '"');
    const nestedDetailMatch = /"detail":"([^"]+)"/i.exec(decodedMessage);
    if (nestedDetailMatch?.[1]) {
      return normalizeModelReason(nestedDetailMatch[1].trim());
    }
    return normalizeModelReason(decodeQuotedJsonString(decodedMessage).trim());
  }

  return trimmed;
}

function getResultReason(modelId: string, result: TeamProvisioningPrepareResult): string | null {
  const candidates = [...(result.details ?? []), ...(result.warnings ?? []), result.message]
    .map((entry) => entry?.trim() ?? '')
    .filter(Boolean);

  for (const candidate of candidates) {
    const stripped = stripSelectedModelPrefix(modelId, candidate);
    if (stripped) {
      return normalizeModelReason(stripped);
    }
  }

  return null;
}

function getModelScopedEntries(modelId: string, result: TeamProvisioningPrepareResult): string[] {
  const escapedModelId = escapeRegExp(modelId);
  const scopedPattern = new RegExp(`^Selected model ${escapedModelId}\\b`, 'i');
  return [...(result.details ?? []), ...(result.warnings ?? []), result.message]
    .map((entry) => entry?.trim() ?? '')
    .filter(Boolean)
    .filter((entry) => scopedPattern.test(entry));
}

function isModelScopedEntryForAnyModel(modelIds: readonly string[], entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) {
    return false;
  }

  return modelIds.some((modelId) =>
    new RegExp(`^Selected model ${escapeRegExp(modelId)}\\b`, 'i').test(trimmed)
  );
}

function looksLikeSingleModelBatchFailure(
  modelId: string,
  result: TeamProvisioningPrepareResult
): boolean {
  const candidates = [...(result.details ?? []), ...(result.warnings ?? []), result.message]
    .map((entry) => entry?.trim() ?? '')
    .filter(Boolean);
  const modelLower = modelId.toLowerCase();

  return candidates.some((candidate) => {
    const lower = candidate.toLowerCase();
    return (
      lower.includes(modelLower) ||
      lower.includes('requested model') ||
      lower.includes('model is not supported') ||
      lower.includes('model is not available') ||
      lower.includes('selected model')
    );
  });
}

function getScopedModelReason(modelId: string, entries: string[]): string | null {
  for (const entry of entries) {
    const stripped = stripSelectedModelPrefix(modelId, entry);
    if (!stripped) {
      continue;
    }
    const normalized = normalizeModelReason(stripped);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function buildModelFailureLine(
  providerId: TeamProviderId,
  modelId: string,
  kind: 'unavailable' | 'check failed',
  reason: string | null
): string {
  const label = getModelLabel(providerId, modelId);
  return reason ? `${label} - ${kind} - ${reason}` : `${label} - ${kind}`;
}

function createRuntimeDetailLines(result: TeamProvisioningPrepareResult): string[] {
  return [...(result.details ?? []), ...(result.warnings ?? [])];
}

function extractTimedOutPreflightProbeModelId(detail: string): string | null {
  const trimmed = detail.trim();
  if (!trimmed) {
    return null;
  }
  if (
    !trimmed.toLowerCase().includes('preflight check for `') ||
    !trimmed.toLowerCase().includes('-p` did not complete')
  ) {
    return null;
  }
  const match = /--model\s+([^\s]+)/i.exec(trimmed);
  return match?.[1]?.trim() || null;
}

function isSuppressibleGenericPreflightWarning(detail: string): boolean {
  const lower = detail.trim().toLowerCase();
  if (!lower) {
    return false;
  }

  return (
    lower.includes('preflight check failed') ||
    (lower.includes('preflight check for `') && lower.includes('-p` did not complete')) ||
    lower.includes('preflight ping completed but did not return the expected pong')
  );
}

function suppressSupersededRuntimeWarnings(params: {
  runtimeDetailLines: string[];
  runtimeWarnings: string[];
  modelResultsById: Map<string, ProviderPrepareDiagnosticsModelResult>;
}): {
  runtimeDetailLines: string[];
  runtimeWarnings: string[];
} {
  const suppressedEntries = new Set<string>();
  const allSelectedModelsReady =
    params.modelResultsById.size > 0 &&
    Array.from(params.modelResultsById.values()).every((result) => result.status === 'ready');

  for (const warning of params.runtimeWarnings) {
    const probedModelId = extractTimedOutPreflightProbeModelId(warning);
    if (probedModelId) {
      if (params.modelResultsById.get(probedModelId)?.status !== 'ready') {
        continue;
      }
      suppressedEntries.add(warning);
      continue;
    }

    if (allSelectedModelsReady && isSuppressibleGenericPreflightWarning(warning)) {
      suppressedEntries.add(warning);
    }
  }

  return {
    runtimeDetailLines: params.runtimeDetailLines.filter(
      (detail) => !suppressedEntries.has(detail)
    ),
    runtimeWarnings: params.runtimeWarnings.filter((warning) => !suppressedEntries.has(warning)),
  };
}

function getProgressStatus(params: {
  completedCount: number;
  totalCount: number;
  runtimeWarnings: string[];
  modelResultsById: Map<string, ProviderPrepareDiagnosticsModelResult>;
}): ProviderPrepareCheckStatus | 'checking' {
  if (params.completedCount < params.totalCount) {
    return 'checking';
  }
  if (Array.from(params.modelResultsById.values()).some((result) => result.status === 'failed')) {
    return 'failed';
  }
  if (
    params.runtimeWarnings.length > 0 ||
    Array.from(params.modelResultsById.values()).some((result) => result.status === 'notes')
  ) {
    return 'notes';
  }
  return 'ready';
}

function resolveModelResultFromBatch(
  providerId: TeamProviderId,
  modelId: string,
  result: TeamProvisioningPrepareResult,
  isOnlyModel: boolean
): ProviderPrepareDiagnosticsModelResult {
  const modelScopedEntries = getModelScopedEntries(modelId, result);
  const hasModelScopedEntries = modelScopedEntries.length > 0;
  const scopedReason = getScopedModelReason(modelId, modelScopedEntries);
  const fallbackBatchReason = isOnlyModel
    ? (getResultReason(modelId, result) ?? normalizeModelReason(result.message))
    : null;

  const hasVerifiedLine = modelScopedEntries.some((entry) =>
    /selected model .* verified for launch\./i.test(entry)
  );
  if (hasVerifiedLine) {
    return {
      status: 'ready',
      line: buildModelSuccessLine(providerId, modelId),
      warningLine: null,
    };
  }

  const hasAvailableLine = modelScopedEntries.some((entry) =>
    /selected model .* is available for launch\./i.test(entry)
  );
  if (hasAvailableLine) {
    return {
      status: 'ready',
      line: buildModelAvailableLine(providerId, modelId),
      warningLine: null,
    };
  }

  const hasCompatibilityLine = modelScopedEntries.some((entry) =>
    /selected model .* is compatible\. deep verification pending\./i.test(entry)
  );
  if (hasCompatibilityLine) {
    return {
      status: 'notes',
      line: buildModelCompatibilityPendingLine(providerId, modelId),
      warningLine: null,
    };
  }

  const hasUnavailableLine = modelScopedEntries.some((entry) =>
    /selected model .* is unavailable\./i.test(entry)
  );
  if (hasUnavailableLine || (!result.ready && isOnlyModel)) {
    return {
      status: 'failed',
      line: buildModelFailureLine(
        providerId,
        modelId,
        'unavailable',
        scopedReason ?? fallbackBatchReason
      ),
      warningLine: null,
    };
  }

  const hasVerificationWarningLine = modelScopedEntries.some((entry) =>
    /selected model .* could not be verified\./i.test(entry)
  );
  if (
    hasVerificationWarningLine ||
    ((result.warnings?.length ?? 0) > 0 && isOnlyModel && hasModelScopedEntries)
  ) {
    const line = buildModelFailureLine(providerId, modelId, 'check failed', scopedReason);
    return {
      status: 'notes',
      line,
      warningLine: line,
    };
  }

  if (result.ready && (result.warnings?.length ?? 0) > 0 && !hasModelScopedEntries) {
    return {
      status: 'notes',
      line: buildModelCompatibilityPendingLine(providerId, modelId),
      warningLine: null,
    };
  }

  if (result.ready) {
    return {
      status: 'ready',
      line: buildModelSuccessLine(providerId, modelId),
      warningLine: null,
    };
  }

  const line = buildModelFailureLine(
    providerId,
    modelId,
    'check failed',
    scopedReason ?? 'Model verification failed'
  );
  return {
    status: 'notes',
    line,
    warningLine: line,
  };
}

function resolveModelResultFromCompatibilityBatch(
  providerId: TeamProviderId,
  modelId: string,
  result: TeamProvisioningPrepareResult,
  isOnlyModel: boolean
): { kind: 'compatible' } | { kind: 'terminal'; result: ProviderPrepareDiagnosticsModelResult } {
  const modelScopedEntries = getModelScopedEntries(modelId, result);
  const scopedReason = getScopedModelReason(modelId, modelScopedEntries);
  const fallbackBatchReason = isOnlyModel
    ? (getResultReason(modelId, result) ?? normalizeModelReason(result.message))
    : null;

  const hasCompatibilityLine = modelScopedEntries.some((entry) =>
    /selected model .* is compatible\. deep verification pending\./i.test(entry)
  );
  if (hasCompatibilityLine || (result.ready && modelScopedEntries.length === 0)) {
    return { kind: 'compatible' };
  }

  const hasAvailableLine = modelScopedEntries.some((entry) =>
    /selected model .* is available for launch\./i.test(entry)
  );
  if (hasAvailableLine) {
    return {
      kind: 'terminal',
      result: {
        status: 'ready',
        line: buildModelAvailableLine(providerId, modelId),
        warningLine: null,
      },
    };
  }

  const hasUnavailableLine = modelScopedEntries.some((entry) =>
    /selected model .* is unavailable\./i.test(entry)
  );
  if (hasUnavailableLine || (!result.ready && isOnlyModel)) {
    return {
      kind: 'terminal',
      result: {
        status: 'failed',
        line: buildModelFailureLine(
          providerId,
          modelId,
          'unavailable',
          scopedReason ?? fallbackBatchReason
        ),
        warningLine: null,
      },
    };
  }

  const hasVerificationWarningLine = modelScopedEntries.some((entry) =>
    /selected model .* could not be verified\./i.test(entry)
  );
  if (hasVerificationWarningLine) {
    const line = buildModelFailureLine(
      providerId,
      modelId,
      'check failed',
      scopedReason ?? fallbackBatchReason
    );
    return {
      kind: 'terminal',
      result: {
        status: 'notes',
        line,
        warningLine: line,
      },
    };
  }

  return {
    kind: 'terminal',
    result: {
      status: 'notes',
      line: buildModelFailureLine(
        providerId,
        modelId,
        'check failed',
        scopedReason ?? fallbackBatchReason ?? 'Model verification failed'
      ),
      warningLine: buildModelFailureLine(
        providerId,
        modelId,
        'check failed',
        scopedReason ?? fallbackBatchReason ?? 'Model verification failed'
      ),
    },
  };
}

export async function runProviderPrepareDiagnostics({
  cwd,
  providerId,
  selectedModelIds,
  prepareProvisioning,
  limitContext,
  onModelProgress,
  cachedModelResultsById,
}: {
  cwd: string;
  providerId: TeamProviderId;
  selectedModelIds: string[];
  prepareProvisioning: PrepareProvisioningFn;
  limitContext?: boolean;
  onModelProgress?: (progress: ProviderPrepareDiagnosticsProgress) => void;
  cachedModelResultsById?: Record<string, ProviderPrepareDiagnosticsModelResult>;
}): Promise<ProviderPrepareDiagnosticsResult> {
  if (selectedModelIds.length === 0) {
    const runtimeResult = await prepareProvisioning(
      cwd,
      providerId,
      [providerId],
      undefined,
      limitContext
    );
    const runtimeDetailLines = createRuntimeDetailLines(runtimeResult);
    const runtimeWarnings = [...(runtimeResult.warnings ?? [])];

    if (!runtimeResult.ready) {
      return {
        status: 'failed',
        details: [...runtimeDetailLines, ...(runtimeResult.message ? [runtimeResult.message] : [])],
        warnings: runtimeWarnings,
        modelResultsById: {},
      };
    }

    return {
      status: runtimeWarnings.length > 0 ? 'notes' : 'ready',
      details: runtimeDetailLines,
      warnings: runtimeWarnings,
      modelResultsById: {},
    };
  }

  const orderedModelIds = Array.from(
    new Set(selectedModelIds.map((modelId) => modelId.trim()).filter(Boolean))
  );
  const reusableModelResultsById = cachedModelResultsById ?? {};
  const modelResultsById = new Map<string, ProviderPrepareDiagnosticsModelResult>();
  const modelLines = new Map<string, string>();
  let runtimeDetailLines: string[] = [];
  let runtimeWarnings: string[] = [];
  let completedCount = 0;
  let hasFailure = false;
  let hasNotes = false;
  const modelWarnings: string[] = [];

  for (const modelId of orderedModelIds) {
    const cachedResult = reusableModelResultsById[modelId];
    if (cachedResult) {
      modelResultsById.set(modelId, cachedResult);
      modelLines.set(modelId, cachedResult.line);
      completedCount += 1;
      if (cachedResult.status === 'failed') {
        hasFailure = true;
      } else if (cachedResult.status === 'notes') {
        hasNotes = true;
      }
      if (cachedResult.warningLine) {
        modelWarnings.push(cachedResult.warningLine);
      }
      continue;
    }
    modelLines.set(modelId, buildProviderPrepareModelCheckingLine(providerId, modelId));
  }

  const emitProgress = (): void => {
    const filteredRuntime = suppressSupersededRuntimeWarnings({
      runtimeDetailLines,
      runtimeWarnings,
      modelResultsById,
    });
    onModelProgress?.({
      status: getProgressStatus({
        completedCount,
        totalCount: orderedModelIds.length,
        runtimeWarnings: filteredRuntime.runtimeWarnings,
        modelResultsById,
      }),
      details: [
        ...filteredRuntime.runtimeDetailLines,
        ...orderedModelIds.map((modelId) => modelLines.get(modelId) ?? ''),
      ],
      completedCount,
      totalCount: orderedModelIds.length,
    });
  };

  emitProgress();

  const uncachedModelIds = orderedModelIds.filter((modelId) => !modelResultsById.has(modelId));
  if (uncachedModelIds.length === 0) {
    const runtimeResult = await prepareProvisioning(
      cwd,
      providerId,
      [providerId],
      undefined,
      limitContext
    );
    runtimeDetailLines = createRuntimeDetailLines(runtimeResult);
    runtimeWarnings = [...(runtimeResult.warnings ?? [])];

    if (!runtimeResult.ready) {
      return {
        status: 'failed',
        details: [...runtimeDetailLines, ...(runtimeResult.message ? [runtimeResult.message] : [])],
        warnings: runtimeWarnings,
        modelResultsById: {},
      };
    }
  } else {
    const recordTerminalModelResult = (
      modelId: string,
      resolvedResult: ProviderPrepareDiagnosticsModelResult
    ): void => {
      modelLines.set(modelId, resolvedResult.line);
      modelResultsById.set(modelId, resolvedResult);
      completedCount += 1;
      if (resolvedResult.status === 'failed') {
        hasFailure = true;
      } else if (resolvedResult.status === 'notes') {
        hasNotes = true;
      }
      if (resolvedResult.warningLine) {
        modelWarnings.push(resolvedResult.warningLine);
      }
    };

    if (providerId === 'opencode') {
      const compatibilityPassedModelIds: string[] = [];
      try {
        const compatibilityResult = await prepareProvisioning(
          cwd,
          providerId,
          [providerId],
          uncachedModelIds,
          limitContext,
          'compatibility'
        );
        runtimeDetailLines = createRuntimeDetailLines(compatibilityResult).filter(
          (entry) => !isModelScopedEntryForAnyModel(uncachedModelIds, entry)
        );
        runtimeWarnings = [...(compatibilityResult.warnings ?? [])].filter(
          (entry) => !isModelScopedEntryForAnyModel(uncachedModelIds, entry)
        );

        const hasModelScopedEntries = uncachedModelIds.some(
          (modelId) => getModelScopedEntries(modelId, compatibilityResult).length > 0
        );
        const hasNonModelScopedDiagnostics =
          runtimeDetailLines.length > 0 || runtimeWarnings.length > 0;
        const hasSingleModelFallbackReason =
          uncachedModelIds.length === 1 &&
          looksLikeSingleModelBatchFailure(uncachedModelIds[0], compatibilityResult);
        if (
          !compatibilityResult.ready &&
          !hasModelScopedEntries &&
          (uncachedModelIds.length > 1 ||
            (!hasNonModelScopedDiagnostics && !hasSingleModelFallbackReason))
        ) {
          return {
            status: 'failed',
            details: [
              ...runtimeDetailLines,
              ...(compatibilityResult.message ? [compatibilityResult.message] : []),
            ],
            warnings: runtimeWarnings,
            modelResultsById: {},
          };
        }
        if (!hasModelScopedEntries && uncachedModelIds.length === 1) {
          runtimeDetailLines = [];
          runtimeWarnings = [];
        }

        for (const modelId of uncachedModelIds) {
          const compatibilityResolution = resolveModelResultFromCompatibilityBatch(
            providerId,
            modelId,
            compatibilityResult,
            uncachedModelIds.length === 1
          );
          if (compatibilityResolution.kind === 'compatible') {
            modelLines.set(modelId, buildModelCompatibilityPendingLine(providerId, modelId));
            compatibilityPassedModelIds.push(modelId);
            continue;
          }
          recordTerminalModelResult(modelId, compatibilityResolution.result);
        }
      } catch (error) {
        hasNotes = true;
        const reason = normalizeModelReason(
          error instanceof Error ? error.message.trim() : String(error).trim()
        );
        for (const modelId of uncachedModelIds) {
          const line = buildModelFailureLine(providerId, modelId, 'check failed', reason || null);
          recordTerminalModelResult(modelId, {
            status: 'notes',
            line,
            warningLine: line,
          });
        }
      }

      emitProgress();

      if (compatibilityPassedModelIds.length === 0) {
        const filteredRuntime = suppressSupersededRuntimeWarnings({
          runtimeDetailLines,
          runtimeWarnings,
          modelResultsById,
        });
        const dedupedWarnings = Array.from(
          new Set([...filteredRuntime.runtimeWarnings, ...modelWarnings])
        );
        const selectedModelResultsById = Object.fromEntries(
          orderedModelIds
            .map((modelId) => [modelId, modelResultsById.get(modelId)] as const)
            .filter((entry): entry is [string, ProviderPrepareDiagnosticsModelResult] =>
              Boolean(entry[1])
            )
        );

        return {
          status: hasFailure
            ? 'failed'
            : hasNotes || dedupedWarnings.length > 0
              ? 'notes'
              : 'ready',
          details: [
            ...filteredRuntime.runtimeDetailLines,
            ...orderedModelIds.map((modelId) => modelLines.get(modelId) ?? ''),
          ],
          warnings: dedupedWarnings,
          modelResultsById: selectedModelResultsById,
        };
      }

      try {
        const batchedModelResult = await prepareProvisioning(
          cwd,
          providerId,
          [providerId],
          compatibilityPassedModelIds,
          limitContext,
          'deep'
        );
        runtimeDetailLines = createRuntimeDetailLines(batchedModelResult).filter(
          (entry) => !isModelScopedEntryForAnyModel(compatibilityPassedModelIds, entry)
        );
        runtimeWarnings = [...(batchedModelResult.warnings ?? [])].filter(
          (entry) => !isModelScopedEntryForAnyModel(compatibilityPassedModelIds, entry)
        );

        const hasModelScopedEntries = compatibilityPassedModelIds.some(
          (modelId) => getModelScopedEntries(modelId, batchedModelResult).length > 0
        );
        const hasNonModelScopedDiagnostics =
          runtimeDetailLines.length > 0 || runtimeWarnings.length > 0;
        const hasSingleModelFallbackReason =
          compatibilityPassedModelIds.length === 1 &&
          looksLikeSingleModelBatchFailure(compatibilityPassedModelIds[0], batchedModelResult);
        if (
          !batchedModelResult.ready &&
          !hasModelScopedEntries &&
          (compatibilityPassedModelIds.length > 1 ||
            (!hasNonModelScopedDiagnostics && !hasSingleModelFallbackReason))
        ) {
          return {
            status: 'failed',
            details: [
              ...runtimeDetailLines,
              ...(batchedModelResult.message ? [batchedModelResult.message] : []),
            ],
            warnings: runtimeWarnings,
            modelResultsById: {},
          };
        }
        if (!hasModelScopedEntries && compatibilityPassedModelIds.length === 1) {
          runtimeDetailLines = [];
          runtimeWarnings = [];
        }

        for (const modelId of compatibilityPassedModelIds) {
          recordTerminalModelResult(
            modelId,
            resolveModelResultFromBatch(
              providerId,
              modelId,
              batchedModelResult,
              compatibilityPassedModelIds.length === 1
            )
          );
        }
      } catch (error) {
        hasNotes = true;
        const reason = normalizeModelReason(
          error instanceof Error ? error.message.trim() : String(error).trim()
        );
        for (const modelId of compatibilityPassedModelIds) {
          const line = buildModelFailureLine(providerId, modelId, 'check failed', reason || null);
          recordTerminalModelResult(modelId, {
            status: 'notes',
            line,
            warningLine: line,
          });
        }
      } finally {
        emitProgress();
      }
    } else {
      try {
        const compatibilityResult = await prepareProvisioning(
          cwd,
          providerId,
          [providerId],
          uncachedModelIds,
          limitContext,
          'compatibility'
        );
        runtimeDetailLines = createRuntimeDetailLines(compatibilityResult).filter(
          (entry) => !isModelScopedEntryForAnyModel(uncachedModelIds, entry)
        );
        runtimeWarnings = [...(compatibilityResult.warnings ?? [])].filter(
          (entry) => !isModelScopedEntryForAnyModel(uncachedModelIds, entry)
        );

        const hasModelScopedEntries = uncachedModelIds.some(
          (modelId) => getModelScopedEntries(modelId, compatibilityResult).length > 0
        );
        const hasNonModelScopedDiagnostics =
          runtimeDetailLines.length > 0 || runtimeWarnings.length > 0;
        const hasSingleModelFallbackReason =
          uncachedModelIds.length === 1 &&
          looksLikeSingleModelBatchFailure(uncachedModelIds[0], compatibilityResult);
        if (
          !compatibilityResult.ready &&
          !hasModelScopedEntries &&
          (uncachedModelIds.length > 1 ||
            (!hasNonModelScopedDiagnostics && !hasSingleModelFallbackReason))
        ) {
          return {
            status: 'failed',
            details: [
              ...runtimeDetailLines,
              ...(compatibilityResult.message ? [compatibilityResult.message] : []),
            ],
            warnings: runtimeWarnings,
            modelResultsById: {},
          };
        }
        if (!hasModelScopedEntries && uncachedModelIds.length === 1) {
          runtimeDetailLines = [];
          runtimeWarnings = [];
        }

        for (const modelId of uncachedModelIds) {
          recordTerminalModelResult(
            modelId,
            resolveModelResultFromBatch(
              providerId,
              modelId,
              compatibilityResult,
              uncachedModelIds.length === 1
            )
          );
        }

        emitProgress();

        if (!hasFailure) {
          try {
            const deepResult = await prepareProvisioning(
              cwd,
              providerId,
              [providerId],
              undefined,
              limitContext,
              'deep'
            );
            runtimeDetailLines = createRuntimeDetailLines(deepResult).filter(
              (entry) => !isModelScopedEntryForAnyModel(uncachedModelIds, entry)
            );
            runtimeWarnings = [...(deepResult.warnings ?? [])].filter(
              (entry) => !isModelScopedEntryForAnyModel(uncachedModelIds, entry)
            );
            if (
              !deepResult.ready &&
              runtimeDetailLines.length === 0 &&
              runtimeWarnings.length === 0
            ) {
              runtimeWarnings = deepResult.message ? [deepResult.message] : [];
            }
          } catch (deepError) {
            hasNotes = true;
            runtimeWarnings = [
              normalizeModelReason(
                deepError instanceof Error ? deepError.message.trim() : String(deepError).trim()
              ) ?? 'One-shot diagnostic failed',
            ];
          }
        }
      } catch (error) {
        hasNotes = true;
        const reason = normalizeModelReason(
          error instanceof Error ? error.message.trim() : String(error).trim()
        );
        for (const modelId of uncachedModelIds) {
          const line = buildModelFailureLine(providerId, modelId, 'check failed', reason || null);
          recordTerminalModelResult(modelId, {
            status: 'notes',
            line,
            warningLine: line,
          });
        }
      } finally {
        emitProgress();
      }
    }
  }

  const filteredRuntime = suppressSupersededRuntimeWarnings({
    runtimeDetailLines,
    runtimeWarnings,
    modelResultsById,
  });
  const dedupedWarnings = Array.from(
    new Set([...filteredRuntime.runtimeWarnings, ...modelWarnings])
  );
  const selectedModelResultsById = Object.fromEntries(
    orderedModelIds
      .map((modelId) => [modelId, modelResultsById.get(modelId)] as const)
      .filter((entry): entry is [string, ProviderPrepareDiagnosticsModelResult] =>
        Boolean(entry[1])
      )
  );

  return {
    status: hasFailure ? 'failed' : hasNotes || dedupedWarnings.length > 0 ? 'notes' : 'ready',
    details: [
      ...filteredRuntime.runtimeDetailLines,
      ...orderedModelIds.map((modelId) => modelLines.get(modelId) ?? ''),
    ],
    warnings: dedupedWarnings,
    modelResultsById: selectedModelResultsById,
  };
}
