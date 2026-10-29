import { z } from 'zod';
import { messageAttachmentReferencesSchema } from '../attachments/uploadContracts.js';
const id = z.string().min(1).max(256).refine(value => !value.includes('\0'));
export const retainedDeliveryIntentSchema = z.object({ schemaVersion: z.literal(1),
  binding: z.object({ backendId: id, teamId: id, teamName: id, runId: id, memberId: id, generation: id }).strict(),
  commandId: id, principalId: id, authorityRevision: z.number().int().min(1), messageId: id, deliveryId: id, inputId: id,
  content: z.string().max(1024 * 1024), attachments: messageAttachmentReferencesSchema.optional(), phase: z.enum(['pending', 'admitted', 'not_admitted']), runtimeReceipt: z.unknown().optional() }).strict();
export const retainedDeliveryCancellationSchema = z.object({ intent: retainedDeliveryIntentSchema,
  proof: z.object({ inputId: id, outcome: z.enum(['admitted', 'not_admitted', 'unknown']), receipt: z.unknown().optional() }).strict().optional(),
  fingerprint: z.string().optional() }).strict();
