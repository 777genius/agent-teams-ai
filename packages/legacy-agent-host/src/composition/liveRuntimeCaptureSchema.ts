import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { memberSettingsSchema, savedTeamSettingsSchema } from '../team/rosterSchema.js';
import { liveExpectedMemberSchema } from '../team-launch/liveRosterMembership.js';
import { launchWorktreePlanSchema, ownedWorktreeBindingSchema } from '../team-launch/worktreeSchema.js';
import { runtimeSourceReferenceSchema } from './runtimeSourceContracts.js';
import { capturedRuntimeMcpReferencesSchema } from './capturedRuntimeMcpReferences.js';

/** Pure retained live-capture shapes shared by compilation and original process admission. */
const id = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().min(1).max(8192).refine(value => isAbsolute(value) && !/[\0\r\n]/u.test(value));
export const liveRuntimeCaptureSeedSchema = z.object({
  schemaVersion: z.literal(1), commandId: id, requestDigest: hash, sourceCaptureDigest: hash,
  expectedRevision: hash, launchId: id, sourceCwd: path,
  savedSettings: savedTeamSettingsSchema, leadProvider: z.enum(['anthropic', 'codex', 'opencode']),
  member: z.object({ memberId: id, name: id, role: z.literal('member'), settings: memberSettingsSchema }).strict(),
  sourceReference: runtimeSourceReferenceSchema.optional(), templateDigest: hash,
  previous: liveExpectedMemberSchema.nullable(),
}).strict();
export const liveRuntimeCaptureSchema = liveRuntimeCaptureSeedSchema.extend({
  workspace: path, worktree: z.object({ plan: launchWorktreePlanSchema, binding: ownedWorktreeBindingSchema }).strict().optional(),
  mcpRecipeReference: capturedRuntimeMcpReferencesSchema.element, recipeDigest: hash,
  configurationDigest: hash, runtimeGeneration: z.number().int().positive(),
}).strict();
export type LiveRuntimeCapture = z.infer<typeof liveRuntimeCaptureSchema>;
export type LiveRuntimeCaptureSeed = z.infer<typeof liveRuntimeCaptureSeedSchema>;
