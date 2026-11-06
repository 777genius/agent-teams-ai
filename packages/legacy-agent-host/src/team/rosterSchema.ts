import { z } from 'zod';
import { digest } from './identity.js';
import type { TeamMember } from './contracts.js';

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'));
const name = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const memberSettingsSchema = z
  .object({
    role: text(256).optional(),
    workflow: text(64 * 1024).optional(),
    isolation: z.literal('worktree').optional(),
    cwd: text(8192).optional(),
    providerId: z.enum(['anthropic', 'codex', 'gemini', 'opencode']).optional(),
    providerBackendId: z
      .enum(['auto', 'adapter', 'api', 'cli-sdk', 'codex-native', 'opencode-cli'])
      .optional(),
    model: text(256).optional(),
    effort: z
      .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none', 'ultra'])
      .optional(),
    fastMode: z.enum(['inherit', 'on', 'off']).optional(),
    mcpPolicy: z
      .object({
        mode: z.enum(['inheritLead', 'inheritScopes', 'strictAllowlist', 'appOnly']),
        scopes: z
          .object({
            user: z.boolean().optional(),
            project: z.boolean().optional(),
            local: z.boolean().optional(),
          })
          .strict()
          .optional(),
        serverNames: z.array(text(256)).max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const savedText = (max: number, nonempty = false) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes('\0') && (!nonempty || !!value.trim()));
/** Configured app intent, never inferred from an effective native profile.
 * cwd is application data; native admission separately validates access/launch. */
export const savedTeamSettingsSchema = z
  .object({
    runtimeSelectionVersion: z.literal(1).optional(),
    cwd: savedText(8192, true),
    displayName: savedText(256).optional(),
    description: savedText(64 * 1024).optional(),
    color: savedText(256).optional(),
    prompt: savedText(64 * 1024).optional(),
    ...memberSettingsSchema.pick({
      providerId: true,
      providerBackendId: true,
      model: true,
      effort: true,
      fastMode: true,
    }).shape,
    syncModelsWithLead: z.boolean().optional(),
    limitContext: z.boolean().optional(),
    skipPermissions: z.boolean().optional(),
    worktree: savedText(256).optional(),
    extraCliArgs: savedText(64 * 1024).optional(),
    allowExperimentalLocalModels: z.boolean().optional(),
  })
  .strict();
export type TeamSavedSettings = z.infer<typeof savedTeamSettingsSchema>;

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const memberSettingsRelaunchSchema = z
  .object({
    memberName: name,
    targetKind: z.enum(['lead', 'member']),
    expectedFingerprint: fingerprint,
    expectedTeamSettingsFingerprint: fingerprint,
    baseline: z
      .array(z.object({ memberName: name, expectedFingerprint: fingerprint }).strict())
      .max(256),
    model: text(256).nullable(),
    effort: memberSettingsSchema.shape.effort.unwrap().nullable(),
  })
  .strict();

export const replaceRosterSchema = z
  .object({
    commandId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !!value.trim() && !value.includes('\0')),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    members: z.array(memberSettingsSchema.extend({ name }).strict()).max(255),
    /** Omission preserves prior app settings; a supplied object fully replaces them. */
    savedSettings: savedTeamSettingsSchema.optional(),
    memberSettingsRelaunch: memberSettingsRelaunchSchema.optional(),
  })
  .strict();

/** The transport supplies commandId from its own captured envelope. */
export const replaceRosterPayloadSchema = replaceRosterSchema.omit({ commandId: true });

/** Technical generation changes and grants do not masquerade as product roster edits. */
export function teamRosterRevision(
  members: readonly Pick<TeamMember, 'memberId' | 'name' | 'role' | 'settings'>[],
  version = 0,
  savedSettings?: TeamSavedSettings
): string {
  return digest({
    version,
    ...(savedSettings === undefined ? {} : { savedSettings }),
    members: members.map(({ memberId, name, role, settings }) => ({
      memberId,
      name,
      role,
      settings: settings ?? {},
    })),
  });
}
