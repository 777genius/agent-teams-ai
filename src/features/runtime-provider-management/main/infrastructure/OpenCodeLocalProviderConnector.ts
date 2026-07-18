import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { applyEdits, type FormattingOptions, modify, parse, type ParseError } from 'jsonc-parser';

import {
  buildRuntimeLocalProviderModelRoute,
  normalizeRuntimeLocalProviderModelId,
  normalizeRuntimeLocalProviderTarget,
  RUNTIME_LOCAL_PROVIDER_PRESETS,
  RuntimeLocalProviderValidationError,
} from '../../core/domain';

import type {
  RuntimeLocalProviderConfigureInput,
  RuntimeLocalProviderConfigureResponse,
  RuntimeLocalProviderErrorCodeDto,
  RuntimeLocalProviderModelDto,
  RuntimeLocalProviderProbeDto,
  RuntimeLocalProviderProbeInput,
  RuntimeLocalProviderProbeResponse,
  RuntimeLocalProviderScanInput,
  RuntimeLocalProviderScanResponse,
} from '../../contracts';
import type { RuntimeLocalProviderConnectorPort } from '../../core/application';

const SCAN_TIMEOUT_MS = 1_200;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_MODELS = 500;
const MAX_RESPONSE_BYTES = 1_048_576;
const CONFIG_CANDIDATES = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
] as const;
const JSON_FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

interface OpenCodeLocalProviderConnectorOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface ModelProbeOutcome {
  readonly models: readonly RuntimeLocalProviderModelDto[];
  readonly latencyMs: number;
  readonly message: string;
  readonly available: boolean;
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
  private readonly now: () => number;

  constructor(options: OpenCodeLocalProviderConnectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
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
    if (input?.runtimeId !== 'opencode') {
      return this.configureError(
        'invalid-input',
        'Only the OpenCode runtime supports local providers.'
      );
    }
    try {
      const target = normalizeRuntimeLocalProviderTarget(input);
      const defaultModelId = normalizeRuntimeLocalProviderModelId(input.defaultModelId);
      if (!defaultModelId) {
        throw new LocalProviderOperationError('invalid-input', 'Choose a valid local model.');
      }
      if (typeof input.setAsProjectDefault !== 'boolean') {
        throw new LocalProviderOperationError(
          'invalid-input',
          'Project default selection is invalid.'
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

      const configPath = await this.writeProjectConfig({
        projectPath: input.projectPath,
        providerId: target.providerId,
        baseUrl: target.baseUrl,
        modelIds,
        defaultModelId,
        setAsProjectDefault: input.setAsProjectDefault,
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
          setAsProjectDefault: input.setAsProjectDefault,
        },
      };
    } catch (error) {
      if (error instanceof RuntimeLocalProviderValidationError) {
        return this.configureError('invalid-input', error.message);
      }
      if (error instanceof LocalProviderOperationError) {
        return this.configureError(error.code, error.message, error.recoverable);
      }
      return this.configureError('write-failed', 'Could not update the OpenCode project config.');
    }
  }

  private async probeTarget(
    target: ReturnType<typeof normalizeRuntimeLocalProviderTarget>,
    timeoutMs: number
  ): Promise<RuntimeLocalProviderProbeDto> {
    const outcome = await this.fetchModels(target.baseUrl, timeoutMs);
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

  private async fetchModels(baseUrl: string, timeoutMs: number): Promise<ModelProbeOutcome> {
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
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
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
      return {
        available: true,
        models,
        latencyMs,
        message:
          models.length > 0
            ? `Connected. Found ${models.length} model${models.length === 1 ? '' : 's'}.`
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

  private async writeProjectConfig(input: {
    projectPath: string;
    providerId: string;
    baseUrl: string;
    modelIds: readonly string[];
    defaultModelId: string;
    setAsProjectDefault: boolean;
  }): Promise<string> {
    const projectPath = input.projectPath?.trim();
    if (!projectPath) {
      throw new LocalProviderOperationError(
        'project-required',
        'Select a project before configuring a local provider.'
      );
    }

    let realProjectPath: string;
    try {
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) {
        throw new Error('not-directory');
      }
      realProjectPath = await fs.realpath(projectPath);
    } catch {
      throw new LocalProviderOperationError(
        'project-required',
        'The selected project directory is not available.'
      );
    }

    const existingConfigPaths: string[] = [];
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
          existingConfigPaths.push(candidate);
        }
      } catch (error) {
        if (error instanceof LocalProviderOperationError) {
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new LocalProviderOperationError(
            'write-failed',
            'Could not inspect the OpenCode project config.'
          );
        }
      }
    }
    if (existingConfigPaths.length > 1) {
      throw new LocalProviderOperationError(
        'config-conflict',
        'Multiple OpenCode project configs were found. Keep one config file and retry.'
      );
    }

    const configPath = existingConfigPaths[0] ?? path.join(realProjectPath, 'opencode.json');
    let raw = '{}\n';
    let isNewConfig = true;
    if (existingConfigPaths.length === 1) {
      isNewConfig = false;
      raw = await fs.readFile(configPath, 'utf8');
    }
    const parseErrors: ParseError[] = [];
    const parsed = parse(raw, parseErrors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (parseErrors.length > 0 || !isRecord(parsed)) {
      throw new LocalProviderOperationError(
        'config-invalid',
        'The existing OpenCode config contains invalid JSON or JSONC.'
      );
    }

    const providerRecord = asRecord(asRecord(parsed.provider)?.[input.providerId]);
    const existingOptions = asRecord(providerRecord?.options) ?? {};
    const existingModels = asRecord(providerRecord?.models) ?? {};
    const nextModels = { ...existingModels };
    for (const modelId of input.modelIds) {
      nextModels[modelId] = asRecord(existingModels[modelId]) ?? {};
    }
    const nextProvider = {
      ...(providerRecord ?? {}),
      npm: '@ai-sdk/openai-compatible',
      options: {
        ...existingOptions,
        baseURL: input.baseUrl,
      },
      models: nextModels,
    };

    let nextRaw = raw;
    if (isNewConfig) {
      nextRaw = setJsoncValue(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
    }
    nextRaw = setJsoncValue(nextRaw, ['provider', input.providerId], nextProvider);
    if (input.setAsProjectDefault) {
      const modelRoute = buildRuntimeLocalProviderModelRoute(
        input.providerId,
        input.defaultModelId
      );
      nextRaw = setJsoncValue(nextRaw, ['model'], modelRoute);
      nextRaw = setJsoncValue(nextRaw, ['small_model'], modelRoute);
    }
    await atomicWriteAsync(configPath, `${nextRaw.trimEnd()}\n`);
    return configPath;
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

function setJsoncValue(raw: string, pathSegments: (string | number)[], value: unknown): string {
  return applyEdits(raw, modify(raw, pathSegments, value, { formattingOptions: JSON_FORMATTING }));
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
