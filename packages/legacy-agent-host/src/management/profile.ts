import { z } from 'zod';

import { nativeProcessProfileSchema } from '../composition/nativeProcessProfile.js';

export const openCodeManagementProfileSchema = nativeProcessProfileSchema
  .extend({
    provider: z.literal('opencode'),
    profileId: z.string().min(1).max(256),
    accountBinding: z.string().min(1).max(256),
    configRevision: z.string().min(1).max(256),
    variant: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\0\r\n]/u.test(value))
      .optional(),
    endpoint: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/)
      .refine((value) => Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535),
    timeoutMs: z.number().int().min(1).max(300_000),
    modelProbeTimeoutMs: z.number().int().min(1).max(180000).optional(),
    oauthTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(17 * 60_000)
      .optional(),
  })
  .strict();

export type OpenCodeManagementProfile = z.infer<typeof openCodeManagementProfileSchema>;

/** Private selected namespace for finite Codex metadata, independent of any Team member. */
export const codexManagementProfileSchema = nativeProcessProfileSchema
  .extend({
    provider: z.literal('codex'),
    protocolRevision: z.literal('0.162.0'),
    modelProbeTimeoutMs: z.number().int().min(1).max(180000).optional(),
    modelProvider: z.string().min(1).max(256).optional(),
    reasoningEffort: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\0\r\n]/u.test(value))
      .optional(),
    fastMode: z.boolean().optional(),
    profileId: z.string().min(1).max(256),
    accountBinding: z.string().min(1).max(256),
    configRevision: z.string().min(1).max(256),
    timeoutMs: z.number().int().min(1).max(30000),
    environment: nativeProcessProfileSchema.shape.environment.refine(
      (value) =>
        ['HOME', 'CODEX_HOME'].every(
          (key) =>
            typeof value[key] === 'string' &&
            value[key]!.startsWith('/') &&
            !value[key]!.includes('\0')
        ),
      'Captured Codex HOME and CODEX_HOME are required'
    ),
  })
  .strict();
export const claudeManagementProfileSchema = nativeProcessProfileSchema
  .extend({
    provider: z.literal('claude'),
    sdkRevision: z.literal('0.3.305'),
    modelProbeTimeoutMs: z.number().int().min(1).max(180000).optional(),
    profileId: z.string().min(1).max(256),
    accountBinding: z.string().min(1).max(256),
    configRevision: z.string().min(1).max(256),
    configNamespace: z.enum(['native-default', 'custom-directory']),
    settingSources: z
      .array(z.enum(['user', 'project', 'local']))
      .max(3)
      .optional(),
    timeoutMs: z.number().int().min(1).max(30000),
  })
  .strict()
  .refine((value) => {
    const path = (entry: unknown) =>
      typeof entry === 'string' && entry.startsWith('/') && !entry.includes('\0');
    return (
      path(value.environment.HOME) &&
      !!value.environment.PATH &&
      (value.configNamespace === 'native-default'
        ? !Object.hasOwn(value.environment, 'CLAUDE_CONFIG_DIR')
        : path(value.environment.CLAUDE_CONFIG_DIR))
    );
  }, 'Captured Claude namespace is required');

export const providerManagementProfileSchema = z.discriminatedUnion('provider', [
  openCodeManagementProfileSchema,
  codexManagementProfileSchema,
  claudeManagementProfileSchema,
]);
export type ClaudeManagementProfile = z.infer<typeof claudeManagementProfileSchema>;
export type CodexManagementProfile = z.infer<typeof codexManagementProfileSchema>;
export type ProviderManagementProfile = z.infer<typeof providerManagementProfileSchema>;
