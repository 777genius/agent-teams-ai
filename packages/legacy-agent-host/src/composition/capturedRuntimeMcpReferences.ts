import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(256).refine(value => !value.includes('\0'));

/** Pure persisted reference shape; importing it does not initialize provider composition. */
export const capturedRuntimeMcpReferencesSchema = z
  .array(z.object({ memberId: id, digest: hash }).strict())
  .max(256)
  .refine((rows) => new Set(rows.map((row) => row.memberId)).size === rows.length);
export type CapturedRuntimeMcpReference = z.infer<
  typeof capturedRuntimeMcpReferencesSchema
>[number];
