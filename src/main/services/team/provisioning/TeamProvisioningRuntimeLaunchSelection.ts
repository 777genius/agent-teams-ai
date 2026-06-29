import { resolveAnthropicRuntimeSelection } from '@features/anthropic-runtime-profile/main';
import {
  buildCodexFastModeArgs,
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
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';

import { parseJsonSettingsObject } from '../../runtime/cliSettingsArgs';
import { type TeamRuntimeSettingsJson } from '../../runtime/teamRuntimeSettingsBundle';

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
