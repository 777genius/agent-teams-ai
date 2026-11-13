import { captureCodexConfiguredMcpCatalog } from '@agent-teams/provider-implementations/codex';
import type { CodexConfiguredMcpCatalog } from '@agent-teams/provider-implementations/codex';
import { capturedMcpSourceSchema } from '../mcp-catalog/capturedSource.js';
import { z } from 'zod';

import { nativeProcessProfileSchema, nativeProfilePathSchema } from './nativeProcessProfile.js';
import { hasUntrustedOpenCodeBinaryOverride } from './openCodeV2Environment.js';
import { isCanonicalOpenCodeV2Directory } from './openCodeV2StaticPreflight.js';
import { openCodeV2EmbeddedProfileSchema } from './openCodeV2EmbeddedProfile.js';
import { capturedMcpServersSchema } from '../mcp-catalog/capturedServer.js';
import { openCodeManagedPreferencesSchema } from './openCodeManagedPreferences.js';

const id = z.string().min(1).max(256);
const path = nativeProfilePathSchema;
const boundedStrings = z.array(z.string().min(1).max(256)).max(256);

const common = nativeProcessProfileSchema.extend({
  /** Private ordered native argv, captured before launch; never accepted from Runtime RPC. */
  extraArgs: z
    .array(z.string().max(64 * 1024))
    .max(1024)
    .optional(),
  /** Trusted source namespace only; product choices never supply this path. */
  mcpCatalogSource: z.object({ claudeConfigPath: path }).strict().optional(),
  /** Private snapshot selected before the capture digest. */
  capturedMcpServers: capturedMcpServersSchema.optional(),
  capturedMcpSource: capturedMcpSourceSchema.optional(),
  teamId: id,
  memberId: id,
  principalId: id,
  sessionId: id,
  generation: z.number().int().min(0),
  configRevision: id,
  model: id,
  accountBinding: id,
  limits: z
    .object({
      queuedInputs: z.number().int().min(1).max(1024),
      inputBytes: z
        .number()
        .int()
        .min(1)
        .max(8 * 1024 * 1024),
      outputBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1024 * 1024),
      outputEvents: z.number().int().min(1).max(100_000),
      pendingInteractions: z.number().int().min(1).max(1024),
      timeoutMs: z.number().int().min(1).max(300_000),
    })
    .strict(),
  mcpLifetimeMs: z
    .number()
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000)
    .optional(),
});

const claude = common
  .extend({
    provider: z.literal('claude'),
    configNamespace: z.enum(['native-default', 'custom-directory']).optional(),
    nativeTools: boundedStrings,
    autoAllowedTools: boundedStrings,
    nativeOptions: z
      .object({
        permissionMode: z
          .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
          .optional(),
        allowDangerouslySkipPermissions: z.boolean().optional(),
        settingSources: z
          .array(z.enum(['user', 'project', 'local']))
          .max(3)
          .optional(),
        projectInstructions: z
          .object({
            append: z
              .string()
              .max(64 * 1024)
              .optional(),
          })
          .strict()
          .optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
        fastMode: z.boolean().optional(),
        context: z.enum(['model-default', 'one-million']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const codex = common
  .extend({
    provider: z.literal('codex'),
    capturedMcpCatalog: z
      .custom<CodexConfiguredMcpCatalog>((value) => {
        try {
          captureCodexConfiguredMcpCatalog(value);
          return true;
        } catch {
          return false;
        }
      })
      .transform((value) => captureCodexConfiguredMcpCatalog(value))
      .optional(),
    protocolRevision: z.enum(['0.162.0', '0.169.0']),
    // D passes this budget into pinned CodexAppServerClient.maxTextBytes (1 MiB ceiling).
    limits: common.shape.limits
      .extend({ outputBytes: z.number().int().min(1).max(1_048_576) })
      .strict(),
    environment: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(64 * 1024))
      .refine(
        (value) => path.safeParse(value.HOME).success && path.safeParse(value.CODEX_HOME).success,
        'Captured Codex HOME and CODEX_HOME are required'
      ),
    nativeOptions: z
      .object({
        approvalPolicy: z.enum(['never', 'on-request', 'on-failure', 'untrusted']),
        sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
        modelProvider: id.optional(),
        reasoningEffort: id.optional(),
        fastMode: z.boolean().optional(),
        developerInstructions: z
          .string()
          .max(64 * 1024)
          .optional(),
      })
      .strict(),
  })
  .strict();

// V2 additionally validates its captured engine selection. Every native path
// stays in the current Host OS; Windows legacy launches require the private broker.
const opencode = common
  .extend({
    cwd: z.string().min(1).max(8192),
    executable: common.shape.executable.extend({
      path: z.string().min(1).max(8192),
    }),
    provider: z.literal('opencode'),
    // Explicit trusted generation; absent remains the historical V1 profile.
    // V2 uses its own adapter, protocol and permission model.
    protocolRevision: z.enum(['1.18.35', '1.19.4', '2.0.0', '2.0.21', '2.1.4']),
    nativeGeneration: z.literal('v2').optional(),
    embedded: openCodeV2EmbeddedProfileSchema.optional(),
    managedPreferences: openCodeManagedPreferencesSchema.optional(),
    mcpPolicyPlugin: z
      .object({ path, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
    endpoint: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/)
      .refine((value) => Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535),
    nativeSessionId: z
      .string()
      .regex(/^ses_[A-Za-z0-9]+$/)
      .optional(),
    limits: common.shape.limits
      .extend({
        inputBytes: z
          .number()
          .int()
          .min(1)
          .max(256 * 1024),
      })
      .strict(),
    // Validate HOME/XDG together with nativeGeneration below. Windows cannot use
    // a fake /cwd alias for either generation.
    environment: common.shape.environment,
    nativeOptions: z
      .object({
        providerId: id,
        agent: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
        variant: id.optional(),
        toolApprovalMode: z.enum(['manual', 'auto']).optional(),
        instructions: z
          .string()
          .max(64 * 1024)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const nativePath = value.nativeGeneration === 'v2'
      ? (candidate: string) =>
          isCanonicalOpenCodeV2Directory(`${process.platform}-${process.arch}`, candidate)
      : (candidate: string) => path.safeParse(candidate).success;
    const requiredPaths = [
      value.cwd, value.executable.path,
      ...['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
        .map((key) => value.environment[key]),
    ];
    if (!requiredPaths.every((candidate) =>
        typeof candidate === 'string' && nativePath(candidate))) {
      ctx.addIssue({ code: 'custom',
        message: 'OpenCode native paths must match captured generation and operating system' });
    }
  });

/** Captured host configuration only. These fields never come from a runtime RPC. */
export const runtimeMemberProfileSchema = z.discriminatedUnion('provider', [
  claude,
  codex,
  opencode,
]);

export const runtimeProfileSchema = z
  .object({
    members: z.array(runtimeMemberProfileSchema).max(256),
    /** Explicit trusted defaults for fresh members/provider changes, never inferred from members. */
    providerTemplates: z.array(runtimeMemberProfileSchema).max(3).optional(),
  })
  .strict()
  .refine((value) => value.members.length + (value.providerTemplates?.length ?? 0) > 0)
  .refine(
    (value) =>
      new Set(value.providerTemplates?.map((row) => row.provider)).size ===
      (value.providerTemplates?.length ?? 0),
    'Provider templates must be unique by provider'
  )
  .refine(
    (value) => [...value.members, ...(value.providerTemplates ?? [])].every((member) =>
      member.provider !== 'opencode' ||
      (member.nativeGeneration === 'v2'
        ? ((member.protocolRevision === '2.1.4' && member.embedded !== undefined) ||
          ((member.protocolRevision === '2.0.0' || member.protocolRevision === '2.0.21') &&
           member.embedded === undefined && !!member.nativeSessionId)) &&
          !hasUntrustedOpenCodeBinaryOverride(member.environment) &&
          member.mcpPolicyPlugin === undefined &&
          (member.embedded !== undefined || (member.capturedMcpServers === undefined &&
            member.capturedMcpSource === undefined && member.mcpCatalogSource === undefined)) &&
          (member.embedded !== undefined || member.nativeOptions.toolApprovalMode === undefined) &&
          (member.extraArgs?.length ?? 0) === 0
        : member.embedded === undefined &&
          (member.protocolRevision === '1.18.35' || member.protocolRevision === '1.19.4'))
    ),
    'OpenCode V2 requires a distinct captured native generation; V1 plugin/permission/extra args cannot be reused'
  );

export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
export type RuntimeMemberProfile = z.infer<typeof runtimeMemberProfileSchema>;
export type ClaudeMemberProfile = Extract<RuntimeMemberProfile, { provider: 'claude' }>;
export type CodexMemberProfile = Extract<RuntimeMemberProfile, { provider: 'codex' }>;

export type OpenCodeMemberProfile = Extract<RuntimeMemberProfile, { provider: 'opencode' }>;
