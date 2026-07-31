import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findNodeAtLocation,
  type Node as JsoncNode,
  type ParseError,
  parseTree,
} from 'jsonc-parser';

import {
  buildRuntimeLocalProviderModelRoute,
  isPrivateNetworkRuntimeLocalProviderUrl,
  normalizeRuntimeLocalProviderModelId,
  normalizeRuntimeLocalProviderTarget,
  RUNTIME_LOCAL_PROVIDER_PRESETS,
  RuntimeLocalProviderValidationError,
} from '../../core/domain';

import { readResponseTextWithLimit } from './boundedResponseBody';
import {
  JsonLocalProviderPrivateNetworkApprovalStore,
  type LocalProviderPrivateNetworkApprovalStore,
} from './LocalProviderPrivateNetworkApprovalStore';
import {
  buildLocalServerModelMetadataRequest,
  type LocalServerModelMetadata,
} from './localServerRuntimeApi';
import {
  buildLocalProviderConfigureError,
  buildLocalProviderProbeError,
  createModelRecord,
  hasDuplicateObjectProperties,
  isPathInside,
  type LocalModelConfigMetadata,
  type LocalProviderConfigWriteInput,
  type LocalProviderConfigWriteResult,
  mergeAvailableConfiguredModelIds,
  readObjectEntries,
  readOpenAiModels,
  readStringNode,
  resolveRequestedLocalProviderModelIds,
  setJsoncValue,
  updateJsoncProviderModels,
} from './openCodeLocalProviderConnectorUtils';
import { filterOllamaCompletionModels } from './OpenCodeLocalProviderModelFilter';
import {
  assertProviderApiKeyReplacement,
  buildDeferredProviderListEntry,
  commitProviderConfigWithCredential,
  createProviderApiKeyReference,
  LocalProviderOperationError,
  normalizeOptionalProviderApiKey,
  resolveConfiguredProviderPreset,
} from './OpenCodeLocalProviderSupport';

import type {
  RuntimeLocalProviderConfigureInput,
  RuntimeLocalProviderConfigureResponse,
  RuntimeLocalProviderErrorCodeDto,
  RuntimeLocalProviderListEntryDto,
  RuntimeLocalProviderListInput,
  RuntimeLocalProviderListResponse,
  RuntimeLocalProviderModelDto,
  RuntimeLocalProviderProbeDto,
  RuntimeLocalProviderProbeInput,
  RuntimeLocalProviderProbeResponse,
  RuntimeLocalProviderScanInput,
  RuntimeLocalProviderScanResponse,
  RuntimeLocalProviderScopeDto,
} from '../../contracts';
import type { RuntimeLocalProviderConnectorPort } from '../../core/application';

const SCAN_TIMEOUT_MS = 1_200;
const PROBE_TIMEOUT_MS = 5_000;
const MODEL_METADATA_TIMEOUT_MS = 3_000;
const DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS = 4_096;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_API_KEY_LENGTH = 8_192;
const PROVIDER_ID_FILTER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONFIG_CANDIDATES = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
] as const;
const GLOBAL_CONFIG_FILENAMES = ['opencode.json', 'opencode.jsonc'] as const;

interface OpenCodeLocalProviderConnectorOptions {
  readonly fetchImpl?: typeof fetch;
  readonly homePath?: string;
  readonly now?: () => number;
  readonly privateNetworkApprovalStore?: LocalProviderPrivateNetworkApprovalStore;
}

interface OpenCodeConfigTarget {
  readonly scope: RuntimeLocalProviderScopeDto;
  readonly projectPath?: string;
  readonly configPath: string;
  readonly raw: string | null;
  readonly mode?: number;
}

interface ModelProbeOutcome {
  readonly models: readonly RuntimeLocalProviderModelDto[];
  readonly latencyMs: number;
  readonly message: string;
  readonly available: boolean;
}

export class OpenCodeLocalProviderConnector implements RuntimeLocalProviderConnectorPort {
  private readonly fetchImpl: typeof fetch;
  private readonly homePath: string;
  private readonly now: () => number;
  private readonly privateNetworkApprovalStore: LocalProviderPrivateNetworkApprovalStore;
  // Serializes config read-modify-write so concurrent configure calls read the previous result.
  // Configure is rare, so a single chain avoids config-path key subtleties.
  private configWriteChain: Promise<unknown> = Promise.resolve();

  constructor(options: OpenCodeLocalProviderConnectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.homePath = path.resolve(options.homePath ?? os.homedir());
    this.now = options.now ?? Date.now;
    this.privateNetworkApprovalStore =
      options.privateNetworkApprovalStore ?? new JsonLocalProviderPrivateNetworkApprovalStore();
  }

  async listLocalProviders(
    input: RuntimeLocalProviderListInput
  ): Promise<RuntimeLocalProviderListResponse> {
    if (
      input?.runtimeId !== 'opencode' ||
      (input.scope !== 'global' && input.scope !== 'project')
    ) {
      return this.listError('invalid-input', 'Only the OpenCode runtime supports local providers.');
    }
    const requestedProviderId = input.providerId?.trim() || null;
    if (requestedProviderId && !PROVIDER_ID_FILTER_PATTERN.test(requestedProviderId)) {
      return this.listError('invalid-input', 'Local provider id is invalid.');
    }
    try {
      const configTarget = await this.readConfigTarget(input.scope, input.projectPath);
      if (!configTarget.raw) {
        return {
          schemaVersion: 1,
          runtimeId: 'opencode',
          scope: configTarget.scope,
          projectPath: configTarget.projectPath,
          configPath: configTarget.configPath,
          providers: [],
        };
      }

      const configTree = parseConfigTree(configTarget.raw);
      const providerRootNode = findNodeAtLocation(configTree, ['provider']);
      if (providerRootNode && providerRootNode.type !== 'object') {
        throw new LocalProviderOperationError(
          'config-invalid',
          'The existing OpenCode provider configuration must be an object.'
        );
      }
      const configuredDefaultModel = readStringNode(findNodeAtLocation(configTree, ['model']));
      const configuredSmallModel = readStringNode(findNodeAtLocation(configTree, ['small_model']));
      const configuredProviders = providerRootNode
        ? readObjectEntries(providerRootNode)
            .map(({ key: providerId, value: providerNode }) => {
              if (providerNode.type !== 'object') return null;
              const npm = readStringNode(
                findNodeAtLocation(configTree, ['provider', providerId, 'npm'])
              );
              const rawBaseUrl = readStringNode(
                findNodeAtLocation(configTree, ['provider', providerId, 'options', 'baseURL'])
              );
              if (npm !== '@ai-sdk/openai-compatible' || !rawBaseUrl) return null;

              let target: ReturnType<typeof normalizeRuntimeLocalProviderTarget>;
              try {
                target = normalizeRuntimeLocalProviderTarget({
                  presetId: 'custom',
                  providerId,
                  baseUrl: rawBaseUrl,
                  // A private-network base URL in the config was explicitly
                  // approved when it was configured; reading must not drop it.
                  allowPrivateNetwork: true,
                });
              } catch {
                return null;
              }
              const preset = resolveConfiguredProviderPreset(providerId, target.baseUrl);
              if (!preset) return null;

              const hasConfiguredApiKey = Boolean(
                readStringNode(
                  findNodeAtLocation(configTree, ['provider', providerId, 'options', 'apiKey'])
                )
              );
              const modelsNode = findNodeAtLocation(configTree, ['provider', providerId, 'models']);
              const configuredModelIds =
                modelsNode?.type === 'object'
                  ? readObjectEntries(modelsNode)
                      .map(({ key }) => normalizeRuntimeLocalProviderModelId(key))
                      .filter((modelId): modelId is string => Boolean(modelId))
                  : [];
              const routePrefix = `${providerId}/`;
              const isDefault = configuredDefaultModel?.startsWith(routePrefix) ?? false;
              const smallModelId = configuredSmallModel?.startsWith(routePrefix)
                ? configuredSmallModel.slice(routePrefix.length) || null
                : null;
              const configuredDefaultModelId = isDefault
                ? configuredDefaultModel?.slice(routePrefix.length) || null
                : (smallModelId ?? configuredModelIds[0] ?? null);
              return {
                preset,
                providerId: target.providerId,
                baseUrl: target.baseUrl,
                hasConfiguredApiKey,
                configuredModelIds,
                configuredDefaultModelId,
                isDefault,
                smallModelId,
              };
            })
            .filter((provider): provider is NonNullable<typeof provider> => provider !== null)
            .filter(
              (provider) =>
                requestedProviderId === null || provider.providerId === requestedProviderId
            )
        : [];

      const approvedConfiguredProviders = await Promise.all(
        configuredProviders.map(async (configured) => ({
          ...configured,
          privateNetworkApproved:
            !isPrivateNetworkRuntimeLocalProviderUrl(configured.baseUrl) ||
            (await this.privateNetworkApprovalStore.isApproved({
              configPath: configTarget.configPath,
              providerId: configured.providerId,
              baseUrl: configured.baseUrl,
            })),
        }))
      );
      const providers = await Promise.all(
        approvedConfiguredProviders.map(
          async (configured): Promise<RuntimeLocalProviderListEntryDto> => {
            if (!configured.privateNetworkApproved) {
              return {
                preset: configured.preset,
                providerId: configured.providerId,
                baseUrl: configured.baseUrl,
                hasConfiguredApiKey: configured.hasConfiguredApiKey,
                configuredModelIds: configured.configuredModelIds,
                defaultModelId: configured.configuredDefaultModelId,
                smallModelId: configured.smallModelId,
                isDefault: configured.isDefault,
                privateNetworkApproved: false,
                state: 'unavailable',
                liveModels: [],
                latencyMs: null,
                message:
                  'Private network access has not been approved in Agent Teams. Edit this provider and approve its address before connecting.',
              };
            }
            const deferredEntry = buildDeferredProviderListEntry(configured);
            if (deferredEntry) return deferredEntry;
            const probe = await this.probeTarget(
              {
                preset: configured.preset,
                providerId: configured.providerId,
                baseUrl: configured.baseUrl,
              },
              SCAN_TIMEOUT_MS
            );
            const liveDefaultStillAvailable = probe.models.some(
              (model) => model.id === configured.configuredDefaultModelId
            );
            return {
              preset: configured.preset,
              providerId: configured.providerId,
              baseUrl: configured.baseUrl,
              hasConfiguredApiKey: false,
              configuredModelIds: configured.configuredModelIds,
              defaultModelId: liveDefaultStillAvailable
                ? configured.configuredDefaultModelId
                : (configured.configuredDefaultModelId ?? probe.models[0]?.id ?? null),
              smallModelId: configured.smallModelId,
              isDefault: configured.isDefault,
              privateNetworkApproved: configured.privateNetworkApproved,
              state: probe.state,
              liveModels: probe.models,
              latencyMs: probe.latencyMs,
              message: probe.message,
            };
          }
        )
      );
      providers.sort(
        (left, right) =>
          Number(right.isDefault) - Number(left.isDefault) ||
          left.preset.displayName.localeCompare(right.preset.displayName)
      );
      return {
        schemaVersion: 1,
        runtimeId: 'opencode',
        scope: configTarget.scope,
        projectPath: configTarget.projectPath,
        configPath: configTarget.configPath,
        providers,
      };
    } catch (error) {
      if (error instanceof LocalProviderOperationError) {
        return this.listError(error.code, error.message, error.recoverable);
      }
      return this.listError('config-invalid', 'Could not read the OpenCode config.');
    }
  }

  async scanLocalProviders(
    input: RuntimeLocalProviderScanInput
  ): Promise<RuntimeLocalProviderScanResponse> {
    if (input?.runtimeId !== 'opencode') {
      return this.scanError('invalid-input', 'Only the OpenCode runtime supports local providers.');
    }
    const probes = await Promise.all(
      RUNTIME_LOCAL_PROVIDER_PRESETS.filter((preset) => preset.scannable).map((preset) =>
        this.probeTarget(
          normalizeRuntimeLocalProviderTarget({ presetId: preset.id }),
          SCAN_TIMEOUT_MS
        )
      )
    );
    return { schemaVersion: 1, runtimeId: 'opencode', probes };
  }

  async probeLocalProvider(
    input: RuntimeLocalProviderProbeInput
  ): Promise<RuntimeLocalProviderProbeResponse> {
    if (input?.runtimeId !== 'opencode') {
      return buildLocalProviderProbeError(
        'invalid-input',
        'Only the OpenCode runtime supports local providers.'
      );
    }
    try {
      const target = normalizeRuntimeLocalProviderTarget(input);
      const apiKey = normalizeOptionalProviderApiKey(input.apiKey);
      return {
        schemaVersion: 1,
        runtimeId: 'opencode',
        probe: await this.probeTarget(target, PROBE_TIMEOUT_MS, apiKey),
      };
    } catch (error) {
      return buildLocalProviderProbeError(
        'invalid-input',
        error instanceof RuntimeLocalProviderValidationError
          ? error.message
          : 'Local provider settings are invalid.'
      );
    }
  }

  async configureLocalProvider(
    input: RuntimeLocalProviderConfigureInput
  ): Promise<RuntimeLocalProviderConfigureResponse> {
    if (
      input?.runtimeId !== 'opencode' ||
      (input.scope !== 'global' && input.scope !== 'project')
    ) {
      return buildLocalProviderConfigureError(
        'invalid-input',
        'The local provider configuration scope is invalid.'
      );
    }
    try {
      const target = normalizeRuntimeLocalProviderTarget(input);
      const apiKey = normalizeOptionalProviderApiKey(input.apiKey);
      const defaultModelId = normalizeRuntimeLocalProviderModelId(input.defaultModelId);
      if (!defaultModelId) {
        throw new LocalProviderOperationError('invalid-input', 'Choose a valid local model.');
      }
      if (typeof input.setAsDefault !== 'boolean') {
        throw new LocalProviderOperationError(
          'invalid-input',
          'Default model selection is invalid.'
        );
      }
      if (input.setAsSmallModel !== undefined && typeof input.setAsSmallModel !== 'boolean') {
        throw new LocalProviderOperationError(
          'invalid-input',
          'Lightweight-task model selection is invalid.'
        );
      }
      if (
        input.preserveAvailableConfiguredModels !== undefined &&
        typeof input.preserveAvailableConfiguredModels !== 'boolean'
      ) {
        throw new LocalProviderOperationError('invalid-input', 'Model update mode is invalid.');
      }

      const probe = await this.probeTarget(target, PROBE_TIMEOUT_MS, apiKey);
      if (!probe.state || probe.state !== 'available') {
        throw new LocalProviderOperationError('endpoint-unreachable', probe.message);
      }
      const reportedModelIds = probe.models.map((model) => model.id);
      const modelIds = resolveRequestedLocalProviderModelIds(reportedModelIds, input.modelIds);
      if (!modelIds?.includes(defaultModelId)) {
        throw new LocalProviderOperationError(
          'invalid-input',
          'The selected model is no longer reported by the endpoint.'
        );
      }

      const selectedModelConfig = apiKey
        ? null
        : await this.fetchModelConfigMetadata(target, defaultModelId);
      const setAsSmallModel = input.setAsSmallModel ?? input.setAsDefault;

      const configured = await this.writeConfig({
        scope: input.scope,
        projectPath: input.projectPath,
        providerId: target.providerId,
        baseUrl: target.baseUrl,
        modelIds,
        availableModelIds: reportedModelIds,
        replaceModels: input.modelIds !== undefined,
        preserveAvailableConfiguredModels: input.preserveAvailableConfiguredModels === true,
        defaultModelId,
        setAsDefault: input.setAsDefault,
        setAsSmallModel,
        selectedModelConfig,
        apiKey,
      });
      if (isPrivateNetworkRuntimeLocalProviderUrl(target.baseUrl)) {
        try {
          await this.privateNetworkApprovalStore.approve({
            configPath: configured.configPath,
            providerId: target.providerId,
            baseUrl: target.baseUrl,
          });
        } catch {
          throw new LocalProviderOperationError(
            'approval-write-failed',
            'The OpenCode config was updated, but Agent Teams could not save private network approval. Retry to approve this address.'
          );
        }
      }
      return {
        schemaVersion: 1,
        runtimeId: 'opencode',
        configuration: {
          providerId: target.providerId,
          baseUrl: target.baseUrl,
          modelIds: configured.modelIds,
          defaultModelId,
          modelRoute: buildRuntimeLocalProviderModelRoute(target.providerId, defaultModelId),
          configPath: configured.configPath,
          scope: input.scope,
          setAsDefault: input.setAsDefault,
          setAsSmallModel,
        },
      };
    } catch (error) {
      if (error instanceof RuntimeLocalProviderValidationError) {
        return buildLocalProviderConfigureError('invalid-input', error.message);
      }
      if (error instanceof LocalProviderOperationError) {
        return buildLocalProviderConfigureError(error.code, error.message, error.recoverable);
      }
      return buildLocalProviderConfigureError('write-failed', 'Could not update OpenCode config.');
    }
  }

  private async probeTarget(
    target: ReturnType<typeof normalizeRuntimeLocalProviderTarget>,
    timeoutMs: number,
    apiKey: string | null = null
  ): Promise<RuntimeLocalProviderProbeDto> {
    const outcome = await this.fetchModels(target, timeoutMs, apiKey);
    return {
      preset: target.preset,
      providerId: target.providerId,
      baseUrl: target.baseUrl,
      state: outcome.available ? 'available' : 'unavailable',
      models: outcome.models,
      latencyMs: outcome.latencyMs,
      message: outcome.message,
    };
  }

  private async fetchModels(
    target: ReturnType<typeof normalizeRuntimeLocalProviderTarget>,
    timeoutMs: number,
    apiKey: string | null
  ): Promise<ModelProbeOutcome> {
    const baseUrl = target.baseUrl;
    const startedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      });
      const latencyMs = Math.max(0, this.now() - startedAt);
      if (!response.ok) {
        return {
          available: false,
          models: [],
          latencyMs,
          message: `Endpoint returned HTTP ${response.status} for /models.`,
        };
      }
      const declaredSize = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
        return {
          available: false,
          models: [],
          latencyMs,
          message: 'Endpoint returned a model list that is too large.',
        };
      }
      const raw = await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES);
      if (raw === null) {
        return {
          available: false,
          models: [],
          latencyMs,
          message: 'Endpoint returned a model list that is too large.',
        };
      }
      let models: RuntimeLocalProviderModelDto[];
      try {
        models = readOpenAiModels(raw);
      } catch {
        return {
          available: false,
          models: [],
          latencyMs,
          message: 'Endpoint returned an invalid OpenAI-compatible model list.',
        };
      }
      const reportedModelCount = models.length;
      if (target.preset.id === 'ollama' && models.length > 0 && !apiKey) {
        // Give the per-model capability requests their own timeout budget: a
        // short scan timeout that already elapsed while fetching /models would
        // otherwise abort every /api/show call and skip capability filtering.
        const filterController = new AbortController();
        const filterTimeout = setTimeout(() => filterController.abort(), MODEL_METADATA_TIMEOUT_MS);
        filterTimeout.unref?.();
        try {
          models = await filterOllamaCompletionModels({
            baseUrl,
            models,
            signal: filterController.signal,
            fetchImpl: this.fetchImpl,
            maxResponseBytes: MAX_RESPONSE_BYTES,
          });
        } finally {
          clearTimeout(filterTimeout);
        }
      }
      return {
        available: true,
        models,
        latencyMs,
        message:
          models.length > 0
            ? `Connected. Found ${models.length} model${models.length === 1 ? '' : 's'}.`
            : reportedModelCount > 0 && target.preset.id === 'ollama'
              ? 'Connected, but Ollama did not report any chat-capable models.'
              : 'Connected, but the server did not report any loaded models.',
      };
    } catch (error) {
      const latencyMs = Math.max(0, this.now() - startedAt);
      return {
        available: false,
        models: [],
        latencyMs,
        message:
          error instanceof Error && error.name === 'AbortError'
            ? 'Connection timed out. Check the endpoint and try again.'
            : 'Could not reach the endpoint. Check it and try again.',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchModelConfigMetadata(
    target: ReturnType<typeof normalizeRuntimeLocalProviderTarget>,
    modelId: string
  ): Promise<LocalModelConfigMetadata | null> {
    const metadata = await this.fetchServerModelMetadata(target, modelId);
    if (!metadata) return null;
    const modelConfig: LocalModelConfigMetadata = {
      ...(metadata.toolCapable === true ? { tool_call: true as const } : {}),
      options: {
        reasoningEffort: 'none',
      },
      ...(metadata.contextTokens
        ? {
            limit: {
              context: metadata.contextTokens,
              output: Math.min(DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS, metadata.contextTokens),
            },
          }
        : {}),
    };
    return Object.keys(modelConfig).length > 0 ? modelConfig : null;
  }

  private async fetchServerModelMetadata(
    target: ReturnType<typeof normalizeRuntimeLocalProviderTarget>,
    modelId: string
  ): Promise<LocalServerModelMetadata | null> {
    const request = buildLocalServerModelMetadataRequest(target.preset.id, target.baseUrl, modelId);
    if (!request) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_METADATA_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: {
          accept: 'application/json',
          ...(request.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(request.body ? { body: request.body } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const raw = await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES);
      if (!raw) return null;
      return request.parse(raw);
    } catch {
      // OpenAI-compatible servers do not have to expose their native
      // metadata endpoint. Connecting the provider must still work when the
      // optional enrichment request is unavailable.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async writeConfig(
    input: LocalProviderConfigWriteInput
  ): Promise<LocalProviderConfigWriteResult> {
    // Chain onto any in-flight write so the read-modify-write below runs after
    // the previous one fully committed (no lost update on concurrent configures).
    const run = this.configWriteChain.then(
      () => this.writeConfigNow(input),
      () => this.writeConfigNow(input)
    );
    this.configWriteChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async writeConfigNow(
    input: LocalProviderConfigWriteInput
  ): Promise<LocalProviderConfigWriteResult> {
    const configTarget = await this.readConfigTarget(input.scope, input.projectPath, true);
    const configPath = configTarget.configPath;
    const raw = configTarget.raw ?? '{}\n';
    const isNewConfig = configTarget.raw === null;
    const parseErrors: ParseError[] = [];
    const configTree = parseTree(raw, parseErrors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (parseErrors.length > 0 || !configTree || configTree.type !== 'object') {
      throw new LocalProviderOperationError(
        'config-invalid',
        'The existing OpenCode config contains invalid JSON or JSONC.'
      );
    }
    if (hasDuplicateObjectProperties(configTree)) {
      throw new LocalProviderOperationError(
        'config-invalid',
        'The existing OpenCode config contains duplicate object keys and must be fixed manually.'
      );
    }

    const providerRootNode = findNodeAtLocation(configTree, ['provider']);
    if (providerRootNode && providerRootNode.type !== 'object') {
      throw new LocalProviderOperationError(
        'config-invalid',
        'The existing OpenCode provider configuration must be an object.'
      );
    }
    const apiKeyReference = input.apiKey
      ? await this.writeProviderApiKey(configPath, input.providerId, input.apiKey)
      : null;

    const previousApiKeyReference = assertProviderApiKeyReplacement(configTree, input);
    const apiKeyReference = input.apiKey
      ? createProviderApiKeyReference({
          configPath,
          providerId: input.providerId,
        })
      : null;
    let nextRaw = raw;
    if (isNewConfig) {
      nextRaw = setJsoncValue(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
    }
    const providerNode = findNodeAtLocation(configTree, ['provider', input.providerId]);
    const modelsNode = findNodeAtLocation(configTree, ['provider', input.providerId, 'models']);
    const persistedModelIds =
      input.replaceModels && input.preserveAvailableConfiguredModels
        ? mergeAvailableConfiguredModelIds(input.modelIds, input.availableModelIds, modelsNode)
        : input.modelIds;
    if (!providerNode || providerNode.type !== 'object') {
      nextRaw = setJsoncValue(nextRaw, ['provider', input.providerId], {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: input.baseUrl,
          ...(apiKeyReference ? { apiKey: apiKeyReference } : {}),
        },
        models: createModelRecord(
          persistedModelIds,
          input.defaultModelId,
          input.selectedModelConfig
        ),
      });
    } else {
      nextRaw = setJsoncValue(
        nextRaw,
        ['provider', input.providerId, 'npm'],
        '@ai-sdk/openai-compatible'
      );
      const optionsNode = findNodeAtLocation(configTree, ['provider', input.providerId, 'options']);
      nextRaw =
        optionsNode && optionsNode.type !== 'object'
          ? setJsoncValue(nextRaw, ['provider', input.providerId, 'options'], {
              baseURL: input.baseUrl,
              ...(apiKeyReference ? { apiKey: apiKeyReference } : {}),
            })
          : setJsoncValue(
              nextRaw,
              ['provider', input.providerId, 'options', 'baseURL'],
              input.baseUrl
            );
      if (apiKeyReference && (!optionsNode || optionsNode.type === 'object')) {
        nextRaw = setJsoncValue(
          nextRaw,
          ['provider', input.providerId, 'options', 'apiKey'],
          apiKeyReference
        );
      }

      nextRaw = updateJsoncProviderModels(
        nextRaw,
        modelsNode,
        input.providerId,
        persistedModelIds,
        input.defaultModelId,
        input.selectedModelConfig,
        input.replaceModels
      );
    }
    if (input.setAsDefault) {
      const modelRoute = buildRuntimeLocalProviderModelRoute(
        input.providerId,
        input.defaultModelId
      );
      nextRaw = setJsoncValue(nextRaw, ['model'], modelRoute);
    }
    if (input.setAsSmallModel) {
      nextRaw = setJsoncValue(
        nextRaw,
        ['small_model'],
        buildRuntimeLocalProviderModelRoute(input.providerId, input.defaultModelId)
      );
    }
    await commitProviderConfigWithCredential({
      homePath: this.homePath,
      configPath,
      providerId: input.providerId,
      apiKey: input.apiKey,
      apiKeyReference,
      previousApiKeyReference,
      contents: `${nextRaw.trimEnd()}\n`,
      mode: configTarget.mode ?? 0o600,
    });
    return { configPath, modelIds: persistedModelIds };
  }

  private async writeProviderApiKey(
    configPath: string,
    providerId: string,
    apiKey: string
  ): Promise<string> {
    let realHomePath: string;
    try {
      const homeStat = await fs.stat(this.homePath);
      if (!homeStat.isDirectory()) throw new Error('not-directory');
      realHomePath = await fs.realpath(this.homePath);
    } catch {
      throw new LocalProviderOperationError(
        'write-failed',
        'The user home directory is not available for provider credential storage.'
      );
    }

    let credentialDirectory = realHomePath;
    for (const segment of PROVIDER_CREDENTIAL_DIRECTORY_SEGMENTS) {
      credentialDirectory = path.join(credentialDirectory, segment);
      try {
        const stat = await fs.lstat(credentialDirectory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new LocalProviderOperationError(
            'config-conflict',
            'The provider credential directory must be a regular directory.'
          );
        }
      } catch (error) {
        if (error instanceof LocalProviderOperationError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new LocalProviderOperationError(
            'write-failed',
            'Could not inspect the provider credential directory.'
          );
        }
        await fs.mkdir(credentialDirectory, { mode: 0o700 });
      }
    }

    const realCredentialDirectory = await fs.realpath(credentialDirectory);
    if (!isPathInside(realHomePath, realCredentialDirectory)) {
      throw new LocalProviderOperationError(
        'config-conflict',
        'The provider credential directory resolves outside the user home directory.'
      );
    }
    if (process.platform !== 'win32') {
      await fs.chmod(realCredentialDirectory, 0o700);
    }

    const scopeHash = createHash('sha256')
      .update(path.resolve(configPath))
      .digest('hex')
      .slice(0, 16);
    const filename = `${providerId}-${scopeHash}.key`;
    const credentialPath = path.join(realCredentialDirectory, filename);
    try {
      const existing = await fs.lstat(credentialPath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new LocalProviderOperationError(
          'config-conflict',
          'The provider credential path must be a regular file.'
        );
      }
    } catch (error) {
      if (error instanceof LocalProviderOperationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalProviderOperationError(
          'write-failed',
          'Could not inspect the provider credential file.'
        );
      }
    }

    await atomicWriteAsync(credentialPath, apiKey, {
      mode: 0o600,
      durability: 'strict',
      syncDirectory: true,
    });
    return `{file:~/.config/opencode/agent-teams-credentials/${filename}}`;
  }

  private readConfigTarget(
    scope: RuntimeLocalProviderScopeDto,
    projectPath: string | null | undefined,
    ensureGlobalDirectory = false
  ): Promise<OpenCodeConfigTarget> {
    return scope === 'global'
      ? this.readGlobalConfig(ensureGlobalDirectory)
      : this.readProjectConfig(projectPath);
  }

  private async readGlobalConfig(ensureDirectory: boolean): Promise<OpenCodeConfigTarget> {
    let realHomePath: string;
    try {
      const homeStat = await fs.stat(this.homePath);
      if (!homeStat.isDirectory()) throw new Error('not-directory');
      realHomePath = await fs.realpath(this.homePath);
    } catch {
      throw new LocalProviderOperationError(
        'config-invalid',
        'The user home directory is not available for the global OpenCode config.'
      );
    }

    let configDirectory = realHomePath;
    for (const segment of ['.config', 'opencode']) {
      configDirectory = path.join(configDirectory, segment);
      try {
        const stat = await fs.lstat(configDirectory);
        if (stat.isSymbolicLink()) {
          throw new LocalProviderOperationError(
            'config-conflict',
            'The global OpenCode config directory is a symbolic link and must be updated manually.'
          );
        }
        if (!stat.isDirectory()) {
          throw new LocalProviderOperationError(
            'config-conflict',
            'The global OpenCode config path is not a directory.'
          );
        }
      } catch (error) {
        if (error instanceof LocalProviderOperationError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new LocalProviderOperationError(
            'config-invalid',
            'Could not inspect the global OpenCode config directory.'
          );
        }
        if (!ensureDirectory) {
          return {
            scope: 'global',
            configPath: path.join(realHomePath, '.config', 'opencode', 'opencode.json'),
            raw: null,
          };
        }
        await fs.mkdir(configDirectory, { mode: 0o700 });
      }
    }

    const realConfigDirectory = await fs.realpath(configDirectory);
    if (!isPathInside(realHomePath, realConfigDirectory)) {
      throw new LocalProviderOperationError(
        'config-conflict',
        'The global OpenCode config resolves outside the user home directory.'
      );
    }

    const existingConfigs: Array<{ path: string; mode: number }> = [];
    for (const filename of GLOBAL_CONFIG_FILENAMES) {
      const candidate = path.join(realConfigDirectory, filename);
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink()) {
          throw new LocalProviderOperationError(
            'config-conflict',
            'The global OpenCode config is a symbolic link and must be updated manually.'
          );
        }
        if (stat.isFile()) {
          existingConfigs.push({ path: candidate, mode: stat.mode & 0o777 });
        }
      } catch (error) {
        if (error instanceof LocalProviderOperationError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new LocalProviderOperationError(
            'config-invalid',
            'Could not inspect the global OpenCode config.'
          );
        }
      }
    }
    if (existingConfigs.length > 1) {
      throw new LocalProviderOperationError(
        'config-conflict',
        'Both global opencode.json and opencode.jsonc were found. Keep one config file and retry.'
      );
    }
    const existingConfig = existingConfigs[0];
    const configPath = existingConfig?.path ?? path.join(realConfigDirectory, 'opencode.json');
    return {
      scope: 'global',
      configPath,
      raw: existingConfig ? await fs.readFile(configPath, 'utf8') : null,
      mode: existingConfig?.mode,
    };
  }

  private async readProjectConfig(
    projectPathInput: string | null | undefined
  ): Promise<OpenCodeConfigTarget> {
    const projectPath = projectPathInput?.trim();
    if (!projectPath) {
      throw new LocalProviderOperationError(
        'project-required',
        'Select a project before loading local providers.'
      );
    }
    let realProjectPath: string;
    try {
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) throw new Error('not-directory');
      realProjectPath = await fs.realpath(projectPath);
    } catch {
      throw new LocalProviderOperationError(
        'project-required',
        'The selected project directory is not available.'
      );
    }

    const existingConfigs: Array<{ path: string; mode: number }> = [];
    for (const relativePath of CONFIG_CANDIDATES) {
      const candidate = path.join(realProjectPath, relativePath);
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink()) {
          throw new LocalProviderOperationError(
            'config-conflict',
            'The OpenCode config is a symbolic link and must be updated manually.'
          );
        }
        if (stat.isFile()) {
          const realConfigPath = await fs.realpath(candidate);
          if (!isPathInside(realProjectPath, realConfigPath)) {
            throw new LocalProviderOperationError(
              'config-conflict',
              'The OpenCode config resolves outside the selected project and must be updated manually.'
            );
          }
          existingConfigs.push({ path: candidate, mode: stat.mode & 0o777 });
        }
      } catch (error) {
        if (error instanceof LocalProviderOperationError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new LocalProviderOperationError(
            'config-invalid',
            'Could not inspect the OpenCode project config.'
          );
        }
      }
    }
    if (existingConfigs.length > 1) {
      throw new LocalProviderOperationError(
        'config-conflict',
        'Multiple OpenCode project configs were found. Keep one config file and retry.'
      );
    }
    const existingConfig = existingConfigs[0];
    const configPath = existingConfig?.path ?? path.join(realProjectPath, 'opencode.json');
    return {
      scope: 'project',
      projectPath: realProjectPath,
      configPath,
      raw: existingConfig ? await fs.readFile(configPath, 'utf8') : null,
      mode: existingConfig?.mode,
    };
  }

  private listError(
    code: RuntimeLocalProviderErrorCodeDto,
    message: string,
    recoverable = true
  ): RuntimeLocalProviderListResponse {
    return { schemaVersion: 1, runtimeId: 'opencode', error: { code, message, recoverable } };
  }

  private scanError(
    code: RuntimeLocalProviderErrorCodeDto,
    message: string
  ): RuntimeLocalProviderScanResponse {
    return { schemaVersion: 1, runtimeId: 'opencode', error: { code, message, recoverable: true } };
  }
}

function parseConfigTree(raw: string): JsoncNode {
  const parseErrors: ParseError[] = [];
  const configTree = parseTree(raw, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (parseErrors.length > 0 || !configTree || configTree.type !== 'object') {
    throw new LocalProviderOperationError(
      'config-invalid',
      'The existing OpenCode config contains invalid JSON or JSONC.'
    );
  }
  if (hasDuplicateObjectProperties(configTree)) {
    throw new LocalProviderOperationError(
      'config-invalid',
      'The existing OpenCode config contains duplicate object keys and must be fixed manually.'
    );
  }
  return configTree;
}
