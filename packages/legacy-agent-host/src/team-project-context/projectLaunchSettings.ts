import { z } from 'zod';
import { savedTeamSettingsSchema } from '../team/rosterSchema.js';
import type { TeamSavedSettings } from '../team/rosterContracts.js';

const definitionKeys = ['providerId', 'providerBackendId', 'model', 'effort', 'fastMode', 'syncModelsWithLead', 'limitContext'] as const;
const projectKeys = ['skipPermissions', 'worktree', 'extraCliArgs'] as const;
export const projectLaunchSettingsSchema = z.object({
  providerId: savedTeamSettingsSchema.shape.providerId,
  providerBackendId: savedTeamSettingsSchema.shape.providerBackendId.unwrap().nullable().optional(),
  model: savedTeamSettingsSchema.shape.model.unwrap().nullable().optional(),
  effort: savedTeamSettingsSchema.shape.effort.unwrap().nullable().optional(),
  fastMode: savedTeamSettingsSchema.shape.fastMode.unwrap().nullable().optional(),
  syncModelsWithLead: z.boolean().optional(), limitContext: z.boolean().optional(),
  skipPermissions: z.boolean().nullable().optional(),
  worktree: savedTeamSettingsSchema.shape.worktree.unwrap().nullable().optional(),
  extraCliArgs: savedTeamSettingsSchema.shape.extraCliArgs.unwrap().nullable().optional(),
}).strict();
export type ProjectLaunchSettings = z.infer<typeof projectLaunchSettingsSchema>;

function apply(target: Record<string, unknown>, input: ProjectLaunchSettings, keys: readonly string[]): void {
  for (const key of keys) if (Object.hasOwn(input, key)) {
    const value = input[key as keyof ProjectLaunchSettings];
    if (value === null || value === undefined) delete target[key]; else target[key] = value;
  }
}
/** Model defaults belong to the definition; per-project runtime flags never overwrite it. */
export function applyDefinitionLaunchSettings(saved: TeamSavedSettings, input?: ProjectLaunchSettings): TeamSavedSettings {
  const result: Record<string, unknown> = { ...saved };
  if (input) {
    if (input.providerId !== undefined && input.providerId !== saved.providerId)
      for (const key of ['providerBackendId', 'model', 'effort', 'fastMode', 'limitContext'])
        if (!Object.hasOwn(input, key)) delete result[key];
    apply(result, input, definitionKeys);
  }
  return savedTeamSettingsSchema.parse(result);
}

/** The first copy inherits the source once; later definition projections retain each copy's local flags. */
export function projectDefinitionSettings(logical: TeamSavedSettings | undefined, copy: TeamSavedSettings | undefined,
  projectPath: string, launch?: ProjectLaunchSettings): TeamSavedSettings {
  const result: Record<string, unknown> = { ...logical, cwd: projectPath, projectContextMode: 'shared' };
  for (const key of projectKeys) {
    delete result[key];
    if (copy && Object.hasOwn(copy, key)) result[key] = copy[key];
  }
  if (launch) apply(result, launch, projectKeys);
  return savedTeamSettingsSchema.parse(result);
}

/** Comparison of authored configuration deliberately excludes project-owned launch flags. */
export function projectAuthoredSettings(settings: TeamSavedSettings | undefined, projectPath: string) {
  const result: Record<string, unknown> = { ...settings, cwd: projectPath, projectContextMode: 'shared' };
  for (const key of projectKeys) delete result[key];
  return result;
}
