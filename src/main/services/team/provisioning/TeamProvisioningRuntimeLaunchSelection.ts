import {
  resolveAnthropicEffortSupport,
  resolveAnthropicFastMode,
  resolveAnthropicRuntimeSelection,
} from '@features/anthropic-runtime-profile/main';
import {
  buildCodexFastModeArgs,
  resolveCodexFastMode,
  resolveCodexRuntimeSelection,
} from '@features/codex-runtime-profile/main';
import { ensureMinimumNodeOldSpaceEnv } from '@main/utils/nodeOptions';
import { getAutoDetectedClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import {
  type CliProviderModelCatalog,
  type CliProviderRuntimeCapabilities,
  type CliProviderStatus,
  type EffortLevel,
  type ProviderModelLaunchIdentity,
  type TeamCreateRequest,
  type TeamProviderId,
  type TeamProvisioningModelCheckRequest,
} from '@shared/types';
import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { inferProviderBillingMode } from '@shared/utils/providerBillingMode';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';

import { type AnthropicTeamApiKeyHelperMaterial } from '../../runtime/anthropicTeamApiKeyHelper';
import { parseJsonSettingsObject } from '../../runtime/cliSettingsArgs';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';
import {
  materializeTeamRuntimeSettingsBundle,
  splitSettingsJsonArgs,
  type TeamRuntimeSettingsJson,
} from '../../runtime/teamRuntimeSettingsBundle';

import { getExplicitLaunchModelSelection } from './TeamProvisioningMemberSpecs';

export interface ProviderModelListCommandResponse {
  schemaVersion?: number;
  providers?: Record<
    string,
    {
      defaultModel?: string | null;
      models?: (string | { id?: string; label?: string; description?: string })[];
    }
  >;
}

export interface RuntimeStatusCommandResponse {
  providers?: Record<string, Partial<CliProviderStatus>>;
}

export interface AuthStatusCommandResponse {
  provider?: string;
  status?: Partial<CliProviderStatus>;
  loggedIn?: boolean;
  authMethod?: string | null;
  providers?: Record<string, Partial<CliProviderStatus>>;
}

export interface RuntimeProviderLaunchFacts {
  defaultModel: string | null;
  modelIds: Set<string>;
  modelListParsed?: boolean;
  modelCatalog: CliProviderModelCatalog | null;
  runtimeCapabilities: CliProviderRuntimeCapabilities | null;
  providerStatus?:
    | (Partial<CliProviderStatus> & { providerId?: CliProviderStatus['providerId'] })
    | null;
}

export interface TeamRuntimeLaunchArgsPlan {
  settingsArgs: string[];
  fastModeArgs: string[];
  runtimeTurnSettledHookArgs: string[];
  providerArgs: string[];
  extraArgs: string[];
  inheritedProviderArgs: string[];
  appManagedSettingsPath: string | null;
}

export interface TeamRuntimeLaunchArgsPlanEnvResolutionLike {
  anthropicApiKeyHelper?: AnthropicTeamApiKeyHelperMaterial | null;
  providerArgs?: string[];
}

export interface BuildTeamRuntimeLaunchArgsPlanInput {
  teamName: string;
  providerId: TeamProviderId;
  launchIdentity?: ProviderModelLaunchIdentity | null;
  envResolution: TeamRuntimeLaunchArgsPlanEnvResolutionLike;
  extraArgs?: string[];
  inheritedProviderArgs?: string[];
  includeAnthropicHelper: boolean;
  contextLabel: string;
}

export interface BuildTeamRuntimeLaunchArgsPlanPorts {
  buildRuntimeTurnSettledHookSettingsArgs(providerId: TeamProviderId): Promise<string[]>;
  buildRuntimeTurnSettledHookSettingsObject(
    providerId: TeamProviderId
  ): Promise<TeamRuntimeSettingsJson | null>;
}

export interface ProviderSelectedModelCheck {
  modelId: string;
  effort?: EffortLevel;
}

export function extractJsonObjectFromCli<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch (initialError) {
    const candidates: T[] = [];
    let lastParseError: unknown = null;
    for (let start = trimmed.indexOf('{'); start >= 0; start = trimmed.indexOf('{', start + 1)) {
      const end = findJsonObjectEnd(trimmed, start);
      if (end < 0) {
        continue;
      }
      try {
        candidates.push(JSON.parse(trimmed.slice(start, end + 1)) as T);
      } catch (error) {
        lastParseError = error;
      }
    }

    let providerResponse: T | null = null;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const record = candidates[index] as Record<string, unknown> | null;
      const providers = record && typeof record === 'object' ? record.providers : null;
      if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
        providerResponse = candidates[index];
        break;
      }
    }
    if (providerResponse) {
      return providerResponse;
    }
    if (candidates.length > 0) {
      throw new Error('No provider JSON object found in CLI output');
    }
    if (lastParseError instanceof Error) {
      throw lastParseError;
    }
    if (trimmed.includes('{') && initialError instanceof Error) {
      throw initialError;
    }
    throw new Error('No JSON object found in CLI output');
  }
}

function findJsonObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

export function getLaunchModelArg(
  providerId: TeamProviderId,
  model: string | undefined,
  launchIdentity?: ProviderModelLaunchIdentity | null
): string | undefined {
  if (providerId === 'anthropic' && launchIdentity?.resolvedLaunchModel) {
    return launchIdentity.resolvedLaunchModel;
  }

  const explicitModel = getExplicitLaunchModelSelection(model);
  if (explicitModel) {
    return explicitModel;
  }

  if (
    providerId === 'codex' &&
    launchIdentity?.selectedModelKind === 'default' &&
    launchIdentity.resolvedLaunchModel
  ) {
    return launchIdentity.resolvedLaunchModel;
  }

  return undefined;
}

export function normalizeProviderModelListModels(
  provider: NonNullable<ProviderModelListCommandResponse['providers']>[string] | undefined
): Set<string> {
  const models = new Set<string>();
  for (const entry of provider?.models ?? []) {
    const modelId = typeof entry === 'string' ? entry : entry.id;
    const trimmed = modelId?.trim();
    if (trimmed) {
      models.add(trimmed);
    }
  }
  return models;
}

export function normalizeProviderSelectedModelChecks(
  modelIds: readonly string[],
  modelChecks?: readonly ProviderSelectedModelCheck[]
): ProviderSelectedModelCheck[] {
  const checks: ProviderSelectedModelCheck[] =
    modelChecks && modelChecks.length > 0
      ? [...modelChecks]
      : modelIds.map((modelId) => ({ modelId }));
  const seen = new Set<string>();
  const normalized: ProviderSelectedModelCheck[] = [];
  for (const check of checks) {
    const modelId = check.modelId.trim();
    if (!modelId) {
      continue;
    }
    const key = `${modelId}\n${check.effort ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      modelId,
      ...(check.effort ? { effort: check.effort } : {}),
    });
  }
  return normalized;
}

export function normalizeProvisioningModelCheckRequests(
  checks: readonly TeamProvisioningModelCheckRequest[] | undefined
): TeamProvisioningModelCheckRequest[] {
  const seen = new Set<string>();
  const normalized: TeamProvisioningModelCheckRequest[] = [];
  for (const check of checks ?? []) {
    const model = check.model.trim();
    if (!model) {
      continue;
    }
    const key = `${check.providerId}\n${model}\n${check.effort ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      providerId: check.providerId,
      model,
      ...(check.effort ? { effort: check.effort } : {}),
    });
  }
  return normalized;
}

export function addModelCatalogLaunchModels(
  modelIds: Set<string>,
  catalog: CliProviderModelCatalog
): void {
  for (const model of catalog.models ?? []) {
    if (model.hidden) {
      continue;
    }
    const launchModel = model.launchModel?.trim();
    if (launchModel) {
      modelIds.add(launchModel);
    }
    const catalogId = model.id?.trim();
    if (catalogId) {
      modelIds.add(catalogId);
    }
  }
}

export function isLegacySafeEffort(effort: EffortLevel): boolean {
  return effort === 'low' || effort === 'medium' || effort === 'high';
}

function getExactCatalogModelForLaunchSelection(
  facts: Pick<RuntimeProviderLaunchFacts, 'modelCatalog'>,
  explicitModel: string | undefined
): CliProviderModelCatalog['models'][number] | null {
  const catalog = facts.modelCatalog;
  if (!catalog) {
    return null;
  }
  if (explicitModel) {
    return (
      catalog.models.find(
        (model) => model.launchModel === explicitModel || model.id === explicitModel
      ) ?? null
    );
  }
  return (
    catalog.models.find((model) => model.id === catalog.defaultModelId) ??
    catalog.models.find((model) => model.launchModel === catalog.defaultLaunchModel) ??
    catalog.models.find((model) => model.isDefault) ??
    null
  );
}

export function isCodexEffortRuntimeSupported(
  effort: EffortLevel,
  capabilities: CliProviderRuntimeCapabilities | null
): boolean {
  if (isLegacySafeEffort(effort)) {
    return true;
  }

  const reasoning = capabilities?.reasoningEffort;
  return reasoning?.configPassthrough === true && reasoning.values.includes(effort);
}

export function hasAuthoritativeCodexLaunchCatalog(
  facts: Pick<
    RuntimeProviderLaunchFacts,
    'modelIds' | 'modelListParsed' | 'modelCatalog' | 'runtimeCapabilities'
  >
): boolean {
  if (facts.modelIds.size > 0 || facts.modelCatalog != null) {
    return true;
  }
  return (
    facts.modelListParsed === true && facts.runtimeCapabilities?.modelCatalog?.dynamic === false
  );
}

export function resolveAnthropicSelectionFromFacts(params: {
  selectedModel?: string;
  limitContext?: boolean;
  facts: Pick<RuntimeProviderLaunchFacts, 'modelCatalog' | 'modelIds' | 'runtimeCapabilities'>;
}): ReturnType<typeof resolveAnthropicRuntimeSelection> {
  return resolveAnthropicRuntimeSelection({
    source: {
      modelCatalog: params.facts.modelCatalog,
      runtimeCapabilities: params.facts.runtimeCapabilities,
    },
    selectedModel: params.selectedModel,
    limitContext: params.limitContext === true,
    availableLaunchModels: params.facts.modelCatalog ? undefined : params.facts.modelIds,
  });
}

export function formatAnthropicEffortSupportFailure(params: {
  effort: EffortLevel;
  modelLabel: string;
  supportedEfforts?: readonly EffortLevel[];
  kind:
    | 'unsupported-by-catalog'
    | 'unsupported-by-runtime-capability'
    | 'unverified-catalog-missing';
}): string {
  if (params.kind === 'unverified-catalog-missing') {
    return `Anthropic runtime catalog was unavailable, so effort "${params.effort}" for ${params.modelLabel} could not be verified.`;
  }

  const supported = params.supportedEfforts?.length
    ? ` Supported efforts: ${params.supportedEfforts.join(', ')}.`
    : '';
  const runtimeSuffix =
    params.kind === 'unsupported-by-runtime-capability'
      ? ' in the current runtime capability data'
      : ' in the current runtime';
  return `${params.modelLabel} does not support Anthropic effort "${params.effort}"${runtimeSuffix}.${supported}`;
}

export function resolveCodexSelectionFromFacts(params: {
  selectedModel?: string;
  providerBackendId?: TeamCreateRequest['providerBackendId'];
  facts: Pick<RuntimeProviderLaunchFacts, 'providerStatus'>;
}): ReturnType<typeof resolveCodexRuntimeSelection> {
  return resolveCodexRuntimeSelection({
    source: {
      providerStatus: params.facts.providerStatus,
      providerBackendId: params.providerBackendId,
    },
    selectedModel: params.selectedModel,
  });
}

export function buildAnthropicSettingsObject(
  providerId: TeamProviderId,
  launchIdentity?: ProviderModelLaunchIdentity | null
): TeamRuntimeSettingsJson | null {
  if (providerId !== 'anthropic' || typeof launchIdentity?.resolvedFastMode !== 'boolean') {
    return null;
  }

  return launchIdentity.resolvedFastMode
    ? {
        fastMode: true,
        fastModePerSessionOptIn: false,
      }
    : {
        fastMode: false,
      };
}

function buildAnthropicSettingsArgs(
  providerId: TeamProviderId,
  launchIdentity?: ProviderModelLaunchIdentity | null
): string[] {
  const settings = buildAnthropicSettingsObject(providerId, launchIdentity);
  if (!settings) {
    return [];
  }

  return ['--settings', JSON.stringify(settings)];
}

function sanitizeRuntimeSettingsTeamName(teamName: string): string {
  return teamName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'team';
}

export function buildRuntimeSettingsTempDirectory(teamName: string): string {
  return path.join(
    os.tmpdir(),
    'agent-teams-runtime-settings',
    `${sanitizeRuntimeSettingsTeamName(teamName)}-${randomUUID()}`
  );
}

export function normalizeTeamRuntimeNodeEnv(env: NodeJS.ProcessEnv): void {
  // Vitest sets NODE_ENV=test in the desktop parent process. Real team runtime
  // children must run the CLI normally, otherwise source launches can take
  // test-only startup paths and exit before deterministic bootstrap starts.
  if (env.NODE_ENV === 'test') {
    env.NODE_ENV = 'development';
  }
  ensureMinimumNodeOldSpaceEnv(env);
}

export function buildProviderFastModeArgs(
  providerId: TeamProviderId,
  launchIdentity?: ProviderModelLaunchIdentity | null
): string[] {
  if (providerId === 'anthropic') {
    return buildAnthropicSettingsArgs(providerId, launchIdentity);
  }
  if (providerId === 'codex') {
    return buildCodexFastModeArgs(launchIdentity?.resolvedFastMode);
  }
  return [];
}

export function filterOutSettingsPathArgs(
  args: string[],
  settingsPath: string | null | undefined
): string[] {
  if (!settingsPath) {
    return [...args];
  }
  const filtered: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--settings' && args[index + 1] === settingsPath) {
      index += 2;
      continue;
    }
    if (arg === `--settings=${settingsPath}`) {
      index += 1;
      continue;
    }
    filtered.push(arg);
    index += 1;
  }
  return filtered;
}

export function hasPathBasedSettingsArgs(args: string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--settings') {
      const value = args[index + 1];
      if (typeof value === 'string') {
        if (!parseJsonSettingsObject(value)) {
          return true;
        }
        index += 2;
        continue;
      }
      if (typeof value !== 'string') {
        return true;
      }
      index += 1;
      continue;
    }
    const prefix = '--settings=';
    if (arg.startsWith(prefix) && !parseJsonSettingsObject(arg.slice(prefix.length))) {
      return true;
    }
    index += 1;
  }
  return false;
}

export async function buildTeamRuntimeLaunchArgsPlan(
  input: BuildTeamRuntimeLaunchArgsPlanInput,
  ports: BuildTeamRuntimeLaunchArgsPlanPorts
): Promise<TeamRuntimeLaunchArgsPlan> {
  const resolvedProviderId = resolveTeamProviderId(input.providerId);
  const helper =
    input.includeAnthropicHelper && resolvedProviderId === 'anthropic'
      ? (input.envResolution.anthropicApiKeyHelper ?? null)
      : null;
  const rawProviderArgs = input.envResolution.providerArgs ?? [];
  const rawExtraArgs = input.extraArgs ?? [];
  const rawInheritedProviderArgs = input.inheritedProviderArgs ?? [];

  if (!helper && resolvedProviderId !== 'anthropic') {
    return {
      settingsArgs: [],
      fastModeArgs: buildProviderFastModeArgs(resolvedProviderId, input.launchIdentity),
      runtimeTurnSettledHookArgs:
        await ports.buildRuntimeTurnSettledHookSettingsArgs(resolvedProviderId),
      providerArgs: rawProviderArgs,
      extraArgs: rawExtraArgs,
      inheritedProviderArgs: rawInheritedProviderArgs,
      appManagedSettingsPath: null,
    };
  }

  const providerArgsWithoutHelper = filterOutSettingsPathArgs(
    rawProviderArgs,
    helper?.settingsPath
  );
  const splitProviderArgs = splitSettingsJsonArgs(providerArgsWithoutHelper);
  const splitExtraArgs = splitSettingsJsonArgs(rawExtraArgs);
  const splitInheritedArgs = splitSettingsJsonArgs(rawInheritedProviderArgs);
  const shouldCoalesceInheritedSettings = splitInheritedArgs.settingsFragments.length > 0;
  if (
    helper &&
    (hasPathBasedSettingsArgs(splitProviderArgs.passthroughArgs) ||
      hasPathBasedSettingsArgs(splitExtraArgs.passthroughArgs) ||
      hasPathBasedSettingsArgs(splitInheritedArgs.passthroughArgs))
  ) {
    throw new Error(
      `${input.contextLabel}: app-managed Anthropic API-key helper cannot be combined with path-based --settings. Use inline JSON settings or remove the custom --settings path.`
    );
  }
  if (
    shouldCoalesceInheritedSettings &&
    !helper &&
    (hasPathBasedSettingsArgs(splitProviderArgs.passthroughArgs) ||
      hasPathBasedSettingsArgs(splitExtraArgs.passthroughArgs) ||
      hasPathBasedSettingsArgs(splitInheritedArgs.passthroughArgs))
  ) {
    throw new Error(
      `${input.contextLabel}: mixed-provider launch cannot combine app-managed inherited settings with path-based --settings. Use inline JSON settings or remove the custom --settings path.`
    );
  }

  const settingsBundle = await materializeTeamRuntimeSettingsBundle({
    teamName: input.teamName,
    providerId: resolvedProviderId,
    baseSettings: [
      buildAnthropicSettingsObject(resolvedProviderId, input.launchIdentity),
      await ports.buildRuntimeTurnSettledHookSettingsObject(resolvedProviderId),
      ...splitProviderArgs.settingsFragments,
      ...splitExtraArgs.settingsFragments,
      ...splitInheritedArgs.settingsFragments,
    ],
    anthropicHelper: helper,
    settingsDirectory: helper ? null : buildRuntimeSettingsTempDirectory(input.teamName),
  });

  return {
    settingsArgs: settingsBundle?.args ?? [],
    fastModeArgs: [],
    runtimeTurnSettledHookArgs: [],
    providerArgs: splitProviderArgs.passthroughArgs,
    extraArgs: splitExtraArgs.passthroughArgs,
    inheritedProviderArgs: splitInheritedArgs.passthroughArgs,
    appManagedSettingsPath: settingsBundle?.settingsPath ?? null,
  };
}

export function isProbeTimeoutMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('timeout running:') ||
    lower.includes('timed out') ||
    lower.includes('did not complete') ||
    lower.includes('etimedout')
  );
}

export function resolveRequestedLaunchModel(params: {
  providerId: TeamProviderId;
  selectedModel?: string;
  limitContext?: boolean;
  facts: Pick<RuntimeProviderLaunchFacts, 'defaultModel' | 'modelIds'>;
}): string | null {
  if (params.providerId === 'anthropic') {
    return resolveAnthropicLaunchModel({
      selectedModel: params.selectedModel,
      limitContext: params.limitContext === true,
      availableLaunchModels: params.facts.modelIds,
      defaultLaunchModel: params.facts.defaultModel,
    });
  }

  const explicitModel = getExplicitLaunchModelSelection(params.selectedModel);
  return explicitModel ?? params.facts.defaultModel;
}

export function buildProviderModelLaunchIdentity(params: {
  request: Pick<
    TeamCreateRequest,
    'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode' | 'limitContext'
  >;
  facts: RuntimeProviderLaunchFacts;
  anthropicFastModeDefault: boolean;
}): ProviderModelLaunchIdentity {
  const providerId = resolveTeamProviderId(params.request.providerId);
  const explicitModel = getExplicitLaunchModelSelection(params.request.model);
  const resolvedLaunchModel = resolveRequestedLaunchModel({
    providerId,
    selectedModel: params.request.model,
    limitContext: params.request.limitContext,
    facts: params.facts,
  });

  if (providerId === 'anthropic') {
    const selection = resolveAnthropicSelectionFromFacts({
      selectedModel: params.request.model,
      limitContext: params.request.limitContext,
      facts: params.facts,
    });
    const fastResolution = resolveAnthropicFastMode({
      selection,
      selectedFastMode: params.request.fastMode,
      providerFastModeDefault: params.anthropicFastModeDefault,
    });
    const providerBackendId =
      migrateProviderBackendId(providerId, params.request.providerBackendId) ?? null;

    return {
      providerId,
      providerBackendId,
      billingMode: inferProviderBillingMode({
        providerId,
        providerBackendId,
        authMethod: params.facts.providerStatus?.authMethod,
        authMethodDetail: params.facts.providerStatus?.backend?.authMethodDetail,
        backendKind: params.facts.providerStatus?.backend?.kind,
        selectedBackendId: params.facts.providerStatus?.selectedBackendId,
        resolvedBackendId: params.facts.providerStatus?.resolvedBackendId,
        authenticated: params.facts.providerStatus?.authenticated,
        model: selection.resolvedLaunchModel ?? resolvedLaunchModel,
        catalogModel: selection.catalogModel,
      }),
      selectedModel: explicitModel ?? null,
      selectedModelKind: explicitModel ? 'explicit' : 'default',
      resolvedLaunchModel: selection.resolvedLaunchModel ?? resolvedLaunchModel,
      catalogId:
        selection.catalogModel?.id?.trim() || selection.resolvedLaunchModel || resolvedLaunchModel,
      catalogSource: selection.catalogSource,
      catalogFetchedAt: selection.catalogFetchedAt,
      selectedEffort: params.request.effort ?? null,
      resolvedEffort: params.request.effort ?? selection.defaultEffort ?? null,
      selectedFastMode: params.request.fastMode ?? 'inherit',
      resolvedFastMode: fastResolution.resolvedFastMode,
      fastResolutionReason: fastResolution.disabledReason,
    };
  }

  if (providerId === 'codex') {
    const selection = resolveCodexSelectionFromFacts({
      selectedModel: params.request.model,
      providerBackendId: params.request.providerBackendId,
      facts: params.facts,
    });
    const fastResolution = resolveCodexFastMode({
      selection,
      selectedFastMode: params.request.fastMode,
    });
    const resolvedCodexModel = selection.resolvedLaunchModel ?? resolvedLaunchModel;
    const providerBackendId =
      migrateProviderBackendId(providerId, params.request.providerBackendId) ??
      selection.providerBackendId;

    return {
      providerId,
      providerBackendId,
      billingMode: inferProviderBillingMode({
        providerId,
        providerBackendId,
        authMethod: params.facts.providerStatus?.authMethod,
        authMethodDetail: params.facts.providerStatus?.backend?.authMethodDetail,
        backendKind: params.facts.providerStatus?.backend?.kind,
        selectedBackendId: params.facts.providerStatus?.selectedBackendId,
        resolvedBackendId: params.facts.providerStatus?.resolvedBackendId,
        authenticated: params.facts.providerStatus?.authenticated,
        model: resolvedCodexModel,
        catalogModel: selection.catalogModel,
      }),
      selectedModel: explicitModel ?? null,
      selectedModelKind: explicitModel ? 'explicit' : 'default',
      resolvedLaunchModel: resolvedCodexModel,
      catalogId:
        selection.catalogModel?.id?.trim() || selection.resolvedLaunchModel || resolvedCodexModel,
      catalogSource: selection.catalogSource,
      catalogFetchedAt: selection.catalogFetchedAt,
      selectedEffort: params.request.effort ?? null,
      resolvedEffort: params.request.effort ?? null,
      selectedFastMode: params.request.fastMode ?? 'inherit',
      resolvedFastMode: fastResolution.resolvedFastMode,
      fastResolutionReason: fastResolution.disabledReason,
    };
  }

  const resolvedEffort = params.request.effort ?? null;
  const providerBackendId =
    migrateProviderBackendId(providerId, params.request.providerBackendId) ?? null;

  return {
    providerId,
    providerBackendId,
    billingMode: inferProviderBillingMode({
      providerId,
      providerBackendId,
      authMethod: params.facts.providerStatus?.authMethod,
      authMethodDetail: params.facts.providerStatus?.backend?.authMethodDetail,
      backendKind: params.facts.providerStatus?.backend?.kind,
      selectedBackendId: params.facts.providerStatus?.selectedBackendId,
      resolvedBackendId: params.facts.providerStatus?.resolvedBackendId,
      authenticated: params.facts.providerStatus?.authenticated,
      model: resolvedLaunchModel,
    }),
    selectedModel: explicitModel ?? null,
    selectedModelKind: explicitModel ? 'explicit' : 'default',
    resolvedLaunchModel,
    catalogId: resolvedLaunchModel,
    catalogSource: 'runtime',
    catalogFetchedAt: null,
    selectedEffort: params.request.effort ?? null,
    resolvedEffort,
  };
}

export function validateRuntimeLaunchSelection(params: {
  actorLabel: string;
  providerId: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamCreateRequest['fastMode'];
  limitContext?: boolean;
  facts: RuntimeProviderLaunchFacts;
  anthropicFastModeDefault: boolean;
  getProviderLabel: (providerId: TeamProviderId) => string;
}): void {
  const explicitModel = getExplicitLaunchModelSelection(params.model);

  if (params.providerId === 'anthropic') {
    const selection = resolveAnthropicSelectionFromFacts({
      selectedModel: params.model,
      limitContext: params.limitContext,
      facts: params.facts,
    });
    const resolvedLaunchModel = selection.resolvedLaunchModel?.trim() || null;
    if (!resolvedLaunchModel) {
      throw new Error(
        `${params.actorLabel} could not resolve the selected Anthropic model against the current runtime catalog.`
      );
    }
    if (params.facts.modelIds.size > 0 && !params.facts.modelIds.has(resolvedLaunchModel)) {
      throw new Error(
        `${params.actorLabel} resolves to Anthropic model "${resolvedLaunchModel}", but the current runtime does not list it as launchable.`
      );
    }
    if (params.effort) {
      const modelLabel = selection.displayName ?? resolvedLaunchModel;
      const effortSupport = resolveAnthropicEffortSupport({
        selection,
        effort: params.effort,
        runtimeCapabilities: params.facts.runtimeCapabilities,
      });
      if (effortSupport.kind !== 'supported') {
        throw new Error(
          `${params.actorLabel} uses Anthropic effort "${params.effort}", but ${formatAnthropicEffortSupportFailure(
            {
              effort: params.effort,
              modelLabel,
              kind: effortSupport.kind,
              supportedEfforts:
                effortSupport.kind === 'unverified-catalog-missing'
                  ? undefined
                  : effortSupport.supportedEfforts,
            }
          )}`
        );
      }
    }

    const fastResolution = resolveAnthropicFastMode({
      selection,
      selectedFastMode: params.fastMode,
      providerFastModeDefault: params.anthropicFastModeDefault,
    });
    if ((params.fastMode ?? 'inherit') === 'on' && !fastResolution.selectable) {
      throw new Error(
        `${params.actorLabel} enables Anthropic Fast mode, but ${
          fastResolution.disabledReason ?? 'it is unavailable for the selected runtime or model.'
        }`
      );
    }
    return;
  }

  if (params.providerId !== 'codex') {
    const catalogModel = getExactCatalogModelForLaunchSelection(params.facts, explicitModel);
    if (
      params.effort &&
      catalogModel &&
      !catalogModel.supportedReasoningEfforts.includes(params.effort)
    ) {
      const supported = catalogModel.supportedReasoningEfforts.length
        ? ` Supported efforts: ${catalogModel.supportedReasoningEfforts.join(', ')}.`
        : ' This model does not support configurable effort.';
      throw new Error(
        `${params.actorLabel} uses effort "${params.effort}", but ${catalogModel.displayName} does not support it.${supported}`
      );
    }
    if (params.effort && !catalogModel && !isLegacySafeEffort(params.effort)) {
      throw new Error(
        `${params.actorLabel} uses effort "${params.effort}", but ${params.getProviderLabel(
          params.providerId
        )} currently supports only low, medium, or high effort in Agent Teams.`
      );
    }
    return;
  }

  if (
    params.effort &&
    !isCodexEffortRuntimeSupported(params.effort, params.facts.runtimeCapabilities)
  ) {
    throw new Error(
      `${params.actorLabel} uses Codex effort "${params.effort}", but this Agent Teams runtime does not expose Codex reasoning config passthrough yet. Use low, medium, or high for now.`
    );
  }

  if (!explicitModel || params.facts.modelIds.has(explicitModel)) {
    return;
  }

  if (params.facts.runtimeCapabilities?.modelCatalog?.dynamic === true) {
    return;
  }

  if (!hasAuthoritativeCodexLaunchCatalog(params.facts)) {
    return;
  }

  throw new Error(
    `${params.actorLabel} uses Codex model "${explicitModel}", but this Agent Teams runtime does not declare dynamic Codex model launch support yet. Upgrade the runtime or pick a listed Codex model.`
  );
}

export type TeamsBaseLocation = 'configured' | 'default';

export type ValidConfigProbeResult =
  | { ok: true; location: TeamsBaseLocation; configPath: string }
  | { ok: false };

export function getTeamsBasePathsToProbe(): { location: TeamsBaseLocation; basePath: string }[] {
  const configured = getTeamsBasePath();
  const defaultBase = path.join(getAutoDetectedClaudeBasePath(), 'teams');
  if (path.resolve(configured) === path.resolve(defaultBase)) {
    return [{ location: 'configured', basePath: configured }];
  }
  return [
    { location: 'configured', basePath: configured },
    { location: 'default', basePath: defaultBase },
  ];
}

export function logsSuggestShutdownOrCleanup(logs: string): boolean {
  const text = logs.toLowerCase();
  return (
    text.includes('shutdown') ||
    text.includes('clean up') ||
    text.includes('cleanup') ||
    text.includes('deactivate') ||
    text.includes('deactivated') ||
    text.includes('resources') ||
    // Russian keywords observed in some CLI outputs / user environments
    text.includes('очист') ||
    text.includes('очищ') ||
    text.includes('заверш') ||
    text.includes('деактив')
  );
}
