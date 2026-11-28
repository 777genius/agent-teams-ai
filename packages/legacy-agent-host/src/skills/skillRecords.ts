import { z } from 'zod';

import { managementCommandIdentityShape } from '../management/commandIdentity.js';

const id = z.string().min(1).max(256),
  hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const skillSelection = {
  profileId: id,
  configRevision: id,
  targetId: hash,
  scope: z.enum(['user', 'project']),
  rootKind: z.enum(['claude', 'codex', 'agents', 'cursor']),
};
const file = z
  .object({
    relativePath: z.string().min(1).max(8192),
    base64: z.string().max(14 * 1024 * 1024),
    isBinary: z.boolean(),
  })
  .strict();
export const skillBundleSchema = z
  .object({
    binding: hash,
    digest: hash,
    files: z.array(file).max(200),
    hiddenEntriesSkipped: z.number().int().min(0).max(20_000),
  })
  .strict();
const folderName = z.string().min(1).max(255);
export const skillCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('upsert'),
      folderName,
      files: z
        .array(
          z
            .object({
              relativePath: z.string().min(1).max(8192),
              content: z.string().max(10 * 1024 * 1024),
            })
            .strict()
        )
        .min(1)
        .max(200),
    })
    .strict(),
  z.object({ action: z.literal('import'), folderName, bundle: skillBundleSchema }).strict(),
  z.object({ action: z.literal('trash'), folderName, expectedIdentity: hash }).strict(),
]);
export type SkillCommand = z.infer<typeof skillCommandSchema>;
export const skillMutationSchema = z
  .object({
    ...skillSelection,
    commandId: id,
    reviewPlanId: hash.optional(),
    command: skillCommandSchema,
  })
  .strict();
export const stagedSkillTrashSchema = z
  .object({
    path: z.string().min(1).max(8192),
    dev: z.number().int().min(0),
    ino: z.number().int().min(0),
    parentDev: z.number().int().min(0),
    parentIno: z.number().int().min(0),
    token: hash,
  })
  .strict();
export const storedSkillCommandSchema = z
  .object({
    ...managementCommandIdentityShape,
    kind: z.literal('skill.mutation'),
    targetId: hash,
    intentDigest: hash,
    action: z.enum(['upsert', 'import', 'trash']),
    scope: z.enum(['user', 'project']),
    rootKind: z.enum(['claude', 'codex', 'agents', 'cursor']),
    phase: z.enum(['claimed', 'completed', 'held']),
    trash: stagedSkillTrashSchema.optional(),
  })
  .strict()
  .refine(
    (row) =>
      (row.phase !== 'completed' || !row.resourceHeld) &&
      (row.phase !== 'claimed' || row.resourceHeld) &&
      (!row.trash || row.action === 'trash')
  );
export type StoredSkillCommand = z.infer<typeof storedSkillCommandSchema>;
export const skillReceiptSchema = z
  .object({
    commandId: id,
    ...skillSelection,
    action: z.enum(['upsert', 'import', 'trash']),
    phase: z.enum(['completed', 'held']),
  })
  .strict();
export type SkillReceipt = z.infer<typeof skillReceiptSchema>;
