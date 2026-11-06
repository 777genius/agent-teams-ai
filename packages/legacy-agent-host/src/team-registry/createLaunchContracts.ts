import { z } from 'zod';
import { createTeamRegistryPayloadSchema, teamRegistryReceiptSchema } from './contracts.js';
import type { TeamRegistryReceipt } from './contracts.js';
import type { TeamLaunchSummary } from '../team-launch/contracts.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !!value.trim() && !/[\0\r\n]/u.test(value));
export const createTeamLaunchPreparationInputSchema = z
  .object({
    preparationId: id,
    draft: createTeamRegistryPayloadSchema,
  })
  .strict();
export const createTeamLaunchPreparationSnapshotSchema = z
  .object({
    preparationId: id,
    draftDigest: z.string().regex(/^[a-f0-9]{64}$/),
    ready: z.boolean(),
    probes: z
      .array(
        z
          .object({
            memberName: id,
            commandId: id,
            model: id,
            effort: z
              .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
              .optional(),
            context: z.enum(['model-default', 'one-million']).optional(),
            phase: z.enum(['not-started', 'running', 'completed', 'cancelled', 'held']),
            ok: z.boolean(),
            expiresAt: z.number().int().nonnegative(),
          })
          .strict()
      )
      .min(1)
      .max(256),
  })
  .strict();
export type CreateTeamLaunchPreparationInput = z.infer<
  typeof createTeamLaunchPreparationInputSchema
>;
export type CreateTeamLaunchPreparationSnapshot = z.infer<
  typeof createTeamLaunchPreparationSnapshotSchema
>;
export interface CreateTeamLaunchSubmitResult {
  creation: TeamRegistryReceipt;
  launch: TeamLaunchSummary;
}
const timestamp = z.number().int().nonnegative();
const launchSummarySchema = z
  .object({
    launchId: id,
    rosterRevision: id,
    startedAtMs: timestamp.nullable(),
    observedAtMs: timestamp,
    status: z.enum(['ready', 'pending', 'partial', 'failed']),
    ready: z.number().int().min(0).max(256),
    expected: z.number().int().min(0).max(256),
    retryCapability: z.literal('same-binding-no-allocation-only'),
    admission: z
      .object({
        commandId: id,
        sourceRosterRevision: id,
        members: z.array(z.object({ memberId: id, configuration: z.json() }).strict()).max(256),
      })
      .strict()
      .optional(),
    members: z
      .array(
        z
          .object({
            memberId: id,
            binding: z
              .object({ backendId: id, teamId: id, runId: id, memberId: id, generation: id })
              .strict()
              .nullable(),
            attempt: z
              .object({
                attemptId: id,
                hostIncarnation: id,
                startedAtMs: timestamp,
                deadlineMs: timestamp,
                claimed: z.boolean(),
                status: z.enum([
                  'not-started',
                  'pending-bootstrap',
                  'pending-human',
                  'ready',
                  'failed',
                  'unknown',
                  'skipped',
                ]),
                reason: id,
                nativeReady: z.boolean(),
                contextApplied: z.boolean(),
                everReady: z.boolean(),
                usable: z.boolean(),
                controlAvailable: z.boolean(),
                noAllocation: z.boolean(),
              })
              .strict(),
          })
          .strict()
      )
      .max(256),
  })
  .strict()
  .transform(
    ({ admission, ...value }): TeamLaunchSummary => ({
      ...value,
      ...(admission === undefined ? {} : { admission }),
    })
  );
export const createTeamLaunchSubmitResultSchema: z.ZodType<CreateTeamLaunchSubmitResult> = z
  .object({
    creation: teamRegistryReceiptSchema,
    launch: launchSummarySchema,
  })
  .strict();
