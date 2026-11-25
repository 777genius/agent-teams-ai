import { z } from 'zod';
import { replaceRosterPayloadSchema } from '../team/rosterSchema.js';
import { projectLaunchSettingsSchema } from './projectLaunchSettings.js';
export { projectLaunchSettingsSchema } from './projectLaunchSettings.js';
export type { ProjectLaunchSettings } from './projectLaunchSettings.js';

const id = z.string().min(1).max(256).refine(value => !!value.trim() && !/[\0\r\n]/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(8192).refine(value => !/[\0\r\n]/u.test(value));
export const projectContextReadSchema = z.object({ projectPath: path.optional(), scheduleAdmission: z.literal(true).optional() }).strict();
export const projectContextPrepareSchema = z.object({ projectPath: path, expectedRevision: hash.optional(),
  rosterCommandId: id.optional(), launchSettings: projectLaunchSettingsSchema.optional() }).strict();
export const projectReadinessLocatorSchema = z.object({ logicalHandleId: id, commandId: id }).strict();
export type ProjectReadinessLocator = z.infer<typeof projectReadinessLocatorSchema>;
export const projectContextViewSchema = z.union([
  z.object({ mode: z.literal('shared'), state: z.literal('ready'), executionHandleId: id }).strict(),
  z.object({ mode: z.literal('per_project'), state: z.literal('ready'), executionHandleId: id, workContextId: id, projectPath: path }).strict(),
  z.object({ mode: z.literal('per_project'), state: z.literal('empty') }).strict(),
  z.object({ mode: z.literal('per_project'), state: z.literal('needs_project'), recoveryProjectPath: path.optional() }).strict(),
  z.object({ mode: z.literal('per_project'), state: z.literal('pending'), reason: z.literal('incomplete'), projectPath: path, runId: z.null() }).strict(),
  z.object({ mode: z.literal('per_project'), state: z.literal('redirect'), logicalHandleId: id, projectPath: path }).strict(),
]);
export const hostProjectContextSnapshotSchema = z.object({ kind: z.literal('team-project-context'), view: projectContextViewSchema,
  histories: z.array(z.object({ executionHandleId: id, workContextId: id, projectPath: path }).strict()).max(256),
  prepared: z.object({ executionHandleId: id, rosterCommandId: id, sourceRevision: hash }).strict().optional(),
}).strict();
export type HostProjectContextSnapshot = z.infer<typeof hostProjectContextSnapshotSchema>;
export const projectPreparationIndexSchema = z.array(z.object({ commandId: id, fingerprint: hash }).strict()).max(1024);
export const projectPreparationSelectionSchema = z.object({ schemaVersion: z.literal(1), commandId: id, fingerprint: hash,
  logicalHandleId: id, sourceRevision: hash, probeRevision: hash, projectKey: hash, projectPath: path,
  definition: z.object({ commandId: id, roster: replaceRosterPayloadSchema }).strict().optional(),
}).strict();
export const projectPreparationRecordSchema = projectPreparationSelectionSchema.extend({
  executionHandleId: id, executionTeamId: id, rosterCommandId: id, roster: replaceRosterPayloadSchema,
}).strict();
export type ProjectPreparationRecord = z.infer<typeof projectPreparationRecordSchema>;
