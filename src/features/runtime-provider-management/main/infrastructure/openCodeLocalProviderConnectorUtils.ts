import * as path from 'node:path';

import { applyEdits, type FormattingOptions, modify, type Node as JsoncNode } from 'jsonc-parser';

import { normalizeRuntimeLocalProviderModelId } from '../../core/domain';

import type {
  RuntimeLocalProviderConfigureResponse,
  RuntimeLocalProviderErrorCodeDto,
  RuntimeLocalProviderModelDto,
  RuntimeLocalProviderProbeResponse,
  RuntimeLocalProviderScopeDto,
} from '../../contracts';

const MAX_MODELS = 500;
const JSON_FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

export interface LocalModelConfigMetadata {
  readonly tool_call?: true;
  readonly options?: {
    readonly reasoningEffort: 'none';
  };
  readonly limit?: {
    readonly context: number;
    readonly output: number;
  };
}

export interface LocalProviderConfigWriteInput {
  readonly scope: RuntimeLocalProviderScopeDto;
  readonly projectPath?: string | null;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelIds: readonly string[];
  readonly availableModelIds: readonly string[];
  readonly replaceModels: boolean;
  readonly preserveAvailableConfiguredModels: boolean;
  readonly defaultModelId: string;
  readonly setAsDefault: boolean;
  readonly setAsSmallModel: boolean;
  readonly selectedModelConfig: LocalModelConfigMetadata | null;
}

export interface LocalProviderConfigWriteResult {
  readonly configPath: string;
  readonly modelIds: readonly string[];
}

/** Creates a recoverable local-provider probe error response. */
export function buildLocalProviderProbeError(
  code: RuntimeLocalProviderErrorCodeDto,
  message: string
): RuntimeLocalProviderProbeResponse {
  return { schemaVersion: 1, runtimeId: 'opencode', error: { code, message, recoverable: true } };
}

/** Creates a local-provider configuration error response. */
export function buildLocalProviderConfigureError(
  code: RuntimeLocalProviderErrorCodeDto,
  message: string,
  recoverable = true
): RuntimeLocalProviderConfigureResponse {
  return { schemaVersion: 1, runtimeId: 'opencode', error: { code, message, recoverable } };
}

/** Parses and de-duplicates a bounded OpenAI-compatible model list. */
export function readOpenAiModels(raw: string): RuntimeLocalProviderModelDto[] {
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
    if (!id || models.has(id)) continue;
    const name = normalizeRuntimeLocalProviderModelId(record?.name);
    models.set(id, { id, displayName: name ?? id });
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Selects a validated subset of server-reported models, or every model when no subset is requested. */
export function resolveRequestedLocalProviderModelIds(
  availableModelIds: readonly string[],
  requestedModelIds: unknown
): readonly string[] | null {
  if (requestedModelIds === undefined) return availableModelIds;
  if (!Array.isArray(requestedModelIds) || requestedModelIds.length === 0) return null;

  const normalized = requestedModelIds.map(normalizeRuntimeLocalProviderModelId);
  if (normalized.some((modelId) => !modelId)) return null;

  const selected = Array.from(new Set(normalized as string[]));
  const available = new Set(availableModelIds);
  return selected.every((modelId) => available.has(modelId)) ? selected : null;
}

/** Retains concurrently configured models only while the server still reports them. */
export function mergeAvailableConfiguredModelIds(
  requestedModelIds: readonly string[],
  availableModelIds: readonly string[],
  modelsNode: JsoncNode | undefined
): readonly string[] {
  if (modelsNode?.type !== 'object') return requestedModelIds;
  const available = new Set(availableModelIds);
  const configured = readObjectEntries(modelsNode)
    .map(({ key }) => key)
    .filter((modelId) => available.has(modelId));
  return Array.from(new Set([...requestedModelIds, ...configured]));
}

/** Reads a JSONC string node without coercing other scalar types. */
export function readStringNode(node: JsoncNode | undefined): string | null {
  return node?.type === 'string' && typeof node.value === 'string' ? node.value : null;
}

/** Returns the key and value nodes from a JSONC object. */
export function readObjectEntries(node: JsoncNode): Array<{ key: string; value: JsoncNode }> {
  if (node.type !== 'object') return [];
  return (node.children ?? []).flatMap((property) => {
    const keyNode = property.children?.[0];
    const valueNode = property.children?.[1];
    return keyNode?.type === 'string' && typeof keyNode.value === 'string' && valueNode
      ? [{ key: keyNode.value, value: valueNode }]
      : [];
  });
}

/** Applies a formatting-preserving JSONC value update. */
export function setJsoncValue(
  raw: string,
  pathSegments: (string | number)[],
  value: unknown
): string {
  return applyEdits(raw, modify(raw, pathSegments, value, { formattingOptions: JSON_FORMATTING }));
}

/** Updates a provider model map while preserving selected entries and their JSONC metadata. */
export function updateJsoncProviderModels(
  raw: string,
  modelsNode: JsoncNode | undefined,
  providerId: string,
  modelIds: readonly string[],
  defaultModelId: string,
  selectedModelConfig: LocalModelConfigMetadata | null | undefined,
  replaceExisting: boolean
): string {
  const modelsPath = ['provider', providerId, 'models'];
  if (modelsNode?.type !== 'object') {
    return setJsoncValue(
      raw,
      modelsPath,
      createModelRecord(modelIds, defaultModelId, selectedModelConfig)
    );
  }

  let nextRaw = raw;
  const existingModelIds = new Set(readObjectEntries(modelsNode).map(({ key }) => key));
  if (replaceExisting) {
    const selectedModelIds = new Set(modelIds);
    for (const existingModelId of existingModelIds) {
      if (!selectedModelIds.has(existingModelId)) {
        nextRaw = setJsoncValue(nextRaw, [...modelsPath, existingModelId], undefined);
      }
    }
  }
  for (const modelId of modelIds) {
    if (!existingModelIds.has(modelId)) {
      nextRaw = setJsoncValue(
        nextRaw,
        [...modelsPath, modelId],
        modelId === defaultModelId ? (selectedModelConfig ?? {}) : {}
      );
    }
  }
  for (const [key, value] of Object.entries(selectedModelConfig ?? {})) {
    nextRaw = setJsoncValue(nextRaw, [...modelsPath, defaultModelId, key], value);
  }
  return nextRaw;
}

/** Builds the OpenCode model map, enriching the selected model when metadata is known. */
export function createModelRecord(
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

/** Detects ambiguous duplicate keys anywhere in a JSONC tree. */
export function hasDuplicateObjectProperties(node: JsoncNode): boolean {
  if (node.type === 'array') {
    return node.children?.some(hasDuplicateObjectProperties) ?? false;
  }
  if (node.type !== 'object') return false;

  const propertyNames = new Set<string>();
  for (const property of node.children ?? []) {
    const propertyName = property.children?.[0]?.value;
    if (typeof propertyName === 'string') {
      if (propertyNames.has(propertyName)) return true;
      propertyNames.add(propertyName);
    }
    const propertyValue = property.children?.[1];
    if (propertyValue && hasDuplicateObjectProperties(propertyValue)) return true;
  }
  return false;
}

/** Checks whether a resolved target remains inside the resolved root path. */
export function isPathInside(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
