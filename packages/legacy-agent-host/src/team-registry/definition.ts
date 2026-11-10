import { z } from 'zod';
import { memberSettingsSchema, savedTeamSettingsSchema } from '../team/rosterSchema.js';
import { teamRegistryScopeSchema } from './contracts.js';

const id = z.string().min(1).max(256);
const segment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const binding = z.object({ backendId: segment, teamId: segment, teamName: segment }).strict();

/** Shared trusted bootstrap definition for static and registry-created Teams. */
export const hostedTeamDefinitionSchema = z
  .object({
    scope: teamRegistryScopeSchema,
    binding,
    savedSettings: savedTeamSettingsSchema.optional(),
    members: z
      .array(
        z
          .object({
            memberId: segment,
            name: segment,
            role: z.enum(['lead', 'member']),
            settings: memberSettingsSchema.optional(),
            launchPolicy: z.enum(['launch', 'skip']).optional(),
            delivery: binding
              .extend({ runId: id, memberId: segment, generation: id })
              .strict()
              .optional(),
          })
          .strict()
      )
      .max(256),
    grants: z
      .array(
        z
          .object({
            principalId: id,
            memberName: segment,
            permissions: z.array(
              z.enum(['read', 'task.write', 'message.write', 'process.write', 'admin'])
            ),
            revoked: z.boolean().optional(),
          })
          .strict()
      )
      .max(1024),
  })
  .strict();

export type HostedTeamDefinition = z.infer<typeof hostedTeamDefinitionSchema>;
