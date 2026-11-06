import { z } from 'zod';

import { skillReceiptSchema, skillSelection, stagedSkillTrashSchema } from './skillRecords.js';

export { skillCommandSchema, skillReceiptSchema, skillBundleSchema } from './skillRecords.js';
export type { SkillCommand, SkillReceipt } from './skillRecords.js';
export type { SkillImportBundle, SkillReviewPreview } from './skillPolicy.js';
export const capturedSkillTargetSchema = z
  .object({
    ...skillSelection,
    rootPath: z.string().min(1).max(8192),
    projectRoot: z.string().min(1).max(8192).nullable(),
  })
  .strict();
export type CapturedSkillTarget = z.infer<typeof capturedSkillTargetSchema>;
export const capturedSkillReadSchema = capturedSkillTargetSchema.extend({
  items: z
    .array(
      z
        .object({
          folderName: z.string().min(1).max(255),
          identity: z.string().regex(/^[a-f0-9]{64}$/u),
          flags: z
            .object({ scripts: z.boolean(), references: z.boolean(), assets: z.boolean() })
            .strict(),
          rawContent: z.string(),
          skillFileName: z.enum(['SKILL.md', 'Skill.md', 'skill.md']),
          modifiedAt: z.number(),
          relatedFiles: z.array(z.string().max(8192)),
        })
        .strict()
    )
    .max(10_000),
});
export const skillMutationResultSchema = z
  .object({ receipt: skillReceiptSchema, nativeTrash: stagedSkillTrashSchema.optional() })
  .strict();
export const skillPreviewSchema = z
  .object({
    planId: z.string().regex(/^[a-f0-9]{64}$/u),
    targetSkillDir: z.string(),
    changes: z.array(
      z
        .object({
          relativePath: z.string(),
          absolutePath: z.string(),
          action: z.enum(['create', 'update', 'delete']),
          oldContent: z.string().nullable(),
          newContent: z.string().nullable(),
          isBinary: z.boolean(),
        })
        .strict()
    ),
    warnings: z.array(z.string()),
    summary: z
      .object({
        created: z.number().int().min(0),
        updated: z.number().int().min(0),
        deleted: z.number().int().min(0),
        binary: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
