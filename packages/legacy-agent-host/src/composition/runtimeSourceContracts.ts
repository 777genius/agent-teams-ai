import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { openCodeV2EmbeddedProfileSchema } from './openCodeV2EmbeddedProfile.js';
import { openCodeConfigurationReferenceSchema, openCodeConfiguredModelSchema } from './openCodeConfigurationReference.js';
import { openCodeManagedPreferencesSchema } from './openCodeManagedPreferences.js';
export { openCodeManagedPreferencesSchema, openCodeManagedPreferencesDigest } from './openCodeManagedPreferences.js';
export type { OpenCodeManagedPreferences } from './openCodeManagedPreferences.js';
import { runtimeSourceRefusalSchema } from '../management/runtimeSourceVerification.js';
export { runtimeSourceRefusalSchema };
export type { RuntimeSourceRefusal } from '../management/runtimeSourceVerification.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { RuntimeSourceProcessOrigin } from './runtimeSourceProcessOrigin.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !value.includes('\0') && isAbsolute(value) && resolve(value) === value);
const executable = z.object({ path, sha256: hash }).strict();
const nativeVersion = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const nativeCli = z
  .object({
    executable,
    version: nativeVersion,
    generation: z.enum(['v1', 'v2']).optional(),
  })
  .strict();
const teamScope = z.object({ teamId: id, projectId: id, workspaceId: id }).strict();
export type RuntimeSourceTeamScope = z.infer<typeof teamScope>;
const embeddedDelivery = z
  .object({
    version: openCodeV2EmbeddedProfileSchema.shape.version,
    directory: path,
    manifestSha256: hash,
    platform: openCodeV2EmbeddedProfileSchema.shape.platform,
    arch: openCodeV2EmbeddedProfileSchema.shape.arch,
  })
  .strict();

/** Main derives this from one original private descriptor entry, never a renderer payload. */
export const runtimeSourceGrantSchema = z
  .object({
    targetId: hash,
    ownerId: id,
    ownerRevision: id,
    contextId: id,
    projectPath: path.nullable(),
    runtimeId: z.enum(['claude', 'codex', 'opencode']),
    profileId: id,
    configRevision: id,
    teamScopes: z.array(teamScope).max(256),
  })
  .strict();
export type RuntimeSourceGrant = z.infer<typeof runtimeSourceGrantSchema>;

/** A source reference only: accounts, credentials, environment and native session IDs stay in the seed. */
export const runtimeSourceCandidateSchema = z
  .object({
    sourceKind: z.enum(['captured', 'bundled', 'app-managed', 'path', 'override']),
    executable,
    embedded: embeddedDelivery.optional(),
    /** The CLI selecting the runtime generation; for embedded V2 it is not the Bun executor. */
    nativeCli: nativeCli.optional(),
    openCodeConfiguration: openCodeConfigurationReferenceSchema.optional(),
    openCodeDefault: openCodeConfiguredModelSchema.optional(),
    openCodePreferences: openCodeManagedPreferencesSchema.optional(),
  })
  .strict();
export type RuntimeSourceCandidate = z.infer<typeof runtimeSourceCandidateSchema>;
/** Installer selection without access to the Host's private execution paths. */
export const runtimeSourceNativeSelectionSchema = z
  .object({
    sourceKind: z.enum(['bundled', 'app-managed', 'path', 'override']),
    nativeCli,
    embedded: embeddedDelivery.optional(),
  })
  .strict();
export type RuntimeSourceNativeSelection = z.infer<typeof runtimeSourceNativeSelectionSchema>;
export type RuntimeSourcePublishIntent = { commandId: string; expectedRevision: string } & (
  | { candidate: RuntimeSourceCandidate; nativeSelection?: never }
  | { nativeSelection: RuntimeSourceNativeSelection; candidate?: never }
);

export const runtimeSourceReferenceSchema = z.object({ sourceId: hash, revision: hash }).strict();
export type RuntimeSourceReference = z.infer<typeof runtimeSourceReferenceSchema>;
export const runtimeSourceSummarySchema = z
  .object({
    ...runtimeSourceReferenceSchema.shape,
    profileId: id,
    configRevision: id,
    sourceKind: z.enum(['captured', 'bundled', 'app-managed', 'path', 'override']),
    nativeGeneration: z.enum(['v1', 'v2']).optional(),
    cliVersion: id.optional(),
    engineVersion: id.optional(),
    /** Read-only freshness check; no source paths, contents or credentials leave the Host. */
    configurationCurrent: z.boolean().optional(),
    /** Safe preference values remain private to the captured recipe. */
    preferencesDigest: hash.optional(),
  })
  .strict();
export type RuntimeSourceSummary = z.infer<typeof runtimeSourceSummarySchema>;
export const runtimeSourcePublicationSchema = z
  .object({
    commandId: id,
    phase: z.enum(['prepared', 'verifying', 'verified', 'held', 'published']),
    selection: runtimeSourceSummarySchema.optional(),
    reason: runtimeSourceRefusalSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.phase === 'published') === (value.selection !== undefined) &&
      (value.reason === undefined || value.phase === 'held')
  );
export type RuntimeSourcePublication = z.infer<typeof runtimeSourcePublicationSchema>;

export const publishRuntimeSourceSchema = z
  .object({
    grant: runtimeSourceGrantSchema,
    commandId: id,
    expectedRevision: hash,
    candidate: runtimeSourceCandidateSchema,
    intent: z.literal('configuration').optional(),
  })
  .strict();
export type PublishRuntimeSource = z.infer<typeof publishRuntimeSourceSchema>;
export const refreshRuntimeConfigurationSchema = z.object({
  grant: runtimeSourceGrantSchema, commandId: id, expectedRevision: hash,
  openCodePreferences: openCodeManagedPreferencesSchema.optional(),
}).strict();
export type RuntimeConfigurationRefreshIntent = Omit<
  z.infer<typeof refreshRuntimeConfigurationSchema>, 'grant'>;
export const publishRuntimeSourceRequestSchema = z.union([
  publishRuntimeSourceSchema,
  z
    .object({
      grant: runtimeSourceGrantSchema,
      commandId: id,
      expectedRevision: hash,
      nativeSelection: runtimeSourceNativeSelectionSchema,
    })
    .strict(),
]);
export const runtimeSourceReadSchema = z.object({ grant: runtimeSourceGrantSchema }).strict();
export const runtimeSourceLookupSchema = z
  .object({
    grant: runtimeSourceGrantSchema,
    commandId: id,
  })
  .strict();

/** Selection is captured before asynchronous launch preparation; replay resolves only this reference. */
export interface RuntimeRecipeSources {
  /** Optional private process witness; no returned recipe or persisted capture contains it. */
  processOrigin?(reference: RuntimeSourceReference, scope: RuntimeSourceTeamScope,
    projectPath: string, recipe: RuntimeMemberProfile): RuntimeSourceProcessOrigin | undefined;
  /** Restore may establish original-reference eligibility before resolving any current template. */
  assertReferenceAvailable?(reference: RuntimeSourceReference, scope: RuntimeSourceTeamScope, projectPath: string): void;
  currentForRecipe(
    scope: RuntimeSourceTeamScope,
    projectPath: string,
    recipe: RuntimeMemberProfile
  ): RuntimeSourceReference | undefined;
  resolveRecipe(
    reference: RuntimeSourceReference,
    scope: RuntimeSourceTeamScope,
    projectPath: string,
    recipe: RuntimeMemberProfile
  ): RuntimeMemberProfile;
}
