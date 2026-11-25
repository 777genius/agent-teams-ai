import { z } from 'zod';
import { runtimeDigest } from '../runtime/identity.js';

const modelId = z.string().min(1).max(2048).refine(value =>
  value.includes('/') && value.trim() === value && !/[\s\0]/u.test(value) &&
  value.split('/').every(Boolean));
const limits = z.object({
  contextTokens: z.number().int().min(1).max(100_000_000),
  outputTokens: z.number().int().min(1).max(100_000_000),
}).strict().refine(value => value.outputTokens <= value.contextTokens);

/** Safe values captured by the existing Main preference owner, never credential/file input. */
export const openCodeManagedPreferencesSchema = z.object({
  defaultModelId: modelId.nullable(),
  // Existing project/global files each admit 4096 overrides before their merge.
  modelLimitOverrides: z.record(modelId, limits).refine(value => Object.keys(value).length <= 8192),
}).strict().transform(value => ({
  defaultModelId: value.defaultModelId,
  modelLimitOverrides: Object.fromEntries(Object.keys(value.modelLimitOverrides).sort().map(key =>
    [key, value.modelLimitOverrides[key]!])),
}));
export type OpenCodeManagedPreferences = z.infer<typeof openCodeManagedPreferencesSchema>;

export function openCodeManagedPreferencesDigest(value: OpenCodeManagedPreferences): string {
  return runtimeDigest(openCodeManagedPreferencesSchema.parse(value));
}

/** Apply only the actual selected model; unrelated overrides never enter the inline native config. */
export function selectedOpenCodeManagedLimits(
  preferences: OpenCodeManagedPreferences | undefined,
  qualifiedModelId: string
) {
  return preferences && Object.hasOwn(preferences.modelLimitOverrides, qualifiedModelId)
    ? preferences.modelLimitOverrides[qualifiedModelId] : undefined;
}
