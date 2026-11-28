import { z } from 'zod';

import { nativeProcessProfileSchema, isNativeProfilePath } from '../composition/nativeProcessProfile.js';
import { openCodeV2EmbeddedProfileSchema } from '../composition/openCodeV2EmbeddedProfile.js';
import { isCanonicalOpenCodeV2Directory } from '../composition/openCodeV2StaticPreflight.js';
import { openCodeManagedPreferencesSchema } from '../composition/openCodeManagedPreferences.js';

export const openCodeManagementProfileSchema = nativeProcessProfileSchema
  .extend({
    cwd: z.string().min(1).max(8192),
    executable: nativeProcessProfileSchema.shape.executable.extend({
      path: z.string().min(1).max(8192),
    }),
    provider: z.literal('opencode'),
    profileId: z.string().min(1).max(256),
    accountBinding: z.string().min(1).max(256),
    configRevision: z.string().min(1).max(256),
    nativeGeneration: z.enum(['v1', 'v2']).optional(),
    protocolRevision: z.literal('2.1.4').optional(),
    embedded: openCodeV2EmbeddedProfileSchema.optional(),
    managedPreferences: openCodeManagedPreferencesSchema.optional(),
    nativeModel: z.object({
      providerId: z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value)),
      modelId: z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value)),
    }).strict().optional(),
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
  .strict()
  .superRefine((value, context) => {
    const paired = value.protocolRevision === '2.1.4' && value.embedded !== undefined &&
      value.nativeModel !== undefined;
    if (value.nativeGeneration === 'v2' ? !paired :
      value.protocolRevision !== undefined || value.embedded !== undefined || value.nativeModel !== undefined)
      context.addIssue({ code: 'custom', message: 'OpenCode V2 management requires the captured embedded model selection' });
    if (value.nativeGeneration === 'v2' && value.embedded) {
      const platform = `${value.embedded.platform}-${value.embedded.arch}`;
      if (![value.cwd, value.executable.path, ...['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
        .map(key => value.environment[key])].every(directory =>
          typeof directory === 'string' && isCanonicalOpenCodeV2Directory(platform, directory)))
        context.addIssue({ code: 'custom', message: 'OpenCode V2 management requires canonical native paths' });
    } else if (!nativeProcessProfileSchema.safeParse(value).success) {
      context.addIssue({ code: 'custom', message: 'Legacy OpenCode management requires its captured native profile' });
    }
  });

export type OpenCodeManagementProfile = z.infer<typeof openCodeManagementProfileSchema>;

/** Private selected namespace for finite Codex metadata, independent of any Team member. */
export const codexManagementProfileSchema = nativeProcessProfileSchema
  .extend({
    provider: z.literal('codex'),
    protocolRevision: z.enum(['0.162.0', '0.169.0']),
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
            isNativeProfilePath(value[key]!)
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
      typeof entry === 'string' && isNativeProfilePath(entry);
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
