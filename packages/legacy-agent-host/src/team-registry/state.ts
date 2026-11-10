import { z } from 'zod';
import { createTeamRegistryPayloadSchema, teamRegistryRecordSchema } from './contracts.js';
import { hostedTeamDefinitionSchema } from './definition.js';

export const storedTeamCreationSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownerId: z.string().min(1).max(256),
    profileId: z.string().min(1).max(256),
    principalId: z.string().min(1).max(256),
    commandId: z.string().min(1).max(256),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    intent: createTeamRegistryPayloadSchema,
    definition: hostedTeamDefinitionSchema,
    record: teamRegistryRecordSchema,
    phase: z.enum(['pending', 'published', 'held']),
    /** Once published, loss of the original owner marker must never recreate bootstrap defaults. */
    bootstrapPublished: z.boolean(),
  })
  .strict();

export type StoredTeamCreation = z.infer<typeof storedTeamCreationSchema>;

/** One creation journal owns identity, original intent, outcome and discovery metadata. */
export interface TeamRegistryStore {
  readAll(): StoredTeamCreation[];
  write(record: StoredTeamCreation): void;
  fenced<T>(action: () => T): T;
}
