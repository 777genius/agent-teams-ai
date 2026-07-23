import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import {
  applyEdits,
  findNodeAtLocation,
  type FormattingOptions,
  modify,
  type Node as JsoncNode,
  type ParseError,
  parseTree,
} from 'jsonc-parser';

import {
  buildRuntimeLocalProviderModelRoute,
  normalizeRuntimeLocalProviderModelId,
  normalizeRuntimeLocalProviderTarget,
  RUNTIME_LOCAL_PROVIDER_PRESETS,
  RuntimeLocalProviderValidationError,
} from '../../core/domain';

import {
  buildLocalServerModelMetadataRequest,
  type LocalServerModelMetadata,
} from './localServerRuntimeApi';
import { buildOllamaNativeUrl, parseOllamaShowMetadata } from './ollamaRuntimeApi';

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
const MAX_MODELS = 500;
const MAX_RESPONSE_BYTES = 1_048_576;
const PROVIDER_ID_FILTER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONFIG_CANDIDATES = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
] as const;
const GLOBAL_CONFIG_FILENAMES = ['opencode.json', 'opencode.jsonc'] as const;
const JSON_FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

interface OpenCodeLocalProviderConnectorOptions {
  readonly fetchImpl?: typeof fetch;
  readonly homePath?: string;
  readonly now?: () => number;
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

interface LocalModelConfigMetadata {
  readonly tool_call?: true;
  readonly options?: {
    readonly reasoningEffort: 'none';
  };
  readonly limit?: {
    readonly context: number;
    readonly output: number;
  };
}

class LocalProviderOperationError extends Error {
  constructor(
    readonly code: RuntimeLocalProviderErrorCodeDto,
    message: string,
    readonly recoverable = true
  ) {
    super(message);
    this.name = 'LocalProviderOperationError';
  }
}

export class OpenCodeLocalProviderConnector implements RuntimeLocalProviderConnectorPort {
  private readonly fetchImpl: typeof fetch;
  private readonly homePath: string;
  private readonly now: () => number;
  // Serializes config read-modify-write so concurrent configureLocalProvider
  // calls cannot clobber each other (each reads the previous write's result
  // instead of a stale snapshot). Configure is a rare user action, so a single
  // chain is sufficient and avoids config-path key subtleties.
  private configWriteChain: Promise<unknown> = Promise.resolve();

  constructor(options: OpenCodeLocalProviderConnectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.homePath = path.resolve(options.homePath ?? os.homedir());
    this.now = options.now ?? Date.now;
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
              const preset =
                RUNTIME_LOCAL_PROVIDER_PRESETS.find(
                  (candidate) => candidate.providerId === providerId
                ) ?? RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.id === 'custom');
              if (!preset) return null;

              const modelsNode = findNodeAtLocation(configTree, ['provider', providerId, 'models']);
              const configuredModelIds =
                modelsNode?.type === 'object'
                  ? readObjectEntries(modelsNode)
                      .map(({ key }) => normalizeRuntimeLocalProviderModelId(key))
                      .filter((modelId): modelId is string => Boolean(modelId))
                  : [];
              const routePrefix = `${providerId}/`;
              const isDefault = configuredDefaultModel?.startsWith(routePrefix) ?? false;
              const configuredDefaultModelId = isDefault
                ? configuredDefaultModel?.slice(routePrefix.length) || null
                : (configuredModelIds[0] ?? null);
              return {
                preset,
                providerId: target.providerId,
                baseUrl: target.baseUrl,
                configuredModelIds,
                configuredDefaultModelId,
                isDefault,
              };
            })
            .filter((provider): provider is NonNullable<typeof provider> => provider !== null)
            .filter(
              (provider) =>
                requestedProviderId === null || provider.providerId === requestedProviderId
            )
        : [];

      const providers = await Promise.all(
        configuredProviders.map(async (configured): Promise<RuntimeLocalProviderListEntryDto> => {
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
            configuredModelIds: configured.configuredModelIds,
            defaultModelId: liveDefaultStillAvailable
              ? configured.configuredDefaultModelId
              : (configured.configuredDefaultModelId ?? probe.models[0]?.id ?? null),
            isDefault: configured.isDefault,
            state: probe.state,
            liveModels: probe.models,
            latencyMs: probe.latencyMs,
            message: probe.message,
          };
        })
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
      return this.probeError(
        'invalid-input',
        'Only the OpenCode runtime supports local providers.'
      );
    }
    try {
      const target = normalizeRuntimeLocalProviderTarget(input);
      return {
        schemaVersion: 1,
        runtimeId: 'opencode',
        probe: await this.probeTarget(target, PROBE_TIMEOUT_MS),
      };
    } catch (error) {
      return this.probeError(
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
      return this.configureError(
        'invalid-input',
        'The local provider configuration scope is invalid.'
      );
    }
    try {
      const target = normalizeRuntimeLocalProviderTarget(input);
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

      const probe = await this.probeTarget(target, PROBE_TIMEOUT_MS);
      if (!probe.state || probe.state !== 'available') {
        throw new LocalProviderOperationError('endpoint-unreachable', probe.message);
      }
      const modelIds = probe.models.map((model) => model.id);
      if (!modelIds.includes(defaultModelId)) {
        throw new LocalProviderOperationError(
          'invalid-input',
          'The selected model is no longer reported by the local server.'
        );
      }

      const selectedModelConfig = await this.fetchModelConfigMetadata(target, defaultModelId);

      const configPath = await this.writeConfig({
        scope: input.scope,
        projectPath: input.projectPath,
        providerId: target.providerId,
        baseUrl: target.baseUrl,
        modelIds,
        defaultModelId,
        setAsDefault: input.setAsDefault,
        setAsSmallModel: input.setAsDefault && (input.setAsSmallModel ?? true),
        selectedModelConfig,
      });
      return {
        schemaVersion: 1,
        runtimeId: 'opencode',
        configuration: {
          providerId: target.providerId,
          baseUrl: target.baseUrl,
          modelIds,
          defaultModelId,
          modelRoute: buildRuntimeLocalProviderModelRoute(target.providerId, defaultModelId),
          configPath,
          scope: input.scope,
          setAsDefault: input.setAsDefault,
        },
      };
    } catch (error) {
      if (error instanceof RuntimeLocalProviderValidationError) {
        return this.configureError('invalid-input', error.message);
      }
      if (error instanceof LocalProviderOperationError) {
        return this.configureError(error.code, error.message, error.recoverable);
      }
      return this.configureError('write-failed', 'Could not update the OpenCode config.');
    }
  }

  private async probeTarget(
    target: ReturnType<typeof normalizeRuntimeLocalProviderTarget>,
    timeoutMs: number
  ): Promise<RuntimeLocalProviderProbeDto> {
    const outcome = await this.fetchModels(target, timeoutMs);
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
    timeoutMs: number
  ): Promise<ModelProbeOutcome> {
    const baseUrl = target.baseUrl;
    const startedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      const latencyMs = Math.max(0, this.now() - startedAt);
      if (!response.ok) {
        return {
          available: false,
          models: [],
          latencyMs,
          message: `Local server returned HTTP ${response.status} for /models.`,
        };
      }
      const declaredSize = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
        return {
          available: false,
          models: [],
          latencyMs,
          message: 'Local server returned a model list that is too large.',
        };
      }
      const raw = await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES);
      if (raw === null) {
        return {
          available: false,
          models: [],
          latencyMs,
          message: 'Local server returned a model list that is too large.',
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
          message: 'Local server returned an invalid OpenAI-compatible model list.',
        };
      }
      const reportedModelCount = models.length;
      if (target.preset.id === 'ollama' && models.length > 0) {
        // Give the per-model capability requests their own timeout budget: a
        // short scan timeout that already elapsed while fetching /models would
        // otherwise abort every /api/show call and skip capability filtering.
        const filterController = new AbortController();
        const filterTimeout = setTimeout(() => filterController.abort(), MODEL_METADATA_TIMEOUT_MS);
        filterTimeout.unref?.();
        try {
          models = await this.filterOllamaCompletionModels(
            baseUrl,
            models,
            filterController.signal
          );
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
            ? 'Connection timed out. Start the local server and try again.'
            : 'Could not reach the local server. Start it and try again.',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async filterOllamaCompletionModels(
    baseUrl: string,
    models: RuntimeLocalProviderModelDto[],
    signal: AbortSignal
  ): Promise<RuntimeLocalProviderModelDto[]> {
    const eligible = new Array<boolean>(models.length).fill(true);
    let nextIndex = 0;
    const workerCount = Math.min(8, models.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < models.length) {
          const index = nextIndex;
          nextIndex += 1;
          eligible[index] = await this.isOllamaCompletionModel(baseUrl, models[index].id, signal);
        }
      })
    );
    return models.filter((_model, index) => eligible[index]);
  }

  private async isOllamaCompletionModel(
    baseUrl: string,
    modelId: string,
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      const response = await this.fetchImpl(buildOllamaNativeUrl(baseUrl, '/api/show'), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: modelId }),
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        return response.status < 400 || response.status >= 500;
      }
      const raw = await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES);
      if (!raw) return true;
      return parseOllamaShowMetadata(raw)?.completionCapable !== false;
    } catch {
      // Older or temporarily busy Ollama servers may not expose model metadata.
      // Keep the model visible and let launch verification decide compatibility.
      return true;
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

  private async writeConfig(input: {
    scope: RuntimeLocalProviderScopeDto;
    projectPath?: string | null;
    providerId: string;
    baseUrl: string;
    modelIds: readonly string[];
    defaultModelId: string;
    setAsDefault: boolean;
    setAsSmallModel: boolean;
    selectedModelConfig: LocalModelConfigMetadata | null;
  }): Promise<string> {
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

  private async writeConfigNow(input: {
    scope: RuntimeLocalProviderScopeDto;
    projectPath?: string | null;
    providerId: string;
    baseUrl: string;
    modelIds: readonly string[];
    defaultModelId: string;
    setAsDefault: boolean;
    setAsSmallModel: boolean;
    selectedModelConfig?: LocalModelConfigMetadata | null;
  }): Promise<string> {
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

    let nextRaw = raw;
    if (isNewConfig) {
      nextRaw = setJsoncValue(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
    }
    const providerNode = findNodeAtLocation(configTree, ['provider', input.providerId]);
    if (!providerNode || providerNode.type !== 'object') {
      nextRaw = setJsoncValue(nextRaw, ['provider', input.providerId], {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: input.baseUrl },
        models: createModelRecord(input.modelIds, input.defaultModelId, input.selectedModelConfig),
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
            })
          : setJsoncValue(
              nextRaw,
              ['provider', input.providerId, 'options', 'baseURL'],
              input.baseUrl
            );

      const modelsNode = findNodeAtLocation(configTree, ['provider', input.providerId, 'models']);
      if (modelsNode && modelsNode.type === 'object') {
        for (const modelId of input.modelIds) {
          if (!findNodeAtLocation(configTree, ['provider', input.providerId, 'models', modelId])) {
            nextRaw = setJsoncValue(
              nextRaw,
              ['provider', input.providerId, 'models', modelId],
              modelId === input.defaultModelId ? (input.selectedModelConfig ?? {}) : {}
            );
          }
        }
      } else {
        nextRaw = setJsoncValue(
          nextRaw,
          ['provider', input.providerId, 'models'],
          createModelRecord(input.modelIds, input.defaultModelId, input.selectedModelConfig)
        );
      }

      for (const [key, value] of Object.entries(input.selectedModelConfig ?? {})) {
        nextRaw = setJsoncValue(
          nextRaw,
          ['provider', input.providerId, 'models', input.defaultModelId, key],
          value
        );
      }
    }
    if (input.setAsDefault) {
      const modelRoute = buildRuntimeLocalProviderModelRoute(
        input.providerId,
        input.defaultModelId
      );
      nextRaw = setJsoncValue(nextRaw, ['model'], modelRoute);
      if (input.setAsSmallModel) {
        nextRaw = setJsoncValue(nextRaw, ['small_model'], modelRoute);
      }
    }
    await atomicWriteAsync(configPath, `${nextRaw.trimEnd()}\n`, {
      // OpenCode configs can contain provider credentials. Preserve an existing
      // file's access mode and keep newly-created configs private.
      mode: configTarget.mode ?? 0o600,
    });
    return configPath;
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

  private probeError(
    code: RuntimeLocalProviderErrorCodeDto,
    message: string
  ): RuntimeLocalProviderProbeResponse {
    return { schemaVersion: 1, runtimeId: 'opencode', error: { code, message, recoverable: true } };
  }

  private configureError(
    code: RuntimeLocalProviderErrorCodeDto,
    message: string,
    recoverable = true
  ): RuntimeLocalProviderConfigureResponse {
    return { schemaVersion: 1, runtimeId: 'opencode', error: { code, message, recoverable } };
  }
}

function readOpenAiModels(raw: string): RuntimeLocalProviderModelDto[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid-json');
  }
  const data = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : null;
  if (!data) {
    throw new Error('invalid-model-list');
  }
  const models = new Map<string, RuntimeLocalProviderModelDto>();
  for (const entry of data.slice(0, MAX_MODELS)) {
    const record = asRecord(entry);
    const id = normalizeRuntimeLocalProviderModelId(record?.id);
    if (!id || models.has(id)) {
      continue;
    }
    const name = normalizeRuntimeLocalProviderModelId(record?.name);
    models.set(id, { id, displayName: name ?? id });
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
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

function readStringNode(node: JsoncNode | undefined): string | null {
  return node?.type === 'string' && typeof node.value === 'string' ? node.value : null;
}

function readObjectEntries(node: JsoncNode): Array<{ key: string; value: JsoncNode }> {
  if (node.type !== 'object') return [];
  return (node.children ?? []).flatMap((property) => {
    const keyNode = property.children?.[0];
    const valueNode = property.children?.[1];
    return keyNode?.type === 'string' && typeof keyNode.value === 'string' && valueNode
      ? [{ key: keyNode.value, value: valueNode }]
      : [];
  });
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const raw = await response.text();
    return Buffer.byteLength(raw, 'utf8') <= maxBytes ? raw : null;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks, totalBytes).toString('utf8');
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
}

function setJsoncValue(raw: string, pathSegments: (string | number)[], value: unknown): string {
  return applyEdits(raw, modify(raw, pathSegments, value, { formattingOptions: JSON_FORMATTING }));
}

function createModelRecord(
  modelIds: readonly string[],
  selectedModelId?: string,
  selectedModelConfig?: LocalModelConfigMetadata | null
): Record<string, unknown> {
  const models = Object.create(null) as Record<string, unknown>;
  for (const modelId of modelIds) {
    models[modelId] = modelId === selectedModelId && selectedModelConfig ? selectedModelConfig : {};
  }
  return models;
}

function hasDuplicateObjectProperties(node: JsoncNode): boolean {
  if (node.type === 'array') {
    return node.children?.some(hasDuplicateObjectProperties) ?? false;
  }
  if (node.type !== 'object') {
    return false;
  }

  const propertyNames = new Set<string>();
  for (const property of node.children ?? []) {
    const propertyName = property.children?.[0]?.value;
    if (typeof propertyName === 'string') {
      if (propertyNames.has(propertyName)) {
        return true;
      }
      propertyNames.add(propertyName);
    }
    const propertyValue = property.children?.[1];
    if (propertyValue && hasDuplicateObjectProperties(propertyValue)) {
      return true;
    }
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}
