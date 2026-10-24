import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import { memberSettingsSchema, savedTeamSettingsSchema } from '../team/rosterSchema.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !!value.trim() && !value.includes('\0'));
const segment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);

/** Product intent only. Context authority and the principal come from trusted composition. */
export const createTeamRegistryPayloadSchema = z
  .object({
    contextId: id,
    teamName: segment,
    savedSettings: savedTeamSettingsSchema,
    members: z
      .array(z.object({ name: segment, memberSettings: memberSettingsSchema }).strict())
      .max(255),
  })
  .strict()
  .superRefine((value, context) => {
    const names = [
      'team-lead',
      'user',
      ...value.members.map((member) => member.name.toLowerCase()),
    ];
    if (new Set(names).size !== names.length)
      context.addIssue({ code: 'custom', message: 'Duplicate or reserved member name' });
    if (
      !isAbsolute(value.savedSettings.cwd) ||
      resolve(value.savedSettings.cwd) !== value.savedSettings.cwd
    )
      context.addIssue({ code: 'custom', message: 'Expected a canonical absolute project path' });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024)
      context.addIssue({ code: 'custom', message: 'Creation intent too large' });
  });

export const teamRegistryScopeSchema = z
  .object({
    projectId: id,
    workspaceId: id,
    teamId: segment,
    runId: id,
    memberId: id,
    generation: id,
  })
  .strict();

/** Host-to-Main only. Contains no native IDs, account selectors, env or filesystem paths. */
export const teamRegistryRecordSchema = z
  .object({
    contextId: id,
    teamId: segment,
    teamName: segment,
    displayName: z.string().max(256).optional(),
    description: z
      .string()
      .max(64 * 1024)
      .optional(),
    color: z.string().max(256).optional(),
    members: z.array(z.object({ memberId: segment, label: segment }).strict()).max(256),
    binding: z
      .object({
        schemaVersion: z.literal(1),
        handleId: id,
        scope: teamRegistryScopeSchema,
      })
      .strict(),
  })
  .strict();

export const teamRegistryReceiptSchema = z
  .object({
    commandId: id,
    phase: z.enum(['pending', 'published', 'held']),
    record: teamRegistryRecordSchema,
  })
  .strict();

export const teamRegistryListSchema = z
  .object({
    teams: z.array(teamRegistryRecordSchema).max(256),
    held: z.array(teamRegistryReceiptSchema).max(256),
  })
  .strict();

export type CreateTeamRegistryPayload = z.infer<typeof createTeamRegistryPayloadSchema>;
export type TeamRegistryRecord = z.infer<typeof teamRegistryRecordSchema>;
export type TeamRegistryReceipt = z.infer<typeof teamRegistryReceiptSchema>;
export type TeamRegistryList = z.infer<typeof teamRegistryListSchema>;
