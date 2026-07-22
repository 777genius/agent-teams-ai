import { type ExecCliOptions } from '@main/utils/childProcess';
import {
  type CliProviderModelCatalog,
  type CliProviderRuntimeCapabilities,
  type EffortLevel,
  type ProviderModelLaunchIdentity,
  type TeamCreateRequest,
  type TeamFastMode,
  type TeamProviderBackendId,
  type TeamProviderId,
} from '@shared/types';
import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { isUsableCodexModelCatalog } from '@shared/utils/codexModelCatalog';

import { buildProviderControlPlaneCliCommandArgs } from '../../runtime/providerCliCommandArgs';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import {
  PROVIDER_MODEL_LIST_TIMEOUT_MS,
  PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
} from './TeamProvisioningProviderPreflight';
import {
  addModelCatalogLaunchModels,
  extractJsonObjectFromCli,
  normalizeProviderModelListModels,
  type ProviderModelListCommandResponse,
  type RuntimeProviderLaunchFacts,
  type RuntimeStatusCommandResponse,
} from './TeamProvisioningRuntimeLaunchSelection';

export type LaunchIdentityRequest = Pick<
  TeamCreateRequest,
  'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode' | 'limitContext'
>;

export interface ReadRuntimeProviderLaunchFactsInput {
  claudePath: string;
  cwd: string;
  providerId: TeamProviderId;
  env: NodeJS.ProcessEnv;
  providerArgs?: string[];
  limitContext?: boolean;
}

export interface ReadRuntimeProviderLaunchFactsPorts {
  execCli(
    binaryPath: string | null,
    args: string[],
    options?: ExecCliOptions
  ): Promise<{ stdout: string; stderr: string }>;
  getCodexModelCatalog(params: { cwd: string }): Promise<CliProviderModelCatalog | null>;
  warn(message: string): void;
}

export interface RuntimeProviderCliOutputs {
  modelListStdout?: string | null;
  runtimeStatusStdout?: string | null;
}

export interface BuildRuntimeProviderLaunchFactsInput extends RuntimeProviderCliOutputs {
  providerId: TeamProviderId;
  limitContext?: boolean;
  codexModelCatalog?: CliProviderModelCatalog | null;
  warn?: (message: string) => void;
}

export interface ResolveAndValidateLaunchIdentityInput {
  claudePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  request: LaunchIdentityRequest;
  effectiveMembers: TeamCreateRequest['members'];
  providerArgsByProvider?: Map<TeamProviderId, string[]>;
}

export interface ResolveDirectMemberLaunchIdentityInput {
  claudePath: string;
  cwd: string;
  providerId: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  provisioningEnv: {
    env: NodeJS.ProcessEnv;
    providerArgs?: string[];
  };
  memberSpec: TeamCreateRequest['members'][number];
  requestLimitContext?: boolean;
}

export interface LaunchIdentityResolutionPorts {
  readRuntimeProviderLaunchFacts(
    params: ReadRuntimeProviderLaunchFactsInput
  ): Promise<RuntimeProviderLaunchFacts>;
  buildProviderModelLaunchIdentity(params: {
    request: LaunchIdentityRequest;
    facts: RuntimeProviderLaunchFacts;
  }): ProviderModelLaunchIdentity;
  validateRuntimeLaunchSelection(params: {
    actorLabel: string;
    providerId: TeamProviderId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
    limitContext?: boolean;
    facts: RuntimeProviderLaunchFacts;
  }): void;
}

function warnLaunchFactsParseError(params: {
  warn: (message: string) => void;
  providerId: TeamProviderId;
  subject: string;
  error: unknown;
}): void {
  params.warn(
    `[${params.providerId}] Failed to parse ${params.subject} for launch validation: ${
      params.error instanceof Error ? params.error.message : String(params.error)
    }`
  );
}

function hasRuntimeFactsJsonCandidate(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && raw.trim().length > 0;
}

export function buildRuntimeProviderLaunchFacts(
  input: BuildRuntimeProviderLaunchFactsInput
): RuntimeProviderLaunchFacts {
  let defaultModel: string | null = null;
  let modelIds = new Set<string>();
  let modelListParsed = false;
  const warn = input.warn ?? (() => undefined);

  if (hasRuntimeFactsJsonCandidate(input.modelListStdout)) {
    try {
      const parsed = extractJsonObjectFromCli<ProviderModelListCommandResponse>(
        input.modelListStdout
      );
      modelListParsed = true;
      const provider = parsed.providers?.[input.providerId];
      defaultModel =
        typeof provider?.defaultModel === 'string' && provider.defaultModel.trim().length > 0
          ? provider.defaultModel.trim()
          : null;
      modelIds = normalizeProviderModelListModels(provider);
    } catch (error) {
      warnLaunchFactsParseError({
        warn,
        providerId: input.providerId,
        subject: 'runtime model list',
        error,
      });
    }
  }

  let runtimeCapabilities: CliProviderRuntimeCapabilities | null = null;
  let modelCatalog: CliProviderModelCatalog | null = null;
  let providerStatus: RuntimeProviderLaunchFacts['providerStatus'] = null;

  if (hasRuntimeFactsJsonCandidate(input.runtimeStatusStdout)) {
    try {
      const parsed = extractJsonObjectFromCli<RuntimeStatusCommandResponse>(
        input.runtimeStatusStdout
      );
      const parsedProviderStatus = parsed.providers?.[input.providerId] ?? null;
      providerStatus = parsedProviderStatus
        ? {
            ...parsedProviderStatus,
            providerId: parsedProviderStatus.providerId ?? input.providerId,
          }
        : null;
      runtimeCapabilities = providerStatus?.runtimeCapabilities ?? null;
      modelCatalog =
        providerStatus?.modelCatalog?.providerId === input.providerId
          ? providerStatus.modelCatalog
          : null;
    } catch (error) {
      warnLaunchFactsParseError({
        warn,
        providerId: input.providerId,
        subject: 'runtime capabilities',
        error,
      });
    }
  }

  if (modelCatalog) {
    addModelCatalogLaunchModels(modelIds, modelCatalog);
    defaultModel = modelCatalog.defaultLaunchModel?.trim() || defaultModel;
  }

  if (input.providerId === 'codex' && isUsableCodexModelCatalog(input.codexModelCatalog)) {
    addModelCatalogLaunchModels(modelIds, input.codexModelCatalog);
    modelCatalog = input.codexModelCatalog;
    defaultModel = input.codexModelCatalog.defaultLaunchModel?.trim() || defaultModel;
  }

  return {
    defaultModel:
      input.providerId === 'anthropic'
        ? resolveAnthropicLaunchModel({
            limitContext: input.limitContext === true,
            availableLaunchModels:
              modelCatalog?.models.map((model) => model.launchModel) ?? modelIds,
            defaultLaunchModel: defaultModel,
          })
        : defaultModel,
    modelIds,
    modelListParsed,
    modelCatalog,
    runtimeCapabilities,
    providerStatus,
  };
}

export async function readRuntimeProviderLaunchFacts(
  input: ReadRuntimeProviderLaunchFactsInput,
  ports: ReadRuntimeProviderLaunchFactsPorts
): Promise<RuntimeProviderLaunchFacts> {
  const providerArgs = input.providerArgs ?? [];
  const modelListPromise = ports.execCli(
    input.claudePath,
    buildProviderControlPlaneCliCommandArgs(providerArgs, [
      'model',
      'list',
      '--json',
      '--provider',
      input.providerId,
    ]),
    {
      cwd: input.cwd,
      env: input.env,
      timeout: PROVIDER_MODEL_LIST_TIMEOUT_MS,
    }
  );
  const runtimeStatusPromise =
    input.providerId === 'codex' || input.providerId === 'anthropic'
      ? ports.execCli(
          input.claudePath,
          buildProviderControlPlaneCliCommandArgs(providerArgs, [
            'runtime',
            'status',
            '--json',
            '--provider',
            input.providerId,
          ]),
          {
            cwd: input.cwd,
            env: input.env,
            timeout: PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
          }
        )
      : null;

  const [modelListResult, runtimeStatusResult] = await Promise.allSettled([
    modelListPromise,
    runtimeStatusPromise,
  ]);
  const modelListStdout =
    modelListResult.status === 'fulfilled' ? modelListResult.value.stdout : null;
  const runtimeStatusStdout =
    runtimeStatusResult.status === 'fulfilled' && runtimeStatusResult.value
      ? runtimeStatusResult.value.stdout
      : null;

  const initialFacts = buildRuntimeProviderLaunchFacts({
    providerId: input.providerId,
    modelListStdout,
    runtimeStatusStdout,
    limitContext: input.limitContext,
    warn: ports.warn,
  });

  if (
    input.providerId !== 'codex' ||
    isUsableCodexModelCatalog(initialFacts.modelCatalog) ||
    initialFacts.runtimeCapabilities?.modelCatalog?.dynamic !== true
  ) {
    return initialFacts;
  }

  const codexCatalog = await ports.getCodexModelCatalog({ cwd: input.cwd });
  if (!isUsableCodexModelCatalog(codexCatalog)) {
    return initialFacts;
  }

  return buildRuntimeProviderLaunchFacts({
    providerId: input.providerId,
    modelListStdout,
    runtimeStatusStdout,
    limitContext: input.limitContext,
    codexModelCatalog: codexCatalog,
  });
}

export function buildDirectMemberLaunchIdentityRequest(input: {
  providerId: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  memberSpec: TeamCreateRequest['members'][number];
  requestLimitContext?: boolean;
}): LaunchIdentityRequest {
  return {
    providerId: input.providerId,
    ...(input.providerBackendId ? { providerBackendId: input.providerBackendId } : {}),
    ...(input.memberSpec.model ? { model: input.memberSpec.model } : {}),
    ...(input.memberSpec.effort ? { effort: input.memberSpec.effort } : {}),
    ...(input.memberSpec.fastMode ? { fastMode: input.memberSpec.fastMode } : {}),
    ...(input.requestLimitContext ? { limitContext: input.requestLimitContext } : {}),
  };
}

export async function resolveAndValidateLaunchIdentity(
  input: ResolveAndValidateLaunchIdentityInput,
  ports: LaunchIdentityResolutionPorts
): Promise<ProviderModelLaunchIdentity> {
  const leadProviderId = resolveTeamProviderId(input.request.providerId);
  const factsByProvider = new Map<TeamProviderId, RuntimeProviderLaunchFacts>();
  const getFacts = async (providerId: TeamProviderId): Promise<RuntimeProviderLaunchFacts> => {
    const cached = factsByProvider.get(providerId);
    if (cached) {
      return cached;
    }
    const facts = await ports.readRuntimeProviderLaunchFacts({
      claudePath: input.claudePath,
      cwd: input.cwd,
      providerId,
      env: input.env,
      providerArgs: input.providerArgsByProvider?.get(providerId),
      limitContext: input.request.limitContext,
    });
    factsByProvider.set(providerId, facts);
    return facts;
  };

  const leadFacts = await getFacts(leadProviderId);
  ports.validateRuntimeLaunchSelection({
    actorLabel: 'Team lead',
    providerId: leadProviderId,
    model: input.request.model,
    effort: input.request.effort,
    fastMode: input.request.fastMode,
    limitContext: input.request.limitContext,
    facts: leadFacts,
  });

  for (const member of input.effectiveMembers) {
    const memberProviderId = resolveTeamProviderId(member.providerId);
    const memberFacts = await getFacts(memberProviderId);
    ports.validateRuntimeLaunchSelection({
      actorLabel: `Member ${member.name}`,
      providerId: memberProviderId,
      model: member.model,
      effort: member.effort,
      limitContext: input.request.limitContext,
      facts: memberFacts,
    });
  }

  return ports.buildProviderModelLaunchIdentity({
    request: input.request,
    facts: leadFacts,
  });
}

export async function resolveDirectMemberLaunchIdentity(
  input: ResolveDirectMemberLaunchIdentityInput,
  ports: LaunchIdentityResolutionPorts
): Promise<ProviderModelLaunchIdentity> {
  const request = buildDirectMemberLaunchIdentityRequest({
    providerId: input.providerId,
    providerBackendId: input.providerBackendId,
    memberSpec: input.memberSpec,
    requestLimitContext: input.requestLimitContext,
  });
  const facts = await ports.readRuntimeProviderLaunchFacts({
    claudePath: input.claudePath,
    cwd: input.cwd,
    providerId: input.providerId,
    env: input.provisioningEnv.env,
    providerArgs: input.provisioningEnv.providerArgs,
    limitContext: input.requestLimitContext,
  });
  ports.validateRuntimeLaunchSelection({
    actorLabel: `Member ${input.memberSpec.name}`,
    providerId: input.providerId,
    model: input.memberSpec.model,
    effort: input.memberSpec.effort,
    fastMode: input.memberSpec.fastMode,
    limitContext: input.requestLimitContext,
    facts,
  });
  return ports.buildProviderModelLaunchIdentity({
    request,
    facts,
  });
}
