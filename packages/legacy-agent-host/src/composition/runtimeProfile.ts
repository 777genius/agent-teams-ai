import { z } from 'zod';

const id = z.string().min(1).max(256);
const path = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => value.startsWith('/'));
const boundedStrings = z.array(z.string().min(1).max(256)).max(256);

/** Captured host configuration only. These fields never come from a runtime RPC. */
export const runtimeProfileSchema = z
  .object({
    members: z
      .array(
        z
          .object({
            teamId: id,
            memberId: id,
            principalId: id,
            provider: z.literal('claude'),
            sessionId: id,
            generation: z.number().int().min(0),
            configRevision: id,
            cwd: path,
            model: id,
            accountBinding: id,
            environment: z.record(
              z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
              z.string().max(64 * 1024)
            ),
            executable: z.object({ path, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
            configNamespace: z.enum(['native-default', 'custom-directory']).optional(),
            nativeTools: boundedStrings,
            autoAllowedTools: boundedStrings,
            nativeOptions: z
              .object({
                permissionMode: z
                  .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
                  .optional(),
                allowDangerouslySkipPermissions: z.boolean().optional(),
                settingSources: z
                  .array(z.enum(['user', 'project', 'local']))
                  .max(3)
                  .optional(),
                projectInstructions: z
                  .object({
                    append: z
                      .string()
                      .max(64 * 1024)
                      .optional(),
                  })
                  .strict()
                  .optional(),
                effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
                fastMode: z.boolean().optional(),
                context: z.enum(['model-default', 'one-million']).optional(),
              })
              .strict()
              .optional(),
            limits: z
              .object({
                queuedInputs: z.number().int().min(1).max(1024),
                inputBytes: z
                  .number()
                  .int()
                  .min(1)
                  .max(8 * 1024 * 1024),
                outputBytes: z
                  .number()
                  .int()
                  .min(1)
                  .max(16 * 1024 * 1024),
                outputEvents: z.number().int().min(1).max(100_000),
                pendingInteractions: z.number().int().min(1).max(1024),
                timeoutMs: z.number().int().min(1).max(300_000),
              })
              .strict(),
            mcpLifetimeMs: z
              .number()
              .int()
              .min(1000)
              .max(24 * 60 * 60 * 1000)
              .optional(),
          })
          .strict()
      )
      .min(1)
      .max(256),
  })
  .strict();

export type RuntimeMemberProfile = z.infer<typeof runtimeProfileSchema>['members'][number];
