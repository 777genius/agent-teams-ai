import { z } from 'zod';

import { OpenCodeConfigurationError } from '../adapters/providers/OpenCodeConfigurationSource.js';
import { openCodeConfiguredModelSchema } from './openCodeConfigurationReference.js';

import type { OpenCodeConfiguredModel } from './openCodeConfigurationReference.js';

type Json = z.infer<ReturnType<typeof z.json>>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(): never {
  throw new OpenCodeConfigurationError('configuration-invalid');
}
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  );
const json = z.record(z.string(), z.json());
const settings = z
  .object({
    compaction: z
      .object({ type: z.enum(['summary', 'native']) })
      .strict()
      .optional(),
    encoding: z.enum(['zstd', 'gzip', 'none']).optional(),
  })
  .catchall(z.json());
const overlays = {
  settings: settings.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: json.optional(),
};
const compatibility = z
  .object({
    reasoningField: z.string().optional(),
    requireReasoning: z.boolean().optional(),
    maxTokensField: z.enum(['max_completion_tokens', 'max_tokens']).optional(),
    requireFinishReason: z.boolean().optional(),
    requireAssistantAfterTool: z.boolean().optional(),
    supportsPromptCacheKey: z.boolean().optional(),
    streamUsage: z.boolean().optional(),
    cacheFormat: z.enum(['anthropic', 'alibaba']).optional(),
    supportsThinkingBlockBinding: z.boolean().optional(),
    supportsEffortUpdates: z.boolean().optional(),
  })
  .strict();
const reasoning = z.union([
  z.object({ supported: z.literal(false) }).strict(),
  z
    .object({
      supported: z.literal(true),
      toggle: z.boolean().optional(),
      effort: z.array(z.string()).optional(),
      budget: z
        .object({
          min: z.number().int().optional(),
          max: z.number().int().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
const capabilities = z
  .object({
    // Preserve the donor's explicit complete-capability contract, including legacy alias defaults.
    tools: z.boolean(),
    input: z.array(z.string()),
    output: z.array(z.string()),
    temperature: z.boolean().optional(),
    reasoning: reasoning.optional(),
  })
  .strict();
const cost = z
  .object({
    tier: z
      .object({ type: z.literal('context'), size: z.number().int() })
      .strict()
      .optional(),
    input: z.number(),
    output: z.number(),
    cache: z
      .object({
        read: z.number().optional(),
        write: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
// Exact native 2.1.4 Config.Provider.Model fields; no old 2.0.32 schema or ambient module import.
const model = z
  .object({
    modelID: id.optional(),
    family: z.string().optional(),
    name: z.string().optional(),
    releaseDate: z
      .string()
      .regex(/^\d{4}-\d{2}(-\d{2})?$/u)
      .optional(),
    compatibility: compatibility.optional(),
    package: z.string().min(1).optional(),
    ...overlays,
    capabilities: capabilities.optional(),
    variants: z
      .array(z.object({ id, ...overlays }).strict())
      .max(256)
      .refine((values) => new Set(values.map((value) => value.id)).size === values.length)
      .optional(),
    cost: z.union([cost, z.array(cost)]).optional(),
    disabled: z.boolean().optional(),
    limit: z
      .object({
        context: z.number().int().optional(),
        input: z.number().int().optional(),
        output: z.number().int().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function nativePackage(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) invalid();
  return value.startsWith('aisdk:') ? value : `aisdk:${value}`;
}

/** The source's default stays structured after this one native-reference decoding boundary. */
export function readOpenCodeConfiguredModel(
  config: RecordValue
): OpenCodeConfiguredModel | undefined {
  if (config.model === undefined) return undefined;
  if (typeof config.model !== 'string') invalid();
  const separator = config.model.indexOf('/'),
    variant = config.model.indexOf('#', separator + 1);
  const decoded = openCodeConfiguredModelSchema.safeParse({
    providerId: config.model.slice(0, separator),
    modelId: config.model.slice(separator + 1, variant < 0 ? undefined : variant),
    ...(variant < 0 ? {} : { variant: config.model.slice(variant + 1) }),
  });
  if (separator < 1 || !decoded.success) invalid();
  return decoded.data;
}

/** Only the selected declared model is translated, preserving strict alias and variant semantics. */
export function mapOpenCodeV2SelectedModel(modelId: string, raw: unknown): Record<string, Json> {
  if (!id.safeParse(modelId).success || !record(raw)) invalid();
  const native = { ...raw };
  for (const [legacyKey, nativeKey] of [
    ['id', 'modelID'],
    ['npm', 'package'],
  ] as const) {
    if (raw[legacyKey] === undefined) continue;
    const value = legacyKey === 'npm' ? nativePackage(raw[legacyKey]) : raw[legacyKey];
    if (raw[nativeKey] !== undefined && raw[nativeKey] !== value) invalid();
    native[nativeKey] = value;
    delete native[legacyKey];
  }
  if (raw.tool_call !== undefined || raw.modalities !== undefined) {
    if (raw.tool_call !== undefined && typeof raw.tool_call !== 'boolean') invalid();
    if (raw.capabilities !== undefined && !record(raw.capabilities)) invalid();
    const explicit = record(raw.capabilities) ? raw.capabilities : {};
    const selected = { tools: true, input: ['text', 'image'], output: ['text'], ...explicit };
    if (raw.tool_call !== undefined) {
      if (Object.hasOwn(explicit, 'tools') && explicit.tools !== raw.tool_call) invalid();
      selected.tools = raw.tool_call as boolean;
    }
    if (raw.modalities !== undefined) {
      const modalities = z
        .object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() })
        .strict()
        .safeParse(raw.modalities);
      if (!modalities.success) invalid();
      Object.assign(selected, modalities.data);
    }
    native.capabilities = selected;
    delete native.tool_call;
    delete native.modalities;
  }
  if (raw.variants !== undefined && !Array.isArray(raw.variants)) {
    if (!record(raw.variants)) invalid();
    native.variants = Object.entries(raw.variants).map(([variant, value]) => {
      if (!record(value) || Object.hasOwn(value, 'disabled')) invalid();
      return { id: variant, settings: value };
    });
  }
  const decoded = model.safeParse(native);
  if (!decoded.success) invalid();
  return { [modelId]: JSON.parse(JSON.stringify(decoded.data)) as Json };
}

/** Resolve only selected values against the original profile environment, never process.env. */
function environmentValues(value: unknown, environment: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') {
    if (value.includes('{file:')) invalid(); // Only separately qualified app-owned credential files may be materialized.
    return value.replace(
      /\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
      (_match: string, braced: string | undefined, shell: string | undefined) => {
        const selected = environment[braced ?? shell!];
        if (selected === undefined || selected.includes('\0')) invalid();
        return selected;
      }
    );
  }
  if (Array.isArray(value)) return value.map((item) => environmentValues(item, environment));
  if (record(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, environmentValues(item, environment)])
    );
  return value;
}

/** Private output: the caller binds any explicit key through the existing P02 owner, never a receipt. */
export function selectOpenCodeV2ProviderConfiguration(
  config: RecordValue,
  selection: { providerId: string; modelId: string },
  environment: Readonly<Record<string, string>>
): { configuration?: Record<string, Json>; apiKey?: string } {
  if (!id.safeParse(selection.providerId).success || !id.safeParse(selection.modelId).success)
    invalid();
  if (config.provider === undefined) return {};
  if (!record(config.provider)) invalid();
  const raw = config.provider[selection.providerId];
  if (raw === undefined) return {};
  if (!record(raw)) invalid();
  if (raw.models !== undefined && !record(raw.models)) invalid();
  const selectedModel = record(raw.models) ? raw.models[selection.modelId] : undefined;
  const provider = environmentValues(
    {
      ...(raw.npm === undefined ? {} : { npm: raw.npm }),
      ...(raw.options === undefined ? {} : { options: raw.options }),
      ...(selectedModel === undefined ? {} : { models: { [selection.modelId]: selectedModel } }),
    },
    environment
  );
  if (!record(provider)) invalid();
  const options = provider.options === undefined ? {} : provider.options;
  if (!record(options) || Object.keys(options).some((key) => !['baseURL', 'apiKey'].includes(key)))
    invalid();
  if (options.baseURL !== undefined && typeof options.baseURL !== 'string') invalid();
  if (
    options.apiKey !== undefined &&
    (typeof options.apiKey !== 'string' ||
      !options.apiKey ||
      options.apiKey.length > 64 * 1024 ||
      [...options.apiKey].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ))
  )
    invalid();
  if (provider.models !== undefined && !record(provider.models)) invalid();
  const declared = record(provider.models) ? provider.models[selection.modelId] : undefined;
  const configuration: Record<string, Json> = {
    ...(provider.npm === undefined ? {} : { package: nativePackage(provider.npm) }),
    ...(options.baseURL === undefined ? {} : { settings: { baseURL: options.baseURL as string } }),
    ...(declared === undefined
      ? {}
      : { models: mapOpenCodeV2SelectedModel(selection.modelId, declared) }),
  };
  if (Buffer.byteLength(JSON.stringify(configuration)) > 256 * 1024) invalid();
  return {
    ...(Object.keys(configuration).length ? { configuration } : {}),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey as string }),
  };
}
