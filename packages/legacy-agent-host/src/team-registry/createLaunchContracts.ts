import { z } from 'zod';
import { createTeamRegistryPayloadSchema, teamRegistryReceiptSchema, teamRegistryRecordSchema } from './contracts.js';
import type { TeamRegistryReceipt, TeamRegistryRecord } from './contracts.js';
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
  execution?: TeamRegistryRecord | undefined;
  launch: TeamLaunchSummary;
  /** The Team and capture exist; this does not claim that a native launch succeeded. */
  partialCreated?: true | undefined;
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
    execution: teamRegistryRecordSchema.optional(),
    launch: launchSummarySchema,
    partialCreated: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const execution = value.execution, logical = value.creation.record;
    if (execution && (logical.projectContextMode !== 'per_project' || logical.projectContext ||
        execution.projectContext?.logicalTeamId !== logical.teamId ||
        execution.projectContext?.logicalHandleId !== logical.binding.handleId ||
        execution.contextId !== logical.contextId || execution.projectContextMode === 'per_project' ||
        execution.binding.scope.projectId !== logical.binding.scope.projectId ||
        execution.binding.scope.workspaceId !== logical.binding.scope.workspaceId ||
        value.launch.members.some(row => row.binding && row.binding.teamId !== execution.teamId)))
      context.addIssue({ code: 'custom', message: 'Creation execution must be an original project history' });
    if (!execution && logical.projectContextMode === 'per_project')
      context.addIssue({ code: 'custom', message: 'Per-project creation requires its exact execution history' });
    if (value.partialCreated && (value.creation.phase !== 'published' ||
        value.launch.admission || value.launch.startedAtMs !== null ||
        value.launch.members.some(member => member.attempt.claimed)))
      context.addIssue({ code: 'custom', message: 'Partial creation requires a published Team and an unadmitted capture' });
  });

/** Private original Create prefix: a published Team/capture, with no Runtime admission. */
export const createTeamLaunchCaptureResultSchema = createTeamLaunchSubmitResultSchema
  .refine(value => value.partialCreated === true, 'Capture requires an unadmitted partial creation')
  .transform(value => ({ ...value, partialCreated: true as const }));
export type CreateTeamLaunchCaptureResult = z.infer<typeof createTeamLaunchCaptureResultSchema>;
