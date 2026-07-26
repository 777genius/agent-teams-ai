import { getErrorMessage } from '@shared/utils/errorHandling';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isOpenCodeLocalProviderId } from '@shared/utils/opencodeModelRoute';
import { randomUUID } from 'crypto';

import {
  extractOpenCodeCatalogProviderId,
  getOpenCodeCatalogProviderIds,
  resolveOpenCodeCompatibilityModel,
} from './OpenCodeModelCompatibility';
import {
  buildOpenCodeProviderVerificationDeferredLine,
  isOpenCodeModelPrepareBusyDeferred,
  looksLikeOpenCodeProviderPrepareDiagnostic,
  normalizeOpenCodePrepareDiagnostic,
  selectOpenCodeModelPreparePrimaryReason,
  selectOpenCodePrepareProviderDiagnostic,
} from './TeamProvisioningOpenCodeDiagnosticsPolicy';

export {
  extractOpenCodeCatalogProviderId,
  findEquivalentOpenRouterModelIds,
  getOpenCodeCatalogProviderIds,
  resolveOpenCodeCompatibilityModel,
} from './OpenCodeModelCompatibility';

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

export interface OpenCodeLocalModelRuntimeReadiness {
  readonly providerId: string;
  readonly modelId: string;
  readonly presetId: string;
  readonly toolCapable: boolean | null;
  readonly parameterCount: number | null;
  readonly trainedContextTokens: number | null;
  readonly configuredContextTokens: number | null;
  readonly effectiveContextTokens: number | null;
  readonly coordinationProbeStatus: 'passed' | 'failed' | 'unavailable' | null;
  readonly severity: 'ready' | 'warning' | 'blocking';
  readonly experimentalOverrideAvailable?: boolean;
  readonly code:
    | 'local_coordination_verified'
    | 'local_coordination_probe_failed'
    | 'local_coordination_probe_unavailable'
    | 'local_team_tools_unverified'
    | 'local_model_too_small'
    | 'local_tools_unsupported'
    | 'local_context_too_small'
    | 'local_provider_unavailable'
    | 'local_model_not_loaded'
    | 'local_runtime_inspection_failed'
    | 'local_runtime_unverified';
  readonly message: string;
}

export interface OpenCodeSelectedModelPreparationInput {
  adapter: TeamLaunchRuntimeAdapter;
  cwd: string;
  modelIds: readonly string[];
  verificationMode: TeamProvisioningModelVerificationMode;
  appendPreflightDebugLog?: (event: string, data: Record<string, unknown>) => void;
  inspectLocalModelRuntime?: (input: {
    projectPath: string;
    modelRoute: string;
    allowExperimentalLocalModels?: boolean;
    classificationOnly?: boolean;
  }) => Promise<OpenCodeLocalModelRuntimeReadiness | null>;
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

function buildLocalModelTeamToolsWarning(modelId: string): string | null {
  const sourceId = parseOpenCodeQualifiedModelRef(modelId)?.sourceId ?? null;
  if (!isOpenCodeLocalProviderId(sourceId)) return null;
  return (
    `Local model ${modelId} answered the execution probe, but Agent Teams task and messaging ` +
    'tools are not proven by that check. Use a tool-capable model and at least 16K effective ' +
    'server context; 64K is recommended for coding agents.'
  );
}

function isOpenCodeLocalModelRoute(modelId: string): boolean {
  const sourceId = parseOpenCodeQualifiedModelRef(modelId)?.sourceId ?? null;
  return isOpenCodeLocalProviderId(sourceId);
}

function isOpenCodeUnknownProviderRoute(
  modelId: string,
  availableProviderIds: ReadonlySet<string>
): boolean {
  const providerId = extractOpenCodeCatalogProviderId(modelId);
  return Boolean(
    providerId && providerId !== 'openrouter' && !availableProviderIds.has(providerId)
  );
}

function buildLocalRuntimeInspectionFailure(
  modelId: string,
  code: OpenCodeLocalModelRuntimeReadiness['code'],
  message: string
): OpenCodeLocalModelRuntimeReadiness {
  const parsed = parseOpenCodeQualifiedModelRef(modelId);
  const verificationUnavailable = code === 'local_runtime_inspection_failed';
  return {
    providerId: parsed?.sourceId ?? 'local',
    modelId: parsed?.modelId ?? modelId,
    presetId: 'custom',
    toolCapable: null,
    parameterCount: null,
    trainedContextTokens: null,
    configuredContextTokens: null,
    effectiveContextTokens: null,
    coordinationProbeStatus: null,
    severity: verificationUnavailable ? 'warning' : 'blocking',
    code,
    message: verificationUnavailable
      ? `${message} This verification failure does not prove that the model is unsupported; ` +
        'the real OpenCode execution probe will make the launch decision.'
      : message,
  };
}

export async function prepareSelectedOpenCodeModelsForProvisioning({
  adapter,
  cwd,
  modelIds,
  verificationMode,
  appendPreflightDebugLog = () => undefined,
  inspectLocalModelRuntime,
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
      inspectLocalModelRuntime,
    });
    if (sharedCompatibilityPrepare) {
      return sharedCompatibilityPrepare;
    }
  }

  const results = new Array<
    | {
        modelId: string;
        prepare: TeamRuntimePrepareResult;
        localRuntimeReadiness?: OpenCodeLocalModelRuntimeReadiness | null;
      }
    | undefined
  >(modelIds.length);
  let providerBusyDeferred: {
    modelId: string;
    reason: string;
    code: string;
  } | null = null;
  const nonLocalProviderSources = new Set<string>();

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
    let localRuntimeReadiness: OpenCodeLocalModelRuntimeReadiness | null | undefined;
    const parsedModel = parseOpenCodeQualifiedModelRef(modelId);
    if (
      verificationMode === 'deep' &&
      inspectLocalModelRuntime &&
      parsedModel &&
      !nonLocalProviderSources.has(parsedModel.sourceId)
    ) {
      try {
        localRuntimeReadiness = await inspectLocalModelRuntime({
          projectPath: cwd,
          modelRoute: modelId,
        });
        if (!localRuntimeReadiness) {
          if (isOpenCodeLocalModelRoute(modelId)) {
            localRuntimeReadiness = buildLocalRuntimeInspectionFailure(
              modelId,
              'local_provider_unavailable',
              `Local provider for ${modelId} could not be resolved. Reconnect it, then retry verification.`
            );
          } else {
            nonLocalProviderSources.add(parsedModel.sourceId);
          }
        }
      } catch (error) {
        const inspectionError = getErrorMessage(error);
        localRuntimeReadiness = buildLocalRuntimeInspectionFailure(
          modelId,
          'local_runtime_inspection_failed',
          `Local model launch verification failed: ${inspectionError}`
        );
        appendPreflightDebugLog('opencode_local_model_runtime_inspection_failed', {
          cwd,
          modelId,
          error: inspectionError,
        });
      }
    }

    // A local runtime can often prove a hard incompatibility from server metadata alone.
    // Avoid starting the much slower OpenCode execution probe when launch is already
    // impossible (for example, missing tool support or an effective 4K context window).
    if (localRuntimeReadiness?.severity === 'blocking') {
      appendPreflightDebugLog('opencode_local_model_prepare_skipped', {
        cwd,
        modelId,
        verificationMode,
        reason: localRuntimeReadiness.code,
      });
      results[index] = {
        modelId,
        prepare: {
          ok: true,
          providerId: 'opencode',
          modelId,
          diagnostics: [],
          warnings: [],
        },
        localRuntimeReadiness,
      };
      continue;
    }

    const prepare = await prepareModel(modelId);
    results[index] = { modelId, prepare, localRuntimeReadiness };

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

    const { modelId, prepare, localRuntimeReadiness } = result;
    pushUniqueSupportDiagnostics(supportDiagnostics, prepare.supportDiagnostics);
    const prepareReason = prepare.ok ? undefined : prepare.reason;
    warnings.push(
      ...prepare.warnings.map((warning) =>
        normalizeOpenCodePrepareDiagnostic(warning, prepareReason)
      )
    );
    if (prepare.ok) {
      if (verificationMode === 'deep' && localRuntimeReadiness?.severity === 'blocking') {
        const unavailableLine = `Selected model ${modelId} is unavailable. ${localRuntimeReadiness.message}`;
        pushUniqueLine(details, unavailableLine);
        pushUniqueLine(blockingMessages, unavailableLine);
        issues.push({
          providerId: 'opencode',
          modelId,
          scope: 'model',
          severity: 'blocking',
          code: localRuntimeReadiness.code,
          message: localRuntimeReadiness.message,
          experimentalOverrideAvailable:
            localRuntimeReadiness.experimentalOverrideAvailable === true,
        });
        continue;
      }
      details.push(
        verificationMode === 'compatibility'
          ? `Selected model ${modelId} is compatible. Deep verification pending.`
          : localRuntimeReadiness?.severity === 'ready'
            ? `Selected model ${modelId} verified for launch with Agent Teams tool coordination.`
            : `Selected model ${modelId} verified for launch.`
      );
      if (verificationMode === 'deep') {
        if (localRuntimeReadiness?.severity === 'ready') {
          continue;
        }
        const localModelWarning =
          localRuntimeReadiness?.message ?? buildLocalModelTeamToolsWarning(modelId);
        if (localModelWarning) {
          pushUniqueLine(warnings, localModelWarning);
          issues.push({
            providerId: 'opencode',
            modelId,
            scope: 'model',
            severity: 'warning',
            code: localRuntimeReadiness?.code ?? 'local_team_tools_unverified',
            message: localModelWarning,
          });
        }
      }
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
  inspectLocalModelRuntime,
}: {
  adapter: TeamLaunchRuntimeAdapter;
  cwd: string;
  modelIds: readonly string[];
  appendPreflightDebugLog: (event: string, data: Record<string, unknown>) => void;
  inspectLocalModelRuntime?: OpenCodeSelectedModelPreparationInput['inspectLocalModelRuntime'];
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

  const configuredLocalModelIds = modelIds.filter(isOpenCodeLocalModelRoute);
  if (inspectLocalModelRuntime) {
    for (const modelId of modelIds.filter((candidate) => !isOpenCodeLocalModelRoute(candidate))) {
      try {
        const classification = await inspectLocalModelRuntime({
          projectPath: cwd,
          modelRoute: modelId,
          classificationOnly: true,
        });
        if (classification) configuredLocalModelIds.push(modelId);
      } catch (error) {
        appendPreflightDebugLog('opencode_compatibility_local_route_classification_failed', {
          cwd,
          modelId,
          error: getErrorMessage(error),
        });
      }
    }
  }
  const configuredLocalModelIdSet = new Set(configuredLocalModelIds);
  const catalogModelIds = modelIds.filter((modelId) => !configuredLocalModelIdSet.has(modelId));
  for (const modelId of configuredLocalModelIds) {
    details.push(`Selected model ${modelId} is compatible. Deep verification pending.`);
  }
  if (catalogModelIds.length === 0) {
    appendPreflightDebugLog('opencode_compatibility_batch_local_routes_deferred', {
      cwd,
      modelIds,
    });
    return { details, warnings, blockingMessages, issues, supportDiagnostics };
  }

  let sharedPrepare = await prepareOpenCodeCompatibilityModel(adapter, cwd, catalogModelIds[0]);
  if (!sharedPrepare.ok && sharedPrepare.reason === 'not_authenticated') {
    const failedReadiness = getLastOpenCodeTeamLaunchReadiness(adapter, cwd);
    const failedAvailableModels = normalizeAvailableModelIds(failedReadiness?.availableModels);
    const failedAvailableProviderIds = new Set(
      getOpenCodeCatalogProviderIds(failedAvailableModels)
    );
    const deferredModelIds = catalogModelIds.filter((modelId) =>
      isOpenCodeUnknownProviderRoute(modelId, failedAvailableProviderIds)
    );
    if (failedAvailableModels.length > 0 && deferredModelIds.includes(catalogModelIds[0])) {
      const catalogModelId = catalogModelIds.find((modelId) => !deferredModelIds.includes(modelId));
      if (!catalogModelId) {
        for (const modelId of deferredModelIds) {
          details.push(`Selected model ${modelId} is compatible. Deep verification pending.`);
        }
        appendPreflightDebugLog('opencode_compatibility_batch_authless_provider_deferred', {
          cwd,
          modelIds: deferredModelIds,
        });
        return { details, warnings, blockingMessages, issues, supportDiagnostics };
      }
      sharedPrepare = await prepareOpenCodeCompatibilityModel(adapter, cwd, catalogModelId);
    }
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
  const availableProviderIds = new Set(getOpenCodeCatalogProviderIds(availableModels));
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

  for (const modelId of catalogModelIds) {
    const resolvedModel = resolveOpenCodeCompatibilityModel(modelId, availableModels);
    if (resolvedModel.ok) {
      details.push(`Selected model ${modelId} is compatible. Deep verification pending.`);
      continue;
    }

    const requestedProviderId = extractOpenCodeCatalogProviderId(modelId);
    if (isOpenCodeUnknownProviderRoute(modelId, availableProviderIds)) {
      // A provider missing from the general OpenCode catalog is not proof that a
      // provider-scoped route is invalid. App-managed custom local providers can
      // be absent from this catalog while remaining executable. Defer the route
      // to the inventory-aware local inspection and real OpenCode execution probe.
      details.push(`Selected model ${modelId} is compatible. Deep verification pending.`);
      appendPreflightDebugLog('opencode_compatibility_batch_unknown_provider_deferred', {
        cwd,
        modelId,
        requestedProviderId,
      });
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

async function prepareOpenCodeCompatibilityModel(
  adapter: TeamLaunchRuntimeAdapter,
  cwd: string,
  model: string
): Promise<TeamRuntimePrepareResult> {
  try {
    return await adapter.prepare({
      runId: `prepare-${randomUUID()}`,
      teamName: '__prepare_opencode__',
      cwd,
      providerId: 'opencode',
      model,
      runtimeOnly: true,
      skipPermissions: true,
      expectedMembers: [],
      previousLaunchState: null,
    });
  } catch (error) {
    const message = getErrorMessage(error).trim() || 'OpenCode model verification failed';
    return {
      ok: false,
      providerId: 'opencode',
      reason: 'unknown_error',
      retryable: false,
      diagnostics: [message],
      warnings: [],
    };
  }
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
