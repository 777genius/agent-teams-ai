import { z } from 'zod';
import { attachmentMetadataSchema, ATTACHMENT_CHUNK_BYTES } from './contracts.js';
import {
  MAX_ATTACHMENT_SIZE,
  MAX_TASK_ATTACHMENT_SIZE,
  MAX_TOTAL_ATTACHMENT_SIZE,
  MAX_TASK_ATTACHMENT_BYTES_TOTAL,
  MAX_AGENT_IPC_ATTACHMENTS,
} from './portable.js';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const attachmentReferenceSchema = z
  .object({
    artifactId: id,
    mimeType: z.string().min(1).max(256),
    byteLength: z.number().int().positive().max(MAX_TASK_ATTACHMENT_SIZE),
    digest: hash,
  })
  .strict();
export type AttachmentReference = z.infer<typeof attachmentReferenceSchema>;
export const attachmentReferencesSchema = z
  .array(attachmentReferenceSchema)
  .max(MAX_AGENT_IPC_ATTACHMENTS)
  .superRefine((refs, ctx) => {
    if (
      new Set(refs.map((ref) => ref.artifactId)).size !== refs.length ||
      refs.reduce((sum, ref) => sum + ref.byteLength, 0) > MAX_TASK_ATTACHMENT_BYTES_TOTAL
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid attachment batch' });
  });
export const messageAttachmentReferencesSchema = attachmentReferencesSchema.refine(
  (refs) => refs.reduce((sum, ref) => sum + ref.byteLength, 0) <= MAX_TOTAL_ATTACHMENT_SIZE,
  'Message attachment batch exceeds limit'
);
export const attachmentUploadSchema = z
  .object({
    uploadId: id,
    purpose: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('task'), taskId: id }).strict(),
      z.object({ kind: z.literal('message'), member: id }).strict(),
    ]),
    attachment: attachmentMetadataSchema
      .omit({ addedAt: true })
      .extend({ size: z.number().int().positive().max(MAX_TASK_ATTACHMENT_SIZE) }),
    digest: hash,
    offset: z.number().int().min(0).max(MAX_TASK_ATTACHMENT_SIZE),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.purpose.kind === 'message' && input.attachment.size > MAX_ATTACHMENT_SIZE)
      context.addIssue({ code: 'custom', message: 'Message attachment exceeds limit' });
  });
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;
export interface AttachmentUploadResult {
  nextOffset: number | null;
  reference?: AttachmentReference;
}
