import { getErrorMessage } from '@shared/utils/errorHandling';
import { randomUUID } from 'crypto';

import {
  buildOpenCodeProviderVerificationDeferredLine,
  isOpenCodeModelPrepareBusyDeferred,
  looksLikeOpenCodeProviderPrepareDiagnostic,
  normalizeOpenCodePrepareDiagnostic,
  selectOpenCodeModelPreparePrimaryReason,
  selectOpenCodePrepareProviderDiagnostic,
} from './TeamProvisioningOpenCodeDiagnosticsPolicy';

import type { TeamLaunchRuntimeAdapter, TeamRuntimePrepareResult } from '../runtime';
import type {
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareIssue,
  TeamProvisioningSupportDiagnostic,
} from '@shared/types';

export interface OpenCodeSelectedModelPreparationResult {
  details: string[];
  warnings: string[];
  blockingMessages: string[];
  issues: TeamProvisioningPrepareIssue[];
  supportDiagnostics: TeamProvisioningSupportDiagnostic[];
}

export interface OpenCodeSelectedModelPreparationInput {
  adapter: TeamLaunchRuntimeAdapter;
  cwd: string;
  modelIds: readonly string[];
  verificationMode: TeamProvisioningModelVerificationMode;
  appendPreflightDebugLog?: (event: string, data: Record<string, unknown>) => void;
}

type OpenCodeLaunchReadinessProvider = TeamLaunchRuntimeAdapter & {
  getLastOpenCodeTeamLaunchReadiness?: (cwd: string) => { availableModels?: unknown } | null;
};

const OPENCODE_PROVIDER_SCOPED_PREPARE_FAILURE_REASONS = new Set([
  'not_installed',
  'not_authenticated',
  'unsupported_version',
  'capabilities_missing',
  'runtime_store_blocked',
  'mcp_unavailable',
  'adapter_disabled',
]);

export async function prepareSelectedOpenCodeModelsForProvisioning({
  adapter,
  cwd,
  modelIds,
  verificationMode,
  appendPreflightDebugLog = () => undefined,
}: OpenCodeSelectedModelPreparationInput): Promise<OpenCodeSelectedModelPreparationResult> {
  const details: string[] = [];
  const warnings: string[] = [];
  const blockingMessages: string[] = [];
  const issues: TeamProvisioningPrepareIssue[] = [];
  const supportDiagnostics: TeamProvisioningSupportDiagnostic[] = [];
  const startedAt = Date.now();

  if (modelIds.length === 0) {
    return { details, warnings, blockingMessages, issues, supportDiagnostics };
  }

  if (verificationMode === 'compatibility') {
    const sharedCompatibilityPrepare = await prepareSelectedOpenCodeModelsCompatibilityBatch({
      adapter,
      cwd,
      modelIds,
      appendPreflightDebugLog,
    });
    if (sharedCompatibilityPrepare) {
      return sharedCompatibilityPrepare;
    }
  }

  const results = new Array<{ modelId: string; prepare: TeamRuntimePrepareResult } | undefined>(
    modelIds.length
  );
  let providerBusyDeferred: {
    modelId: string;
    reason: string;
    code: string;
  } | null = null;

  const prepareModel = async (modelId: string): Promise<TeamRuntimePrepareResult> => {
    const modelStartedAt = Date.now();
    try {
      const prepare = await adapter.prepare({
        runId: `prepare-${randomUUID()}`,
        teamName: '__prepare_opencode__',
        cwd,
        providerId: 'opencode',
        model: modelId,
        runtimeOnly: verificationMode === 'compatibility',
        skipPermissions: true,
        expectedMembers: [],
        previousLaunchState: null,
      });
      appendPreflightDebugLog('opencode_model_prepare_result', {
        cwd,
        modelId,
        verificationMode,
        durationMs: Date.now() - modelStartedAt,
        ok: prepare.ok,
        reason: prepare.ok ? null : prepare.reason,
        diagnostics: prepare.diagnostics,
        warnings: prepare.warnings,
        supportDiagnostics: prepare.supportDiagnostics?.map((diagnostic) => ({
          id: diagnostic.id,
          kind: diagnostic.kind,
          title: diagnostic.title,
        })),
      });
      return prepare;
    } catch (error) {
      const message = getErrorMessage(error).trim() || 'OpenCode model verification failed';
      appendPreflightDebugLog('opencode_model_prepare_result', {
        cwd,
        modelId,
        verificationMode,
        durationMs: Date.now() - modelStartedAt,
        ok: false,
        reason: 'unknown_error',
        diagnostics: [message],
        warnings: [],
      });
      return {
        ok: false,
        providerId: 'opencode',
        reason: 'unknown_error',
        retryable: false,
        diagnostics: [message],
        warnings: [],
      };
    }
  };

  // Facts:
  // - Deep OpenCode preflight maps to a real foreground execution probe.
  // - The host reports "session status busy" while another probe/member turn is active.
  // - Once busy is observed, probing more selected models only repeats the same host state.
  for (let index = 0; index < modelIds.length; index += 1) {
    const modelId = modelIds[index];
    const prepare = await prepareModel(modelId);
    results[index] = { modelId, prepare };

    if (verificationMode === 'compatibility' || prepare.ok) {
      continue;
    }

    const primaryReason = normalizeOpenCodePrepareDiagnostic(
      selectOpenCodeModelPreparePrimaryReason(prepare),
      prepare.reason
    );
    if (isOpenCodeModelPrepareBusyDeferred(prepare, primaryReason)) {
      providerBusyDeferred = {
        modelId,
        reason: primaryReason,
        code: prepare.reason,
      };
      appendPreflightDebugLog('opencode_model_prepare_batch_busy_deferred', {
        cwd,
        modelId,
        verificationMode,
        skippedModelIds: modelIds.slice(index + 1),
        reason: primaryReason,
      });
      break;
    }
  }

  for (const result of results) {
    if (!result) {
      if (providerBusyDeferred) {
        continue;
      }
      blockingMessages.push(
        'OpenCode preflight could not collect model verification results for all selected models.'
      );
      continue;
    }

    const { modelId, prepare } = result;
    pushUniqueSupportDiagnostics(supportDiagnostics, prepare.supportDiagnostics);
    const prepareReason = prepare.ok ? undefined : prepare.reason;
    warnings.push(
      ...prepare.warnings.map((warning) =>
        normalizeOpenCodePrepareDiagnostic(warning, prepareReason)
      )
    );
    if (prepare.ok) {
      details.push(
        verificationMode === 'compatibility'
          ? `Selected model ${modelId} is compatible. Deep verification pending.`
          : `Selected model ${modelId} verified for launch.`
      );
      continue;
    }

    const primaryReason = normalizeOpenCodePrepareDiagnostic(
      selectOpenCodeModelPreparePrimaryReason(prepare),
      prepare.reason
    );
    if (isOpenCodeModelPrepareBusyDeferred(prepare, primaryReason)) {
      providerBusyDeferred ??= {
        modelId,
        reason: primaryReason,
        code: prepare.reason,
      };
      continue;
    }
    if (isProviderScopedOpenCodePrepareFailure(prepare, primaryReason)) {
      pushUniqueLine(details, primaryReason);
      pushUniqueLine(blockingMessages, primaryReason);
      if (
        !issues.some(
          (issue) =>
            issue.providerId === 'opencode' &&
            issue.scope === 'provider' &&
            issue.severity === 'blocking' &&
            issue.code === prepare.reason &&
            issue.message === primaryReason
        )
      ) {
        issues.push({
          providerId: 'opencode',
          scope: 'provider',
          severity: 'blocking',
          code: prepare.reason,
          message: primaryReason,
        });
      }
      continue;
    }

    const unavailableLine = `Selected model ${modelId} is unavailable. ${primaryReason}`;
    const verificationWarningLine = `Selected model ${modelId} could not be verified. ${primaryReason}`;
    const issueSeverity =
      prepare.retryable && verificationMode !== 'compatibility' ? 'warning' : 'blocking';
    issues.push({
      providerId: 'opencode',
      modelId,
      scope: 'model',
      severity: issueSeverity,
      code: prepare.reason,
      message: primaryReason,
    });
    if (prepare.retryable) {
      warnings.push(verificationWarningLine);
      if (verificationMode === 'compatibility') {
        blockingMessages.push(verificationWarningLine);
      }
    } else {
      if (verificationMode === 'compatibility') {
        details.push(unavailableLine);
      }
      blockingMessages.push(unavailableLine);
    }
  }

  if (providerBusyDeferred) {
    const providerBusyLine = buildOpenCodeProviderVerificationDeferredLine(
      providerBusyDeferred.reason
    );
    pushUniqueLine(warnings, providerBusyLine);
    issues.push({
      providerId: 'opencode',
      scope: 'provider',
      severity: 'warning',
      code: providerBusyDeferred.code,
      message: providerBusyLine,
    });
  }

  appendPreflightDebugLog('opencode_model_prepare_batch_complete', {
    cwd,
    modelIds,
    verificationMode,
    durationMs: Date.now() - startedAt,
    details,
    warnings,
    blockingMessages,
  });

  return { details, warnings, blockingMessages, issues, supportDiagnostics };
}

export function isProviderScopedOpenCodePrepareFailure(
  prepare: Extract<TeamRuntimePrepareResult, { ok: false }>,
  primaryReason: string
): boolean {
  if (OPENCODE_PROVIDER_SCOPED_PREPARE_FAILURE_REASONS.has(prepare.reason)) {
    return true;
  }
  return (
    prepare.reason === 'unknown_error' &&
    [primaryReason, ...prepare.diagnostics].some(looksLikeOpenCodeProviderPrepareDiagnostic)
  );
}

async function prepareSelectedOpenCodeModelsCompatibilityBatch({
  adapter,
  cwd,
  modelIds,
  appendPreflightDebugLog,
}: {
  adapter: TeamLaunchRuntimeAdapter;
  cwd: string;
  modelIds: readonly string[];
  appendPreflightDebugLog: (event: string, data: Record<string, unknown>) => void;
}): Promise<OpenCodeSelectedModelPreparationResult | null> {
  const details: string[] = [];
  const warnings: string[] = [];
  const blockingMessages: string[] = [];
  const issues: TeamProvisioningPrepareIssue[] = [];
  const supportDiagnostics: TeamProvisioningSupportDiagnostic[] = [];
  const startedAt = Date.now();

  appendPreflightDebugLog('opencode_compatibility_batch_start', {
    cwd,
    modelIds,
  });

  let sharedPrepare: TeamRuntimePrepareResult;
  try {
    sharedPrepare = await adapter.prepare({
      runId: `prepare-${randomUUID()}`,
      teamName: '__prepare_opencode__',
      cwd,
      providerId: 'opencode',
      model: undefined,
      runtimeOnly: true,
      skipPermissions: true,
      expectedMembers: [],
      previousLaunchState: null,
    });
  } catch (error) {
    const message = getErrorMessage(error).trim() || 'OpenCode model verification failed';
    sharedPrepare = {
      ok: false,
      providerId: 'opencode',
      reason: 'unknown_error',
      retryable: false,
      diagnostics: [message],
      warnings: [],
    };
  }

  const sharedPrepareReason = sharedPrepare.ok ? undefined : sharedPrepare.reason;
  warnings.push(
    ...sharedPrepare.warnings.map((warning) =>
      normalizeOpenCodePrepareDiagnostic(warning, sharedPrepareReason)
    )
  );
  appendPreflightDebugLog('opencode_compatibility_batch_shared_prepare', {
    cwd,
    modelIds,
    durationMs: Date.now() - startedAt,
    ok: sharedPrepare.ok,
    reason: sharedPrepare.ok ? null : sharedPrepare.reason,
    diagnostics: sharedPrepare.diagnostics,
    supportDiagnostics: sharedPrepare.supportDiagnostics?.map((diagnostic) => ({
      id: diagnostic.id,
      kind: diagnostic.kind,
      title: diagnostic.title,
    })),
  });

  if (!sharedPrepare.ok) {
    pushUniqueSupportDiagnostics(supportDiagnostics, sharedPrepare.supportDiagnostics);
    const providerDiagnostic = selectOpenCodePrepareProviderDiagnostic(sharedPrepare);
    const primaryReason = normalizeOpenCodePrepareDiagnostic(
      providerDiagnostic ??
        sharedPrepare.diagnostics.find((entry) => entry.trim().length > 0) ??
        sharedPrepare.reason,
      sharedPrepare.reason
    );
    if (isOpenCodeModelPrepareBusyDeferred(sharedPrepare, primaryReason)) {
      const providerBusyLine = buildOpenCodeProviderVerificationDeferredLine(primaryReason);
      pushUniqueLine(warnings, providerBusyLine);
      issues.push({
        providerId: 'opencode',
        scope: 'provider',
        severity: 'warning',
        code: sharedPrepare.reason,
        message: providerBusyLine,
      });
      appendPreflightDebugLog('opencode_compatibility_batch_busy_deferred', {
        cwd,
        modelIds,
        reason: primaryReason,
      });
      return { details, warnings, blockingMessages, issues, supportDiagnostics };
    }
    if (primaryReason.trim().length > 0) {
      details.push(primaryReason);
      blockingMessages.push(primaryReason);
    } else {
      blockingMessages.push(`OpenCode: ${sharedPrepare.reason}`);
    }
    issues.push({
      providerId: 'opencode',
      scope: 'provider',
      severity: 'blocking',
      code: sharedPrepare.reason,
      message: primaryReason.trim() || `OpenCode: ${sharedPrepare.reason}`,
    });
    return { details, warnings, blockingMessages, issues, supportDiagnostics };
  }

  const latestReadiness = getLastOpenCodeTeamLaunchReadiness(adapter, cwd);
  const availableModels = normalizeAvailableModelIds(latestReadiness?.availableModels);
  appendPreflightDebugLog('opencode_compatibility_batch_catalog', {
    cwd,
    modelIds,
    availableModelCount: availableModels.length,
    availableModelsSample: availableModels.slice(0, 20),
    fellBackToPerModelPrepare: availableModels.length === 0,
  });

  if (availableModels.length === 0) {
    return null;
  }

  for (const modelId of modelIds) {
    const resolvedModel = resolveOpenCodeCompatibilityModel(modelId, availableModels);
    if (resolvedModel.ok) {
      details.push(`Selected model ${modelId} is compatible. Deep verification pending.`);
      continue;
    }

    const unavailableLine = `Selected model ${modelId} is unavailable. ${resolvedModel.reason}`;
    details.push(unavailableLine);
    blockingMessages.push(unavailableLine);
    issues.push({
      providerId: 'opencode',
      modelId,
      scope: 'model',
      severity: 'blocking',
      code: 'model_unavailable',
      message: resolvedModel.reason,
    });
  }

  appendPreflightDebugLog('opencode_compatibility_batch_complete', {
    cwd,
    modelIds,
    durationMs: Date.now() - startedAt,
    blockingMessages,
    details,
  });

  return { details, warnings, blockingMessages, issues, supportDiagnostics };
}

export function resolveOpenCodeCompatibilityModel(
  requestedModelId: string,
  availableModels: readonly string[]
): { ok: true; resolvedModelId: string } | { ok: false; reason: string } {
  const trimmedModelId = requestedModelId.trim();
  if (!trimmedModelId) {
    return {
      ok: false,
      reason: 'Selected model id is empty.',
    };
  }

  if (availableModels.includes(trimmedModelId)) {
    return {
      ok: true,
      resolvedModelId: trimmedModelId,
    };
  }

  const equivalentOpenRouterMatches = findEquivalentOpenRouterModelIds(
    trimmedModelId,
    availableModels
  );
  if (equivalentOpenRouterMatches.length === 1) {
    return {
      ok: true,
      resolvedModelId: equivalentOpenRouterMatches[0],
    };
  }
  if (equivalentOpenRouterMatches.length > 1) {
    return {
      ok: false,
      reason:
        `Selected model ${trimmedModelId} matched multiple live provider models: ` +
        equivalentOpenRouterMatches.join(', '),
    };
  }

  if (trimmedModelId.includes('/')) {
    const requestedProviderId = extractOpenCodeCatalogProviderId(trimmedModelId);
    const availableProviderIds = getOpenCodeCatalogProviderIds(availableModels);
    if (
      requestedProviderId === 'openrouter' &&
      !availableProviderIds.includes(requestedProviderId)
    ) {
      const availableProviderList =
        availableProviderIds.length > 0 ? availableProviderIds.join(', ') : 'none';
      return {
        ok: false,
        reason:
          `OpenCode provider "openrouter" for selected model "${trimmedModelId}" ` +
          'is not available in the current runtime catalog for this project/profile. ' +
          `Live catalog providers: ${availableProviderList}. ` +
          'Connect OpenRouter in OpenCode provider management or choose one of the listed OpenCode models.',
      };
    }

    return {
      ok: false,
      reason: `Selected model ${trimmedModelId} was not found in the live provider catalog.`,
    };
  }

  const matchingProviderScopedModels = availableModels.filter(
    (candidate) => candidate.split('/').at(-1) === trimmedModelId
  );
  if (matchingProviderScopedModels.length === 1) {
    return {
      ok: true,
      resolvedModelId: matchingProviderScopedModels[0],
    };
  }
  if (matchingProviderScopedModels.length > 1) {
    return {
      ok: false,
      reason:
        `Selected model ${trimmedModelId} matched multiple live provider models: ` +
        matchingProviderScopedModels.join(', '),
    };
  }

  return {
    ok: false,
    reason: `Selected model ${trimmedModelId} was not found in the live provider catalog.`,
  };
}

export function extractOpenCodeCatalogProviderId(modelId: string): string | null {
  const separatorIndex = modelId.indexOf('/');
  if (separatorIndex <= 0) {
    return null;
  }
  return modelId.slice(0, separatorIndex).trim().toLowerCase() || null;
}

export function getOpenCodeCatalogProviderIds(availableModels: readonly string[]): string[] {
  return Array.from(
    new Set(
      availableModels
        .map((modelId) => extractOpenCodeCatalogProviderId(modelId.trim()))
        .filter((providerId): providerId is string => Boolean(providerId))
    )
  ).sort((left, right) => left.localeCompare(right));
}

export function findEquivalentOpenRouterModelIds(
  requestedModelId: string,
  availableModels: readonly string[]
): string[] {
  const equivalentIds = new Set<string>();

  if (requestedModelId.startsWith('openrouter/')) {
    equivalentIds.add(requestedModelId.slice('openrouter/'.length));
  } else if (requestedModelId.includes('/')) {
    equivalentIds.add(`openrouter/${requestedModelId}`);
  }

  if (equivalentIds.size === 0) {
    return [];
  }

  return Array.from(
    new Set(availableModels.filter((candidate) => equivalentIds.has(candidate.trim())))
  );
}

function getLastOpenCodeTeamLaunchReadiness(
  adapter: TeamLaunchRuntimeAdapter,
  cwd: string
): { availableModels?: unknown } | null {
  const readinessProvider = adapter as OpenCodeLaunchReadinessProvider;
  return typeof readinessProvider.getLastOpenCodeTeamLaunchReadiness === 'function'
    ? readinessProvider.getLastOpenCodeTeamLaunchReadiness(cwd)
    : null;
}

function normalizeAvailableModelIds(value: unknown): string[] {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .filter((modelId: unknown): modelId is string => typeof modelId === 'string')
        .map((modelId: string) => modelId.trim())
        .filter((modelId: string) => modelId.length > 0)
    )
  );
}

function pushUniqueLine(lines: string[], line: string): void {
  const trimmed = line.trim();
  if (trimmed.length > 0 && !lines.includes(trimmed)) {
    lines.push(trimmed);
  }
}

function pushUniqueSupportDiagnostics(
  diagnostics: TeamProvisioningSupportDiagnostic[],
  incoming: readonly TeamProvisioningSupportDiagnostic[] | undefined
): void {
  for (const diagnostic of incoming ?? []) {
    if (!diagnostics.some((existing) => existing.id === diagnostic.id)) {
      diagnostics.push({ ...diagnostic });
    }
  }
}
