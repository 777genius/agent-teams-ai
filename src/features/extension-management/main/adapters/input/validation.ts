import { z } from 'zod';

export const selectionSchema = z
  .object({
    client: z.enum(['claude', 'codex', 'opencode']),
    scope: z.enum(['user', 'project']),
    projectId: z.string().min(1).max(4096).optional(),
    authoringProject: z.string().min(1).max(4096).optional(),
    authoringRootId: z.string().min(1).max(256).optional(),
  })
  .strict();
const identity = z.string().min(1).max(256);
export const contextSchema = z.object({ contextId: identity }).strict();
export const catalogSchema = contextSchema.extend({ query: z.string().max(500).optional() });
export const detailSchema = contextSchema.extend({ id: identity });
export const discardPlanSchema = contextSchema.extend({ planId: identity });
export const applySchema = contextSchema.extend({
  planId: identity,
  requestId: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export const operationSchema = contextSchema.extend({ operationId: identity });
export const localSkillStatusSchema = contextSchema.extend({
  skillPath: z.string().min(1).max(4096),
});
export const skillCopySourcesSchema = contextSchema.extend({ alias: identity, targetId: identity });
export const previewSkillCopySchema = skillCopySourcesSchema.extend({
  candidateId: identity,
  rootKind: z.enum(['claude', 'cursor', 'agents', 'codex']),
  folderName: identity,
});
export const localSkillSchema = contextSchema.extend({
  change: z
    .object({
      action: z.enum(['upsert', 'delete', 'restore']),
      rootId: identity,
      skillName: z.string().min(1).max(256),
      files: z
        .array(
          z
            .object({
              relativePath: z.string().min(1).max(4096),
              expectedSHA256: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .nullable(),
              contentBase64: z
                .string()
                .max(14 * 1024 * 1024)
                .nullable(),
            })
            .strict()
        )
        .max(200)
        .refine(
          (files) =>
            files.reduce((total, file) => total + (file.contentBase64?.length ?? 0), 0) <=
            14 * 1024 * 1024,
          'The combined local Skill contents exceed the 10 MiB decoded limit.'
        )
        .optional(),
      restoreOperationId: identity.optional(),
    })
    .strict(),
});
const httpsSource = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
    );
  }, 'Use an HTTP(S) source URL without credentials.');
export const skillSourceSchema = z
  .object({
    source: httpsSource,
    ref: z.string().max(256).optional(),
    path: z.string().max(4096).optional(),
  })
  .strict();
export const discoverSchema = contextSchema.extend({ source: skillSourceSchema });
export const changeSchema = z
  .object({
    action: z.enum(['install', 'install_skills', 'update', 'sync', 'repair', 'remove', 'recover']),
    source: httpsSource.optional(),
    ref: z.string().max(256).optional(),
    alias: identity.optional(),
    aliases: z.array(identity).max(256).optional(),
    all: z.boolean().optional(),
    targetIds: z.array(identity).max(32).optional(),
    catalogId: identity.optional(),
    candidateIds: z.array(identity).max(256).optional(),
    operationId: identity.optional(),
  })
  .strict();
export const prepareSchema = contextSchema.extend({
  change: changeSchema,
  catalogEntryId: identity.optional(),
});

export const previewSkillSchema = contextSchema.extend({
  catalogId: identity,
  candidateId: identity,
});
