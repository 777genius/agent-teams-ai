import { z } from 'zod';
import { teamRegistryRecordSchema } from '../team-registry/contracts.js';
import { memberSettingsSchema, savedTeamSettingsSchema } from '../team/rosterSchema.js';

export const importCategories = [
  'team',
  'tasks',
  'attachments',
  'task-attachments',
  'history',
  'evidence',
] as const;
export type ImportCategory = (typeof importCategories)[number];
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !!value.trim() && !value.includes('\0'));
const segment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const snapshotHeaderSchema = z
  .object({
    sourceOwnerId: id,
    sourceId: id,
    sourceTeamName: segment,
    sourceRevision: hash,
    /** Actual Desktop save-only metadata has no native CLI config. */
    sourceKind: z.literal('saved-draft').optional(),
    savedSettings: savedTeamSettingsSchema,
    members: z
      .array(
        z
          .object({
            memberId: segment,
            name: segment,
            role: z.enum(['lead', 'member']),
            settings: memberSettingsSchema,
          })
          .strict()
      )
      .min(1)
      .max(256),
    obligations: z
      .object({
        launch: z.literal('released'),
        bootstrap: z.literal('released'),
        lane: z.literal('released'),
        session: z.literal('released'),
        stop: z.literal('released'),
        command: z.literal('released'),
        delivery: z.literal('released'),
        custody: z.literal('released'),
        background: z.literal('released'),
      })
      .strict(),
    gaps: z
      .array(
        z
          .object({
            category: z.enum(importCategories),
            resourceId: id,
            reason: z.enum(['already-missing', 'metadata-only']),
          })
          .strict()
      )
      .max(4096),
  })
  .strict()
  .superRefine((header, context) => {
    if (Buffer.byteLength(JSON.stringify(header)) > 512 * 1024)
      context.addIssue({ code: 'custom', message: 'Source header too large' });
  });
export type SnapshotHeader = z.infer<typeof snapshotHeaderSchema>;
export interface SnapshotFile {
  category: ImportCategory;
  path: string;
  sha256: string;
  size: number;
  disposition: 'product' | 'archive' | 'excluded';
  base64?: string;
}
export interface StoppedTeamSnapshot {
  schemaVersion: 1;
  header: SnapshotHeader;
  roots: { category: ImportCategory; exists: boolean; identity: string }[];
  files: SnapshotFile[];
  blobs: {
    originalPath: string;
    category: 'attachments' | 'task-attachments';
    path: string;
  }[];
  references: {
    taskId: string;
    displayId: string;
    teamName: string;
    target: 'internal' | 'source-archive' | 'unresolved';
  }[];
  digest: string;
}
/** Private, trusted source boundary. Desktop must actually wire its existing operation fence/census. */
export interface StoppedTeamSource {
  roots: readonly { category: ImportCategory; path: string }[];
  fenced<T>(read: () => Promise<T>): Promise<T>;
  describe(): Promise<SnapshotHeader>;
}
export interface StoppedImportContext {
  sourceOwnerId: string;
  sourceId: string;
  sourceTeamName: string;
  snapshotDigest: string;
  references: (StoppedTeamSnapshot['references'][number] & { canonicalTeamName: string })[];
  gaps: SnapshotHeader['gaps'];
}

export const importRequestSchema = z
  .object({
    contextId: id,
    sourceId: id,
    snapshotDigest: hash,
    teamName: segment,
  })
  .strict();
export type StoppedTeamImportRequest = z.infer<typeof importRequestSchema>;

export const stoppedImportReceiptSchema = z
  .object({
    commandId: id,
    phase: z.enum(['held', 'published']),
    record: teamRegistryRecordSchema,
    source: z.object({ sourceId: id, snapshotDigest: hash }).strict(),
  })
  .strict();
