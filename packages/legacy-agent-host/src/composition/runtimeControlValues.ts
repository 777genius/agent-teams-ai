import { z } from 'zod';

/** Existing Runtime control payloads; question denial stays disjoint from answers. */
export const runtimeMember = z
  .object({
    memberId: z.string().min(1).max(256),
    expectedGeneration: z.string().min(1).max(256).optional(),
  })
  .strict();
export const runtimeControlId = z.string().min(1).max(256);
export const runtimeActivityCursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);
export const runtimeInteraction = runtimeMember
  .extend({
    inputId: runtimeControlId,
    interactionRef: runtimeControlId,
    reply: z.union([
      z
        .object({
          kind: z.literal('permission'),
          decision: z.enum(['allow', 'deny']),
        })
        .strict(),
      z
        .object({
          kind: z.literal('question'),
          answers: z.record(runtimeControlId, z.string().max(64 * 1024)),
        })
        .strict(),
      z.object({ kind: z.literal('question'), decision: z.literal('deny') }).strict(),
    ]),
  })
  .strict();

/** One finite registration list for the same control payload/dispatch seam. */
export const RUNTIME_CONTROL_OPERATIONS = [
  'open', 'read', 'dispatch', 'stop', 'interrupt', 'interaction', 'reconcile',
  'checkpoint', 'checkpoints.read', 'restore', 'activity.snapshot', 'activity.feed',
  'approval.settings.read', 'approval.settings.update', 'interaction.preview.read',
] as const;
