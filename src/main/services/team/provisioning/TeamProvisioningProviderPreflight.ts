import { resolveAnthropicEffortSupport } from '@features/anthropic-runtime-profile/main';
import { execCli } from '@main/utils/childProcess';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildProviderControlPlaneCliCommandArgs } from '../../runtime/providerCliCommandArgs';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';
import { getConfiguredCliCommandLabel } from '../cliFlavor';

import { getTeamProviderLabel } from './TeamProvisioningRuntimeDiagnostics';
import {
  type AuthStatusCommandResponse,
  extractJsonObjectFromCli,
  formatAnthropicEffortSupportFailure,
  hasAuthoritativeCodexLaunchCatalog,
  normalizeProviderSelectedModelChecks,
  type ProviderSelectedModelCheck,
  resolveAnthropicSelectionFromFacts,
  type RuntimeProviderLaunchFacts,
  type RuntimeStatusCommandResponse,
} from './TeamProvisioningRuntimeLaunchSelection';

import type {
  CliProviderStatus,
  EffortLevel,
  TeamProviderId,
  TeamProvisioningPrepareIssue,
} from '@shared/types';

export const PROVIDER_MODEL_LIST_TIMEOUT_MS = 30_000;
export const PROVIDER_RUNTIME_STATUS_TIMEOUT_MS = 20_000;
export const CLI_HELP_CACHE_TTL_MS = 5 * 60 * 1000;

const PREFLIGHT_DEBUG_LOG_PATH = path.join(os.tmpdir(), 'claude-team-preflight-debug.log');

export function appendPreflightDebugLog(event: string, data: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      PREFLIGHT_DEBUG_LOG_PATH,
      `${JSON.stringify({
        at: new Date().toISOString(),
        event,
        ...data,
      })}\n`,
      'utf8'
    );
  } catch {
    // Best-effort debug logging only.
  }
}

export function truncatePreflightDebugText(value: string, maxLength = 1200): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

export function createProbeCacheKey(cwd: string, providerId: TeamProviderId | undefined): string {
  return `${path.resolve(cwd)}::${getClaudeBasePath()}::${resolveTeamProviderId(providerId)}`;
}

export async function validatePrepareCwd(cwd: string): Promise<void> {
  if (!path.isAbsolute(cwd)) {
    throw new Error('cwd must be an absolute path');
  }

  try {
    const stat = await fs.promises.stat(cwd);
    if (!stat.isDirectory()) {
      throw new Error('cwd must be a directory');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Allow the runtime probe to degrade a missing cwd into a warning.
      // This keeps prepareForProvisioning side-effect free for future/missing paths.
      return;
    }
    throw error;
  }
}

export type ProviderCompatibilityModelOutcome =
  | { kind: 'available'; resolvedModelId: string | null }
  | { kind: 'compatible'; reason: string }
  | { kind: 'unavailable'; reason: string };

export function resolveProviderCompatibilityModel(params: {
  providerId: TeamProviderId;
  requestedModelId: string;
  runtimeFacts: RuntimeProviderLaunchFacts;
  limitContext: boolean;
}): ProviderCompatibilityModelOutcome {
  const trimmedModelId = params.requestedModelId.trim();
  if (!trimmedModelId) {
    return {
      kind: 'unavailable',
      reason: 'Selected model id is empty.',
    };
  }

  if (isDefaultProviderModelSelection(trimmedModelId)) {
    return {
      kind: 'available',
      resolvedModelId: params.runtimeFacts.defaultModel,
    };
  }

  const availableModels = params.runtimeFacts.modelIds;
  let resolvedModelId: string | null = availableModels.has(trimmedModelId) ? trimmedModelId : null;

  if (!resolvedModelId && params.providerId === 'anthropic') {
    resolvedModelId =
      resolveAnthropicLaunchModel({
        selectedModel: trimmedModelId,
        limitContext: params.limitContext,
        availableLaunchModels: availableModels,
        defaultLaunchModel: params.runtimeFacts.defaultModel,
      }) ?? null;
  }

  if (!resolvedModelId && !trimmedModelId.includes('/')) {
    const scopedMatches = Array.from(availableModels).filter(
      (candidate) => candidate.split('/').at(-1) === trimmedModelId
    );
    if (scopedMatches.length === 1) {
      resolvedModelId = scopedMatches[0];
    } else if (scopedMatches.length > 1) {
      return {
        kind: 'unavailable',
        reason:
          `Selected model ${trimmedModelId} matched multiple live provider models: ` +
          scopedMatches.join(', '),
      };
    }
  }

  if (resolvedModelId && (availableModels.size === 0 || availableModels.has(resolvedModelId))) {
    return {
      kind: 'available',
      resolvedModelId,
    };
  }

  const dynamicCatalog = params.runtimeFacts.runtimeCapabilities?.modelCatalog?.dynamic === true;
  const hasAuthoritativeCatalog =
    params.providerId === 'codex'
      ? hasAuthoritativeCodexLaunchCatalog(params.runtimeFacts)
      : availableModels.size > 0 ||
        params.runtimeFacts.modelCatalog != null ||
        params.runtimeFacts.runtimeCapabilities?.modelCatalog?.dynamic === false;

  if (params.providerId === 'codex' && (dynamicCatalog || !hasAuthoritativeCatalog)) {
    return {
      kind: 'available',
      resolvedModelId: trimmedModelId,
    };
  }

  if (dynamicCatalog || !hasAuthoritativeCatalog) {
    return {
      kind: 'compatible',
      reason: dynamicCatalog
        ? 'Runtime catalog allows dynamic model launch.'
        : 'Runtime model catalog was unavailable.',
    };
  }

  return {
    kind: 'unavailable',
    reason: `Selected model ${trimmedModelId} was not found in the live provider catalog.`,
  };
}

interface ProviderPreflightEnvResolution {
  env: NodeJS.ProcessEnv;
  providerArgs?: string[];
}

export interface VerifySelectedProviderModelsPorts {
  buildProvisioningEnv(providerId: TeamProviderId): Promise<ProviderPreflightEnvResolution>;
  readRuntimeProviderLaunchFacts(params: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    env: NodeJS.ProcessEnv;
    providerArgs?: string[];
    limitContext?: boolean;
  }): Promise<RuntimeProviderLaunchFacts>;
  appendPreflightDebugLog?(event: string, data: Record<string, unknown>): void;
}

export async function verifySelectedProviderModelsForProvisioning({
  claudePath,
  cwd,
  providerId,
  modelIds,
  modelChecks,
  limitContext,
  ports,
}: {
  claudePath: string;
  cwd: string;
  providerId: TeamProviderId;
  modelIds: string[];
  modelChecks?: ProviderSelectedModelCheck[];
  limitContext: boolean;
  ports: VerifySelectedProviderModelsPorts;
}): Promise<{
  details: string[];
  warnings: string[];
  blockingMessages: string[];
  issues?: TeamProvisioningPrepareIssue[];
}> {
  const details: string[] = [];
  const warnings: string[] = [];
  const blockingMessages: string[] = [];
  const issues: TeamProvisioningPrepareIssue[] = [];
  const startedAt = Date.now();
  const selectedModelChecks = normalizeProviderSelectedModelChecks(modelIds, modelChecks);
  const debugLog = ports.appendPreflightDebugLog ?? appendPreflightDebugLog;

  if (selectedModelChecks.length === 0) {
    return { details, warnings, blockingMessages };
  }

  const { env, providerArgs = [] } = await ports.buildProvisioningEnv(providerId);
  const runtimeFacts = await ports.readRuntimeProviderLaunchFacts({
    claudePath,
    cwd,
    providerId,
    env,
    providerArgs,
    limitContext,
  });

  const recordOutcome = (
    requestedModelId: string,
    outcome: ProviderCompatibilityModelOutcome
  ): void => {
    if (outcome.kind === 'available') {
      details.push(`Selected model ${requestedModelId} is available for launch.`);
      return;
    }
    if (outcome.kind === 'compatible') {
      details.push(`Selected model ${requestedModelId} is compatible. Deep verification pending.`);
      return;
    }
    blockingMessages.push(`Selected model ${requestedModelId} is unavailable. ${outcome.reason}`);
    issues.push({
      providerId,
      modelId: requestedModelId,
      scope: 'model',
      severity: 'blocking',
      code: 'model_unavailable',
      message: outcome.reason,
    });
  };

  const recordAnthropicEffortOutcome = (requestedModelId: string, effort: EffortLevel): boolean => {
    const selection = resolveAnthropicSelectionFromFacts({
      selectedModel: requestedModelId,
      limitContext,
      facts: runtimeFacts,
    });
    const modelLabel = selection.displayName ?? selection.resolvedLaunchModel ?? requestedModelId;
    const effortSupport = resolveAnthropicEffortSupport({
      selection,
      effort,
      runtimeCapabilities: runtimeFacts.runtimeCapabilities,
    });
    if (effortSupport.kind === 'supported') {
      return true;
    }

    const reason = formatAnthropicEffortSupportFailure({
      effort,
      modelLabel,
      kind: effortSupport.kind,
      supportedEfforts:
        effortSupport.kind === 'unverified-catalog-missing'
          ? undefined
          : effortSupport.supportedEfforts,
    });
    blockingMessages.push(`Selected model ${requestedModelId} is unavailable. ${reason}`);
    issues.push({
      providerId,
      modelId: requestedModelId,
      scope: 'model',
      severity: 'blocking',
      code:
        effortSupport.kind === 'unverified-catalog-missing'
          ? 'effort_unverified'
          : 'effort_unsupported',
      message: reason,
    });
    return false;
  };

  debugLog('provider_model_catalog_check_start', {
    providerId,
    cwd,
    modelIds: selectedModelChecks.map((check) => check.modelId),
  });

  const checksByModelId = new Map<string, ProviderSelectedModelCheck[]>();
  for (const check of selectedModelChecks) {
    const label = check.modelId.trim();
    if (!label) {
      continue;
    }
    checksByModelId.set(label, [...(checksByModelId.get(label) ?? []), check]);
  }

  for (const [label, checks] of checksByModelId.entries()) {
    const outcome = resolveProviderCompatibilityModel({
      providerId,
      requestedModelId: label,
      runtimeFacts,
      limitContext,
    });
    let effortSupported = true;
    if (outcome.kind !== 'unavailable' && providerId === 'anthropic') {
      for (const check of checks) {
        if (check.effort && !recordAnthropicEffortOutcome(label, check.effort)) {
          effortSupported = false;
        }
      }
    }
    if (!effortSupported) {
      continue;
    }
    recordOutcome(label, outcome);
  }

  debugLog('provider_model_catalog_check_complete', {
    providerId,
    cwd,
    modelIds: selectedModelChecks.map((check) => check.modelId),
    durationMs: Date.now() - startedAt,
    modelCount: runtimeFacts.modelIds.size,
    details,
    warnings,
    blockingMessages,
  });

  return {
    details,
    warnings,
    blockingMessages,
    ...(issues.length > 0 ? { issues } : {}),
  };
}

export function buildRuntimeProviderReadinessWarning(
  providerId: TeamProviderId,
  providerStatus: Partial<CliProviderStatus> | null | undefined
): string | null {
  const providerLabel = getTeamProviderLabel(providerId);
  const detail = [providerStatus?.statusMessage?.trim(), providerStatus?.detailMessage?.trim()]
    .filter((entry): entry is string => Boolean(entry))
    .join(' ');

  if (!providerStatus) {
    return `${providerLabel} provider is not configured for runtime use. Runtime status did not include this provider.`;
  }
  if (providerStatus.supported === false) {
    return `${providerLabel} provider is not configured for runtime use.${
      detail ? ` ${detail}` : ''
    }`;
  }
  if (providerStatus.authenticated === false) {
    return `${providerLabel} provider is not authenticated.${detail ? ` ${detail}` : ''}`;
  }
  if (providerStatus.capabilities?.teamLaunch === false) {
    return `${providerLabel} provider is not configured for runtime use. Team launch is unavailable.${
      detail ? ` ${detail}` : ''
    }`;
  }

  return null;
}

export function extractAuthStatusReadiness(
  providerId: TeamProviderId,
  parsed: AuthStatusCommandResponse
): {
  authenticated: boolean | null;
  providerStatus: Partial<CliProviderStatus> | null;
} {
  const providerStatus =
    parsed.providers?.[providerId] ??
    (parsed.provider === providerId || !parsed.provider ? parsed.status : null) ??
    null;
  if (typeof providerStatus?.authenticated === 'boolean') {
    return {
      authenticated: providerStatus.authenticated,
      providerStatus,
    };
  }
  if (typeof parsed.loggedIn === 'boolean') {
    return {
      authenticated: parsed.loggedIn,
      providerStatus,
    };
  }
  return {
    authenticated: null,
    providerStatus,
  };
}

export async function probeProviderRuntimeControlPlane({
  claudePath,
  cwd,
  env,
  providerId,
  providerArgs,
  appendDebugLog = appendPreflightDebugLog,
}: {
  claudePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerId: TeamProviderId;
  providerArgs: string[];
  appendDebugLog?: (event: string, data: Record<string, unknown>) => void;
}): Promise<{ warning?: string }> {
  const cliCommandLabel = getConfiguredCliCommandLabel();
  const providerLabel = getTeamProviderLabel(providerId);

  try {
    const runtimeStatus = await execCli(
      claudePath,
      buildProviderControlPlaneCliCommandArgs(providerArgs, [
        'runtime',
        'status',
        '--json',
        '--summary',
        '--provider',
        providerId,
      ]),
      {
        cwd,
        env,
        timeout: PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
      }
    );
    const parsed = extractJsonObjectFromCli<RuntimeStatusCommandResponse>(runtimeStatus.stdout);
    const providerStatus = parsed.providers?.[providerId] ?? null;
    const warning = buildRuntimeProviderReadinessWarning(providerId, providerStatus);
    appendDebugLog('provider_runtime_control_plane_status', {
      providerId,
      cwd,
      ready: !warning,
      authenticated: providerStatus?.authenticated,
      teamLaunch: providerStatus?.capabilities?.teamLaunch,
      oneShot: providerStatus?.capabilities?.oneShot,
      warning,
    });
    return warning ? { warning } : {};
  } catch (runtimeStatusError) {
    const runtimeStatusMessage =
      runtimeStatusError instanceof Error ? runtimeStatusError.message : String(runtimeStatusError);
    try {
      const authStatus = await execCli(
        claudePath,
        buildProviderControlPlaneCliCommandArgs(providerArgs, [
          'auth',
          'status',
          '--json',
          '--provider',
          providerId,
        ]),
        {
          cwd,
          env,
          timeout: 8_000,
        }
      );
      const parsed = extractJsonObjectFromCli<AuthStatusCommandResponse>(authStatus.stdout);
      const authReadiness = extractAuthStatusReadiness(providerId, parsed);
      const readinessWarning = authReadiness.providerStatus
        ? buildRuntimeProviderReadinessWarning(providerId, authReadiness.providerStatus)
        : null;
      if (authReadiness.authenticated === false || readinessWarning) {
        const authWarning =
          readinessWarning ??
          `${providerLabel} provider is not authenticated. Runtime auth status reported logged out.`;
        appendDebugLog('provider_runtime_control_plane_auth_fallback', {
          providerId,
          cwd,
          ready: false,
          runtimeStatusError: runtimeStatusMessage,
          warning: authWarning,
        });
        return { warning: authWarning };
      }
      if (authReadiness.authenticated === true) {
        const warning =
          `${cliCommandLabel} runtime status was unavailable, but auth status passed. ` +
          `Proceeding with catalog checks. Details: ${runtimeStatusMessage}`;
        appendDebugLog('provider_runtime_control_plane_auth_fallback', {
          providerId,
          cwd,
          ready: true,
          runtimeStatusError: runtimeStatusMessage,
          warning,
        });
        return { warning };
      }
    } catch (authStatusError) {
      const authStatusMessage =
        authStatusError instanceof Error ? authStatusError.message : String(authStatusError);
      appendDebugLog('provider_runtime_control_plane_auth_fallback', {
        providerId,
        cwd,
        ready: false,
        runtimeStatusError: runtimeStatusMessage,
        authStatusError: authStatusMessage,
      });
      return {
        warning:
          `${cliCommandLabel} runtime status check did not complete. ` +
          `Proceeding with catalog checks. Details: ${runtimeStatusMessage}; auth status failed: ${authStatusMessage}`,
      };
    }

    return {
      warning:
        `${cliCommandLabel} runtime status was unavailable and auth status did not report ${providerLabel} authentication. ` +
        `Proceeding with catalog checks. Details: ${runtimeStatusMessage}`,
    };
  }
}

export interface WarmupProviderPreflightPorts {
  getFreshCachedProbeResult(cwd: string, providerId: TeamProviderId): unknown | null;
  getCachedOrProbeResult(
    cwd: string,
    providerId: TeamProviderId
  ): Promise<{ claudePath?: string } | null>;
  info(message: string): void;
  warn(message: string): void;
}

export async function warmupProviderPreflight({
  cwd = process.cwd(),
  providerId = 'anthropic',
  ports,
}: {
  cwd?: string;
  providerId?: TeamProviderId;
  ports: WarmupProviderPreflightPorts;
}): Promise<void> {
  try {
    if (ports.getFreshCachedProbeResult(cwd, providerId)) return;
    const result = await ports.getCachedOrProbeResult(cwd, providerId);
    if (!result) return;
    ports.info('CLI warmup completed');
  } catch (error) {
    ports.warn(`CLI warmup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface CliHelpOutputCache {
  output: string | null;
  cachedAtMs: number;
}

export interface CliHelpOutputPorts {
  getCachedOrProbeResult(
    cwd: string,
    providerId: TeamProviderId
  ): Promise<{ claudePath?: string } | null>;
  buildProvisioningEnv(): Promise<{ env: NodeJS.ProcessEnv }>;
  spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

export async function getCliHelpOutputForProvisioning({
  cwd,
  cache,
  ports,
  now = Date.now,
}: {
  cwd?: string;
  cache: CliHelpOutputCache;
  ports: CliHelpOutputPorts;
  now?: () => number;
}): Promise<string> {
  if (cache.output && now() - cache.cachedAtMs < CLI_HELP_CACHE_TTL_MS) {
    return cache.output;
  }
  const targetCwd = cwd ?? process.cwd();
  const probeResult = await ports.getCachedOrProbeResult(targetCwd, 'anthropic');
  if (!probeResult?.claudePath) {
    throw new Error(`${getConfiguredCliCommandLabel()} not found`);
  }
  const { env } = await ports.buildProvisioningEnv();
  const result = await ports.spawnProbe(probeResult.claudePath, ['--help'], targetCwd, env, 10_000);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!output) {
    throw new Error(
      `${getConfiguredCliCommandLabel()} --help returned empty output (exit code: ${String(result.exitCode)})`
    );
  }
  cache.output = output;
  cache.cachedAtMs = now();
  return output;
}

export function buildAgentTeamsMcpValidationError(
  output: string,
  normalizeApiRetryErrorMessage: (text: string) => string = (text) => text.trim()
): string {
  const prefix = 'agent-teams MCP preflight failed before team launch.';
  const rawDetail = output.trim();
  if (rawDetail === prefix || rawDetail.startsWith(`${prefix} Details:`)) {
    return rawDetail;
  }

  const detail = normalizeApiRetryErrorMessage(output) || rawDetail;
  if (detail === prefix || detail.startsWith(`${prefix} Details:`)) {
    return detail;
  }
  if (!detail) {
    return prefix;
  }
  return `${prefix} Details: ${detail}`;
}
