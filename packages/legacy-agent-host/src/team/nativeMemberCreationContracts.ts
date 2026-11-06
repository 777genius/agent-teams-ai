import { z } from 'zod';
import { memberSettingsSchema } from './rosterSchema.js';
import type { DeliveryBinding, TeamMember } from './contracts.js';
import type { NativeMcpAuthorityProof } from './NativeMcpAuthority.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'));
export const nativeMemberCreationSchema = z
  .object({
    commandId: id,
    expectedRosterRevision: z.string().regex(/^[a-f0-9]{64}$/),
    member: memberSettingsSchema
      .pick({ model: true, role: true, workflow: true })
      .extend({
        name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
        providerId: z.enum(['anthropic', 'codex', 'opencode']),
      })
      .strict(),
  })
  .strict();
export type NativeMemberCreationInput = z.infer<typeof nativeMemberCreationSchema>;
/** Private original native call; never accepted from a tool argument or renderer. */
export interface NativeMemberCreationAuthority {
  team: Readonly<NativeMcpAuthorityProof>;
  fingerprint: string;
  assertCurrent(): void;
  assertTeamCurrent(): void;
}
/** Extends the existing roster receipt in Team's single state publication. */
export interface NativeMemberCreationRecord {
  schemaVersion: 1;
  phase: 'prepared' | 'configured' | 'completed' | 'held';
  expectedRosterRevision: string;
  input: NativeMemberCreationInput;
  source: Readonly<NativeMcpAuthorityProof>;
  inputAuthority: string;
  member: TeamMember;
  selection?: {
    principalId: string;
    delivery: DeliveryBinding;
    configurationDigest: string;
  };
}
export interface NativeMemberCreationView {
  commandId: string;
  memberId: string;
  name: string;
  revision: string;
  phase: NativeMemberCreationRecord['phase'];
}
