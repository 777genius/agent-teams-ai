import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(16 * 1024)
  .refine((value) => isAbsolute(value) && resolve(value) === value && !value.includes('\0'));
const identity = z
  .object({
    path,
    device: z.number().int().nonnegative().safe(),
    inode: z.number().int().nonnegative().safe(),
  })
  .strict();
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const branch = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/u.test(value));
export const ownedWorktreeBindingSchema = z
  .object({
    slotId: hash,
    target: identity,
    commonDirectory: identity,
    branch,
    createdCommit: commit,
  })
  .strict();
export const launchWorktreePlanSchema = z
  .object({
    version: z.literal(1),
    slotId: hash,
    repository: identity,
    commonDirectory: identity,
    targetPath: path,
    branch,
    capturedCommit: commit,
    proof: z.object({ head: commit, dirtyDigest: hash }).strict(),
    reuse: ownedWorktreeBindingSchema.optional(),
  })
  .strict();
export const launchWorktreeReceiptSchema = z
  .object({
    planDigest: hash,
    state: z.enum(['reserved', 'attempted', 'completed']),
    target: identity,
    binding: ownedWorktreeBindingSchema.optional(),
  })
  .strict();
export const capturedWorktreesSchema = z
  .array(
    z
      .object({
        memberIds: z
          .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/))
          .min(1)
          .max(256),
        plan: launchWorktreePlanSchema,
      })
      .strict()
  )
  .max(256)
  .superRefine((rows, context) => {
    const members = rows.flatMap((row) => row.memberIds);
    if (
      new Set(members).size !== members.length ||
      new Set(rows.map((row) => row.plan.slotId)).size !== rows.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate captured worktree slot or member' });
  });
