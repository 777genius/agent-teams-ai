import {
  isPureOpenCodeSoloLanePlan,
  OPEN_CODE_SOLO_MEMBER_NAME,
  OPEN_CODE_SOLO_MEMBER_ROLE,
  type TeamRuntimeLanePlan,
} from '@features/team-runtime-lanes';
import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { isLeadMember } from '@shared/utils/leadDetection';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { buildProviderControlPlaneCliCommandArgs } from '../../runtime/providerCliCommandArgs';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import { pushUniqueSupportDiagnostics } from './TeamProvisioningDiagnosticsHelpers';
import {
  isAnthropicDirectCredentialAuthSource,
  type ProvisioningEnvResolution,
  type TeamRuntimeAuthContext,
} from './TeamProvisioningEnvBuilder';
import { copyLaunchPreparationEvidence } from './TeamProvisioningLaunchPreparationEvidence';
import {
  buildEffectiveTeamMemberSpec,
  normalizeTeamMemberProviderId,
} from './TeamProvisioningMemberSpecs';
import {
  normalizeOpenCodePrepareDiagnostic,
  selectOpenCodePrepareProviderDiagnostic,
} from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import { prepareSelectedOpenCodeModelsForProvisioning } from './TeamProvisioningOpenCodeModelPreparation';
import { isAuthFailureWarning } from './TeamProvisioningOutputErrorPolicy';
import { runExactBackendOneShotDiagnostics } from './TeamProvisioningPrepareBackendDiagnostics';
import { createPrepareForProvisioningInFlightKey as buildPrepareForProvisioningInFlightKey } from './TeamProvisioningPrepareCachePolicy';
import { buildPrepareResultWithEvidence } from './TeamProvisioningPrepareResultEvidence';
import { isBinaryProbeWarning, isTransientProbeWarning } from './TeamProvisioningProbeWarnings';
import {
  appendPreflightDebugLog,
  createProbeCacheKey,
  PROVIDER_MODEL_LIST_TIMEOUT_MS,
  PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
  validatePrepareCwd as validatePrepareCwdForProvisioning,
  verifySelectedProviderModelsForProvisioning,
} from './TeamProvisioningProviderPreflight';
import {
  cachedProviderProbeResultToProbeResult,
  cloneCachedProviderProbeResult,
  cloneProviderProbeResult,
} from './TeamProvisioningProviderProbeCache';
import { getTeamProviderLabel } from './TeamProvisioningRuntimeDiagnostics';
import { buildMissingCliError } from './TeamProvisioningRuntimeFailureLabels';
import {
  extractJsonObjectFromCli,
  normalizeProviderModelListModels,
  normalizeProvisioningModelCheckRequests,
  type ProviderModelListCommandResponse,
  type RuntimeProviderLaunchFacts,
  type RuntimeStatusCommandResponse,
} from './TeamProvisioningRuntimeLaunchSelection';

import type { OpenCodeStrictLaunchDelegationValidator, TeamLaunchRuntimeAdapter } from '../runtime';
import type { OpenCodeSelectedModelPreparationInput } from './TeamProvisioningOpenCodeModelPreparation';
import type {
  CachedProbeResult,
  ProbeResult,
  ProviderProbeCachePort,
} from './TeamProvisioningProviderProbeCache';
import type {
  EffortLevel,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareIssue,
  TeamProvisioningPrepareResult,
  TeamProvisioningSupportDiagnostic,
} from '@shared/types';
export { createDefaultTeamProvisioningPrepareCoordinatorPorts } from './TeamProvisioningPrepareCoordinatorDefaults';
export type {
  CachedProbeResult,
  ProbeResult,
  ProviderProbeCachePort,
  ProviderProbePublication,
} from './TeamProvisioningProviderProbeCache';
export { createInMemoryProviderProbeCachePort } from './TeamProvisioningProviderProbeCache';
export interface PrepareForProvisioningOptions {
  forceFresh?: boolean;
  providerId?: TeamProviderId;
  providerIds?: TeamProviderId[];
  modelIds?: string[];
  modelChecks?: TeamProvisioningModelCheckRequest[];
  limitContext?: boolean;
  modelVerificationMode?: TeamProvisioningModelVerificationMode;
  allowExperimentalLocalModels?: boolean;
}
export interface TeamProvisioningPrepareCoordinatorPorts {
  providerProbeCache: ProviderProbeCachePort;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  getOpenCodeStrictLaunchDelegationValidator(): OpenCodeStrictLaunchDelegationValidator | null;
  buildProvisioningEnv(
    providerId?: TeamProviderId,
    providerBackendId?: string | null,
    options?: { teamRuntimeAuth?: TeamRuntimeAuthContext }
  ): Promise<ProvisioningEnvResolution>;
  runProviderOneShotDiagnostic(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId,
    providerArgs: string[],
    exactCheck?: TeamProvisioningModelCheckRequest
  ): Promise<{ warning?: string; targetedLiveness?: TeamProvisioningModelCheckRequest }>;
  readRuntimeProviderLaunchFacts(params: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    providerBackendId?: string | null;
    env: NodeJS.ProcessEnv;
    providerArgs?: string[];
    limitContext?: boolean;
  }): Promise<RuntimeProviderLaunchFacts>;
  resolveClaudeBinaryPath(): Promise<string | null>;
  probeClaudeRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId | undefined,
    providerArgs: string[]
  ): Promise<{ warning?: string }>;
  ensureMemberWorktree(input: {
    teamName: string;
    memberName: string;
    baseCwd: string;
  }): Promise<{ worktreePath: string }>;
  execCli(
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }
  ): Promise<{ stdout: string }>;
  validatePrepareCwd?(cwd: string): Promise<void>;
  verifySelectedProviderModels?(input: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    providerBackendId?: string | null;
    modelIds: string[];
    modelChecks?: { modelId: string; effort?: EffortLevel }[];
    limitContext: boolean;
  }): Promise<{
    details: string[];
    warnings: string[];
    blockingMessages: string[];
    issues?: TeamProvisioningPrepareIssue[];
  }>;
  resolveProviderDefaultModel?(
    claudePath: string,
    cwd: string,
    providerId: TeamProviderId,
    env: NodeJS.ProcessEnv,
    providerArgs: string[],
    limitContext: boolean
  ): Promise<string | null>;
  inspectOpenCodeLocalModelRuntime?: OpenCodeSelectedModelPreparationInput['inspectLocalModelRuntime'];
  info(message: string): void;
  warn(message: string): void;
}
export class TeamProvisioningPrepareCoordinator {
  private readonly prepareForProvisioningInFlight = new Map<
    string,
    Promise<TeamProvisioningPrepareResult>
  >();

  constructor(private readonly ports: TeamProvisioningPrepareCoordinatorPorts) {}

  async warmup(): Promise<void> {
    try {
      const cwd = process.cwd();
      const providerId: TeamProviderId = 'anthropic';
      if (this.getFreshCachedProbeResult(cwd, providerId)) {
        return;
      }
      const result = await this.getCachedOrProbeResult(cwd, providerId);
      if (!result) return;
      this.ports.info('CLI warmup completed');
    } catch (error) {
      this.ports.warn(
        `CLI warmup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async prepareForProvisioning(
    cwd?: string,
    opts?: PrepareForProvisioningOptions
  ): Promise<TeamProvisioningPrepareResult> {
    const inFlightKey = this.createPrepareForProvisioningInFlightKey(cwd, opts);
    const inFlight = this.prepareForProvisioningInFlight.get(inFlightKey);
    if (inFlight) {
      return this.clonePrepareForProvisioningResult(await inFlight);
    }
    const request = this.prepareForProvisioningOnce(cwd, opts).finally(() => {
      if (this.prepareForProvisioningInFlight.get(inFlightKey) === request) {
        this.prepareForProvisioningInFlight.delete(inFlightKey);
      }
    });
    this.prepareForProvisioningInFlight.set(inFlightKey, request);
    return this.clonePrepareForProvisioningResult(await request);
  }
  createPrepareForProvisioningInFlightKey(
    cwd?: string,
    opts?: PrepareForProvisioningOptions
  ): string {
    return buildPrepareForProvisioningInFlightKey(cwd, opts);
  }
  clonePrepareForProvisioningResult(
    result: TeamProvisioningPrepareResult
  ): TeamProvisioningPrepareResult {
    return copyLaunchPreparationEvidence(result, structuredClone(result));
  }
  async prepareForProvisioningOnce(
    cwd?: string,
    opts?: PrepareForProvisioningOptions
  ): Promise<TeamProvisioningPrepareResult> {
    const targetCwdForValidation = cwd?.trim() || process.cwd();
    await (this.ports.validatePrepareCwd ?? this.validatePrepareCwd.bind(this))(
      targetCwdForValidation
    );
    const providerIds = Array.from(
      new Set(
        [opts?.providerId, ...(opts?.providerIds ?? [])]
          .filter((providerId): providerId is TeamProviderId => providerId != null)
          .map((providerId) => resolveTeamProviderId(providerId))
          .filter((providerId): providerId is TeamProviderId => Boolean(providerId))
      )
    );
    if (providerIds.length === 0) {
      providerIds.push('anthropic');
    }
    if (opts?.forceFresh) {
      for (const providerId of providerIds) {
        this.clearProbeCache(targetCwdForValidation, providerId);
      }
    }
    const targetCwd = cwd?.trim() || process.cwd();
    if (!path.isAbsolute(targetCwd)) {
      throw new Error('cwd must be an absolute path');
    }
    const warnings: string[] = [];
    const details: string[] = [];
    const blockingMessages: string[] = [];
    const issues: TeamProvisioningPrepareIssue[] = [];
    const supportDiagnostics: TeamProvisioningSupportDiagnostic[] = [];
    const processedModelChecks: TeamProvisioningModelCheckRequest[] = [];
    const nativeModelTargetedLivenessChecks: TeamProvisioningModelCheckRequest[] = [];
    const openCodeStrictDelegationChecks: TeamProvisioningModelCheckRequest[] = [];
    const selectedModelIds = Array.from(
      new Set((opts?.modelIds ?? []).map((modelId) => modelId.trim()).filter(Boolean))
    );
    const selectedModelChecks = normalizeProvisioningModelCheckRequests(opts?.modelChecks);
    const useStructuredModelChecks = selectedModelChecks.length > 0;
    for (const providerId of providerIds) {
      const providerModelChecks = selectedModelChecks
        .filter((check) => check.providerId === providerId)
        .map((check) => ({
          modelId: check.model,
          providerBackendId: Object.hasOwn(check, 'providerBackendId')
            ? (check.providerBackendId ?? null)
            : undefined,
          ...(check.effort ? { effort: check.effort } : {}),
        }));
      const providerSelectedModelIds = useStructuredModelChecks
        ? Array.from(new Set(providerModelChecks.map((check) => check.modelId)))
        : selectedModelIds;
      if (providerId === 'opencode') {
        const adapter = this.ports.getOpenCodeRuntimeAdapter();
        if (!adapter) {
          blockingMessages.push(
            'OpenCode team launch is not enabled yet. Production launch requires the gated OpenCode runtime adapter.'
          );
          continue;
        }
        if (providerSelectedModelIds.length === 0) {
          const prepare = await adapter.prepare({
            runId: `prepare-${randomUUID()}`,
            teamName: '__prepare_opencode__',
            cwd: targetCwd,
            providerId: 'opencode',
            model: undefined,
            runtimeOnly: true,
            skipPermissions: true,
            expectedMembers: [],
            previousLaunchState: null,
          });
          const prepareReason = prepare.ok ? undefined : prepare.reason;
          details.push(
            ...prepare.diagnostics.map((diagnostic) =>
              normalizeOpenCodePrepareDiagnostic(diagnostic, prepareReason)
            )
          );
          warnings.push(
            ...prepare.warnings.map((warning) =>
              normalizeOpenCodePrepareDiagnostic(warning, prepareReason)
            )
          );
          pushUniqueSupportDiagnostics(supportDiagnostics, prepare.supportDiagnostics);
          if (!prepare.ok) {
            const providerDiagnostic = selectOpenCodePrepareProviderDiagnostic(prepare);
            blockingMessages.push(
              providerDiagnostic
                ? normalizeOpenCodePrepareDiagnostic(providerDiagnostic, prepare.reason)
                : normalizeOpenCodePrepareDiagnostic(`OpenCode: ${prepare.reason}`, prepare.reason)
            );
          }
          continue;
        }
        const exactChecks = selectedModelChecks.filter((check) => check.providerId === providerId);
        const checkGroups = new Map<string, TeamProvisioningModelCheckRequest[]>();
        for (const check of exactChecks) {
          const backendKey = Object.hasOwn(check, 'providerBackendId')
            ? (check.providerBackendId ?? '<null>')
            : '<missing>';
          checkGroups.set(backendKey, [...(checkGroups.get(backendKey) ?? []), check]);
        }
        const groups =
          checkGroups.size > 0
            ? Array.from(checkGroups.values())
            : [providerSelectedModelIds.map((model) => ({ providerId, model, effort: undefined }))];
        for (const group of groups) {
          const openCodeModelPrepare = await prepareSelectedOpenCodeModelsForProvisioning({
            adapter,
            cwd: targetCwd,
            modelIds: Array.from(new Set(group.map((check) => check.model))),
            modelChecks: group.map((check) => ({
              modelId: check.model,
              ...(check.effort ? { effort: check.effort } : {}),
            })),
            verificationMode: opts?.modelVerificationMode ?? 'deep',
            allowExperimentalLocalModels: opts?.allowExperimentalLocalModels === true,
            appendPreflightDebugLog,
            inspectLocalModelRuntime: this.ports.inspectOpenCodeLocalModelRuntime,
          });
          details.push(...openCodeModelPrepare.details);
          warnings.push(...openCodeModelPrepare.warnings);
          blockingMessages.push(...openCodeModelPrepare.blockingMessages);
          issues.push(...openCodeModelPrepare.issues);
          pushUniqueSupportDiagnostics(supportDiagnostics, openCodeModelPrepare.supportDiagnostics);
          const preparedChecks = openCodeModelPrepare.processedModelChecks.flatMap(
            (processedCheck) =>
              group
                .filter(
                  (check) =>
                    check.model === processedCheck.modelId &&
                    (check.effort ?? undefined) === (processedCheck.effort ?? undefined)
                )
                .slice(0, 1)
          );
          processedModelChecks.push(...preparedChecks);
          if (preparedChecks.length > 0) {
            const validateDelegation = this.ports.getOpenCodeStrictLaunchDelegationValidator();
            if (!validateDelegation) {
              blockingMessages.push('OpenCode strict launch delegation validation is unavailable.');
            } else {
              for (const check of preparedChecks) {
                const delegation = await validateDelegation({
                  cwd: targetCwd,
                });
                if (!delegation.ok) {
                  blockingMessages.push(
                    `OpenCode strict launch delegation validation failed: ${delegation.reason}`
                  );
                  continue;
                }
                openCodeStrictDelegationChecks.push(check);
              }
            }
          }
        }
        continue;
      }
      const cached = this.getFreshCachedProbeResult(targetCwdForValidation, providerId);
      const probeResult = cached
        ? cachedProviderProbeResultToProbeResult(cached)
        : await this.getCachedOrProbeResult(targetCwd, providerId);
      if (!probeResult?.claudePath) {
        throw buildMissingCliError();
      }
      const providerLabel = getTeamProviderLabel(providerId);
      const { authSource } = probeResult;
      if (authSource === 'anthropic_api_key' || authSource === 'anthropic_api_key_helper') {
        this.ports.info(`Auth: using explicit ANTHROPIC_API_KEY for ${providerLabel}`);
      } else if (authSource === 'anthropic_auth_token') {
        this.ports.info(
          `Auth: using ANTHROPIC_AUTH_TOKEN mapped to ANTHROPIC_API_KEY for ${providerLabel}`
        );
      }
      const appendSelectedModelVerification = async (): Promise<void> => {
        if (providerSelectedModelIds.length === 0) {
          return;
        }
        const checksByBackend = new Map<string, typeof providerModelChecks>();
        for (const check of providerModelChecks) {
          const key =
            check.providerBackendId === undefined
              ? '<missing>'
              : (check.providerBackendId ?? '<null>');
          checksByBackend.set(key, [...(checksByBackend.get(key) ?? []), check]);
        }
        if (checksByBackend.size === 0) checksByBackend.set('<missing>', []);
        for (const checksForBackend of checksByBackend.values()) {
          const providerBackendId = checksForBackend[0]?.providerBackendId;
          const modelVerification = await (
            this.ports.verifySelectedProviderModels ?? this.verifySelectedProviderModels.bind(this)
          )({
            claudePath: probeResult.claudePath,
            cwd: targetCwd,
            providerId,
            providerBackendId,
            modelIds:
              checksForBackend.length > 0
                ? Array.from(new Set(checksForBackend.map((check) => check.modelId)))
                : providerSelectedModelIds,
            modelChecks: checksForBackend,
            limitContext: opts?.limitContext === true,
          });
          details.push(...modelVerification.details);
          warnings.push(...modelVerification.warnings);
          blockingMessages.push(...modelVerification.blockingMessages);
          issues.push(...(modelVerification.issues ?? []));
        }
      };
      const appendOneShotDiagnostic = async (): Promise<void> => {
        const diagnostic = await runExactBackendOneShotDiagnostics({
          providerId,
          providerLabel,
          providerCount: providerIds.length,
          backendIds: Array.from(
            new Set(providerModelChecks.map((check) => check.providerBackendId))
          ),
          modelChecks: selectedModelChecks.filter((check) => check.providerId === providerId),
          modelVerificationMode: opts?.modelVerificationMode,
          authSource,
          claudePath: probeResult.claudePath,
          cwd: targetCwd,
          buildProvisioningEnv: (id, backendId) => this.ports.buildProvisioningEnv(id, backendId),
          runProviderOneShotDiagnostic: (...args) =>
            this.ports.runProviderOneShotDiagnostic(...args),
        });
        warnings.push(...diagnostic.warnings);
        blockingMessages.push(...diagnostic.blockingMessages);
        processedModelChecks.push(...diagnostic.targetedLivenessChecks);
        nativeModelTargetedLivenessChecks.push(...diagnostic.targetedLivenessChecks);
      };
      if (!probeResult.warning) {
        const blockingCountBeforeModelChecks = blockingMessages.length;
        await appendSelectedModelVerification();
        if (blockingMessages.length === blockingCountBeforeModelChecks) {
          await appendOneShotDiagnostic();
        }
        continue;
      }
      {
        const prefixedWarning =
          providerIds.length > 1 ? `${providerLabel}: ${probeResult.warning}` : probeResult.warning;
        const isAuthFailure = isAuthFailureWarning(probeResult.warning, 'probe');
        const isBlockingPreflightWarning =
          authSource === 'configured_api_key_missing' ||
          (isAnthropicDirectCredentialAuthSource(authSource) && isAuthFailure) ||
          ((authSource === 'none' ||
            authSource === 'codex_runtime' ||
            authSource === 'gemini_runtime') &&
            isAuthFailure) ||
          isBinaryProbeWarning(probeResult.warning);
        if (authSource === 'configured_api_key_missing') {
          blockingMessages.push(prefixedWarning);
        } else if (
          (authSource === 'none' ||
            authSource === 'codex_runtime' ||
            authSource === 'gemini_runtime') &&
          isAuthFailure
        ) {
          blockingMessages.push(prefixedWarning);
        } else if (isAnthropicDirectCredentialAuthSource(authSource) && isAuthFailure) {
          blockingMessages.push(prefixedWarning);
        } else if (isBinaryProbeWarning(probeResult.warning)) {
          blockingMessages.push(prefixedWarning);
        } else {
          warnings.push(prefixedWarning);
          const blockingCountBeforeModelChecks = blockingMessages.length;
          if (!isBlockingPreflightWarning && providerSelectedModelIds.length > 0) {
            await appendSelectedModelVerification();
          }
          if (
            !isBlockingPreflightWarning &&
            blockingMessages.length === blockingCountBeforeModelChecks
          ) {
            await appendOneShotDiagnostic();
          }
        }
      }
    }
    if (blockingMessages.length > 0) {
      const failureWarnings = Array.from(new Set([...warnings, ...blockingMessages]));
      return buildPrepareResultWithEvidence({
        ready: false,
        details,
        message:
          blockingMessages.length === 1
            ? blockingMessages[0]
            : 'Some provider runtimes are not ready',
        warnings: failureWarnings,
        issues,
        supportDiagnostics,
        processedModelChecks,
        nativeModelTargetedLivenessChecks,
        openCodeStrictDelegationChecks,
      });
    }
    return buildPrepareResultWithEvidence({
      ready: true,
      details,
      message:
        providerIds.length > 1
          ? warnings.length > 0
            ? `Validated ${providerIds.length}/${providerIds.length} provider runtimes (see notes)`
            : `Validated ${providerIds.length}/${providerIds.length} provider runtimes`
          : warnings.length > 0
            ? 'CLI is ready to launch (see notes)'
            : 'CLI is warmed up and ready to launch',
      warnings,
      issues,
      supportDiagnostics,
      processedModelChecks,
      nativeModelTargetedLivenessChecks,
      openCodeStrictDelegationChecks,
    });
  }
  async verifySelectedProviderModels({
    claudePath,
    cwd,
    providerId,
    providerBackendId,
    modelIds,
    modelChecks,
    limitContext,
  }: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    providerBackendId?: string | null;
    modelIds: string[];
    modelChecks?: { modelId: string; effort?: EffortLevel }[];
    limitContext: boolean;
  }): Promise<{
    details: string[];
    warnings: string[];
    blockingMessages: string[];
    issues?: TeamProvisioningPrepareIssue[];
  }> {
    return verifySelectedProviderModelsForProvisioning({
      claudePath,
      cwd,
      providerId,
      modelIds,
      modelChecks,
      limitContext,
      ports: {
        buildProvisioningEnv: (providerIdForEnv) =>
          this.ports.buildProvisioningEnv(providerIdForEnv, providerBackendId),
        readRuntimeProviderLaunchFacts: (params) =>
          this.ports.readRuntimeProviderLaunchFacts(params),
        appendPreflightDebugLog,
      },
    });
  }
  async resolveProviderDefaultModel(
    claudePath: string,
    cwd: string,
    providerId: TeamProviderId,
    env: NodeJS.ProcessEnv,
    providerArgs: string[] = [],
    limitContext: boolean
  ): Promise<string | null> {
    let parsed: ProviderModelListCommandResponse;
    try {
      const { stdout } = await this.ports.execCli(
        claudePath,
        buildProviderControlPlaneCliCommandArgs(providerArgs, [
          'model',
          'list',
          '--json',
          '--provider',
          providerId,
        ]),
        {
          cwd,
          env,
          timeout: PROVIDER_MODEL_LIST_TIMEOUT_MS,
        }
      );
      parsed = extractJsonObjectFromCli<ProviderModelListCommandResponse>(stdout);
    } catch (error) {
      const fallbackDefaultModel = await this.resolveProviderDefaultModelFromRuntimeStatus(
        claudePath,
        cwd,
        providerId,
        env,
        providerArgs,
        limitContext
      ).catch(() => null);
      if (fallbackDefaultModel) {
        return fallbackDefaultModel;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load runtime default model list for ${getTeamProviderLabel(providerId)} (${providerId}): ${message}`
      );
    }
    const defaultModel = parsed.providers?.[providerId]?.defaultModel;
    const normalizedDefaultModel =
      typeof defaultModel === 'string' && defaultModel.trim().length > 0
        ? defaultModel.trim()
        : null;
    const modelIds = normalizeProviderModelListModels(parsed.providers?.[providerId]);
    if (providerId === 'anthropic') {
      return resolveAnthropicLaunchModel({
        limitContext,
        availableLaunchModels: modelIds,
        defaultLaunchModel: normalizedDefaultModel,
      });
    }
    if (normalizedDefaultModel) {
      return normalizedDefaultModel;
    }
    return this.resolveProviderDefaultModelFromRuntimeStatus(
      claudePath,
      cwd,
      providerId,
      env,
      providerArgs,
      limitContext
    ).catch(() => null);
  }
  async resolveProviderDefaultModelFromRuntimeStatus(
    claudePath: string,
    cwd: string,
    providerId: TeamProviderId,
    env: NodeJS.ProcessEnv,
    providerArgs: string[] = [],
    limitContext: boolean
  ): Promise<string | null> {
    const { stdout } = await this.ports.execCli(
      claudePath,
      buildProviderControlPlaneCliCommandArgs(providerArgs, [
        'runtime',
        'status',
        '--json',
        '--provider',
        providerId,
      ]),
      {
        cwd,
        env,
        timeout: PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
      }
    );
    const parsed = extractJsonObjectFromCli<RuntimeStatusCommandResponse>(stdout);
    const providerStatus = parsed.providers?.[providerId] ?? null;
    const modelCatalog =
      providerStatus?.modelCatalog?.providerId === providerId ? providerStatus.modelCatalog : null;
    const defaultLaunchModel = modelCatalog?.defaultLaunchModel?.trim() || null;
    if (providerId === 'anthropic') {
      return resolveAnthropicLaunchModel({
        limitContext,
        availableLaunchModels: modelCatalog?.models.map((model) => model.launchModel) ?? [],
        defaultLaunchModel,
      });
    }
    return defaultLaunchModel;
  }
  async materializeEffectiveTeamMemberSpecs(params: {
    claudePath: string;
    cwd: string;
    members: TeamCreateRequest['members'];
    defaults: Pick<TeamCreateRequest, 'providerId' | 'providerBackendId' | 'model' | 'effort'>;
    primaryProviderId?: TeamProviderId;
    primaryEnv?: ProvisioningEnvResolution;
    teamRuntimeAuth?: TeamRuntimeAuthContext;
    limitContext?: boolean;
    providerArgsResolver?: (input: {
      providerId: TeamProviderId;
      providerArgs: string[];
      phase: 'default-model-resolution';
    }) => string[];
  }): Promise<TeamCreateRequest['members']> {
    const envByProvider = new Map<TeamProviderId, Promise<ProvisioningEnvResolution>>();
    const defaultModelByProvider = new Map<TeamProviderId, Promise<string>>();
    const normalizedPrimaryProviderId = resolveTeamProviderId(params.primaryProviderId);
    const getProvisioningEnv = (providerId: TeamProviderId): Promise<ProvisioningEnvResolution> => {
      if (normalizedPrimaryProviderId === providerId && params.primaryEnv != null) {
        return Promise.resolve(params.primaryEnv);
      }

      const cached = envByProvider.get(providerId);
      if (cached) {
        return cached;
      }

      const created = this.ports.buildProvisioningEnv(providerId, undefined, {
        teamRuntimeAuth: params.teamRuntimeAuth,
      });
      envByProvider.set(providerId, created);
      return created;
    };

    const getResolvedDefaultModel = (providerId: TeamProviderId): Promise<string> => {
      const cached = defaultModelByProvider.get(providerId);
      if (cached) {
        return cached;
      }

      const providerLabel = getTeamProviderLabel(providerId);
      const created = (async () => {
        const envResolution = await getProvisioningEnv(providerId);
        if (envResolution.warning) {
          throw new Error(envResolution.warning);
        }

        const resolvedDefaultModel = await (
          this.ports.resolveProviderDefaultModel ?? this.resolveProviderDefaultModel.bind(this)
        )(
          params.claudePath,
          params.cwd,
          providerId,
          envResolution.env,
          params.providerArgsResolver?.({
            providerId,
            providerArgs: envResolution.providerArgs ?? [],
            phase: 'default-model-resolution',
          }) ??
            envResolution.providerArgs ??
            [],
          params.limitContext === true
        );
        const normalized = resolvedDefaultModel?.trim();
        if (!normalized) {
          throw new Error(
            `Could not resolve the runtime default model for ${providerLabel} teammates. Select an explicit model and retry.`
          );
        }
        return normalized;
      })();

      defaultModelByProvider.set(providerId, created);
      return created;
    };

    const effectiveMembers: TeamCreateRequest['members'] = [];
    for (const member of params.members) {
      const effectiveMember = buildEffectiveTeamMemberSpec(member, params.defaults);
      const providerId = normalizeTeamMemberProviderId(effectiveMember.providerId) ?? 'anthropic';
      if (providerId === 'anthropic' || effectiveMember.model?.trim()) {
        effectiveMembers.push(effectiveMember);
        continue;
      }

      effectiveMembers.push({
        ...effectiveMember,
        model: await getResolvedDefaultModel(providerId),
      });
    }

    return effectiveMembers;
  }

  getOpenCodeRuntimeLaunchCwd(fallbackCwd: string, members: TeamCreateRequest['members']): string {
    if (members.length > 1 && members.some((member) => member.isolation === 'worktree')) {
      throw new Error(
        'OpenCode worktree isolation currently supports one isolated OpenCode member per runtime lane.'
      );
    }
    const memberCwds = [
      ...new Set(
        members.map((member) => member.cwd?.trim()).filter((cwd): cwd is string => Boolean(cwd))
      ),
    ];
    if (memberCwds.length === 0) {
      return fallbackCwd;
    }
    if (memberCwds.length === 1) {
      return memberCwds[0];
    }
    throw new Error(
      'OpenCode runtime lanes support exactly one project path per lane. Use separate OpenCode worktree-root lanes for per-teammate worktree isolation.'
    );
  }

  buildOpenCodeRuntimeAdapterLaunchMembers(
    request: TeamCreateRequest | TeamLaunchRequest,
    members: TeamCreateRequest['members'],
    lanePlan?: TeamRuntimeLanePlan
  ): TeamCreateRequest['members'] {
    if (resolveTeamProviderId(request.providerId) !== 'opencode') {
      return members;
    }
    const runtimeMembers: TeamCreateRequest['members'] = [...members];
    if (
      lanePlan &&
      isPureOpenCodeSoloLanePlan(lanePlan) &&
      !runtimeMembers.some(
        (member) => member.name.trim().toLowerCase() === OPEN_CODE_SOLO_MEMBER_NAME
      )
    ) {
      runtimeMembers.push({
        name: lanePlan.soloMember.name,
        role: lanePlan.soloMember.role ?? OPEN_CODE_SOLO_MEMBER_ROLE,
        providerId: 'opencode',
        providerBackendId: request.providerBackendId,
        model: lanePlan.soloMember.model ?? request.model,
        effort: lanePlan.soloMember.effort ?? request.effort,
        fastMode: lanePlan.soloMember.fastMode ?? request.fastMode,
        cwd: lanePlan.soloMember.cwd?.trim() || request.cwd,
      });
    }
    if (runtimeMembers.some((member) => isLeadMember(member))) {
      return runtimeMembers;
    }

    return [
      {
        name: 'team-lead',
        role: 'Team Lead',
        providerId: 'opencode',
        model: request.model,
        effort: request.effort,
      },
      ...runtimeMembers,
    ];
  }

  async resolveOpenCodeMemberWorkspacesForRuntime(params: {
    teamName: string;
    baseCwd: string;
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): Promise<TeamCreateRequest['members']> {
    const isolatedOpenCodeMembers = params.members.filter((member) => {
      const providerId = normalizeTeamMemberProviderId(member.providerId);
      return providerId === 'opencode' && member.isolation === 'worktree';
    });
    if (isolatedOpenCodeMembers.length === 0) {
      return params.members;
    }

    const nextMembers: TeamCreateRequest['members'] = [];
    for (const member of params.members) {
      const providerId = normalizeTeamMemberProviderId(member.providerId);
      if (providerId !== 'opencode' || member.isolation !== 'worktree') {
        nextMembers.push(member);
        continue;
      }

      const existingCwd = member.cwd?.trim();
      if (existingCwd) {
        if (!path.isAbsolute(existingCwd)) {
          throw new Error(
            `OpenCode worktree path for "${member.name}" must be absolute: ${existingCwd}`
          );
        }
        const existingCwdStat = await fs.promises.stat(existingCwd).catch(() => null);
        if (existingCwdStat) {
          if (!existingCwdStat.isDirectory()) {
            throw new Error(
              `OpenCode worktree path for "${member.name}" is not a directory: ${existingCwd}`
            );
          }
          nextMembers.push({ ...member, cwd: existingCwd });
          continue;
        }
      }

      const resolution = await this.ports.ensureMemberWorktree({
        teamName: params.teamName,
        memberName: member.name,
        baseCwd: params.baseCwd,
      });
      nextMembers.push({ ...member, cwd: resolution.worktreePath });
    }

    return nextMembers;
  }

  getFreshCachedProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): CachedProbeResult | null {
    const cacheKey = createProbeCacheKey(cwd, providerId);
    const cached = this.ports.providerProbeCache.get(cacheKey);
    return cached ? cloneCachedProviderProbeResult(cached) : null;
  }

  clearProbeCache(cwd: string, providerId: TeamProviderId | undefined): void {
    const cacheKey = createProbeCacheKey(cwd, providerId);
    this.ports.providerProbeCache.invalidate(cacheKey);
  }

  async validatePrepareCwd(cwd: string): Promise<void> {
    await validatePrepareCwdForProvisioning(cwd);
  }

  async getCachedOrProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): Promise<ProbeResult | null> {
    const cacheKey = createProbeCacheKey(cwd, providerId);
    const cached = this.getFreshCachedProbeResult(cwd, providerId);
    if (cached) {
      return cachedProviderProbeResultToProbeResult(cached);
    }

    const result = await this.ports.providerProbeCache.getOrCreate(cacheKey, async () => {
      const claudePath = await this.ports.resolveClaudeBinaryPath();
      if (!claudePath) {
        return { result: null, cacheable: false };
      }

      const {
        env,
        authSource,
        providerArgs = [],
        warning,
      } = await this.ports.buildProvisioningEnv(providerId);
      if (warning) {
        return {
          result: {
            claudePath,
            authSource,
            warning,
          },
          cacheable: false,
        };
      }

      const probe = await this.ports.probeClaudeRuntime(
        claudePath,
        cwd,
        env,
        providerId,
        providerArgs
      );
      const result = {
        claudePath,
        authSource,
        ...(probe.warning ? { warning: probe.warning } : {}),
      };

      const shouldCache =
        !probe.warning ||
        (!isAuthFailureWarning(probe.warning, 'probe') &&
          !isTransientProbeWarning(probe.warning) &&
          !isBinaryProbeWarning(probe.warning));

      return { result, cacheable: shouldCache };
    });
    return result ? cloneProviderProbeResult(result) : null;
  }
}
