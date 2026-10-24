import { z } from 'zod';

import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_BYTES } from './portable.js';
export { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_BYTES };
const segment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const taskAttachmentReadSchema = z
  .object({
    taskId: segment,
    attachmentId: segment,
    offset: z.number().int().min(0).max(ATTACHMENT_MAX_BYTES),
    expectedSha256: hash.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.offset > 0 && !input.expectedSha256)
      context.addIssue({ code: 'custom', message: 'Original attachment digest required' });
  });
export type TaskAttachmentRead = z.infer<typeof taskAttachmentReadSchema>;
export const attachmentMetadataSchema = z
  .object({
    id: segment,
    filename: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !/[\0\r\n]/.test(value)),
    mimeType: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\0\r\n]/.test(value)),
    size: z.number().int().min(0).max(ATTACHMENT_MAX_BYTES),
    addedAt: z.string().min(1).max(128).optional(),
  })
  .strict();
export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;
export type AttachmentReadResult = null | {
  attachment: AttachmentMetadata;
  sha256: string;
  offset: number;
  base64: string;
  nextOffset: number | null;
};

export const messageReferenceSchema = z
  .string()
  .regex(/^(?:im1:[A-Za-z0-9][A-Za-z0-9_-]{0,127}:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
export const messageAttachmentsReadSchema = z
  .object({ reference: messageReferenceSchema })
  .strict();
export const messageAttachmentReadSchema = z
  .object({
    reference: messageReferenceSchema,
    attachmentId: segment,
    offset: z.number().int().min(0).max(ATTACHMENT_MAX_BYTES),
    expectedSha256: hash.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.offset > 0 && !input.expectedSha256)
      context.addIssue({ code: 'custom', message: 'Original attachment digest required' });
  });
export type ImportedAttachmentResult = AttachmentReadResult | AttachmentMetadata[];
