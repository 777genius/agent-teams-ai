import { z } from 'zod';
import { hostedTeamDefinitionSchema } from '../team-registry/definition.js';
import { providerManagementProfileSchema } from '../management/profile.js';
import { processCustodyProfileSchema } from './processCustody.js';
import { runtimeProfileSchema } from './runtimeProfile.js';
import { hostOwnerSchema } from './teamHostEnvelope.js';

const id = z.string().min(1).max(256);

/** Private captured composition data, never an IPC/tool argument or renderer DTO. */
export const teamHostProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: hostOwnerSchema,
    principalId: id,
    reviewTransport: z.literal('review-v1').optional(),
    /** Default off, captured per native Query/session; never auto-restarts a teammate. */
    promptSuggestions: z.object({ enabled: z.boolean() }).strict().optional(),
    runtime: runtimeProfileSchema.optional(),
    processCustody: processCustodyProfileSchema.optional(),
    management: z.array(providerManagementProfileSchema).max(16).optional(),
    creation: z
      .object({ contextIds: z.array(id).min(1).max(256) })
      .strict()
      .optional(),
    teams: z.array(hostedTeamDefinitionSchema).max(256),
  })
  .strict();

export type TeamHostProfile = z.infer<typeof teamHostProfileSchema>;
