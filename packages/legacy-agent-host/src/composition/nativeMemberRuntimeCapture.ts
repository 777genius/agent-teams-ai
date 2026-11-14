import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { effectId } from '../team/identity.js';
import { memberSettingsSchema, savedTeamSettingsSchema } from '../team/rosterSchema.js';
import { runtimeDigest } from '../runtime/identity.js';
import { captureRuntimeExtraArgs } from './runtimeExtraArgs.js';
import { resolveRuntimeRecipe } from './runtimeRecipe.js';
import { RuntimeSourceUnavailable } from './runtimeSourceGrantAuthority.js';
import { compileRuntimeMemberProfile, runtimeCaptureSourceSchema } from './runtimeCaptureSource.js';
import {
  loadCapturedRuntimeMcpRecipe,
  validateCapturedRuntimeMcpRecipe,
  capturedRuntimeMcpReferencesSchema,
} from './capturedRuntimeMcpRecipes.js';
import type { HostedTeam } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type {
  NativeMemberCreationInput,
  NativeMemberCreationView,
} from '../team/nativeMemberCreationContracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);
export const nativeMemberRuntimeCaptureSchema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: id,
    configurationRevision: hash,
    launchId: id,
    savedSettings: savedTeamSettingsSchema,
    leadProvider: z.enum(['anthropic', 'codex', 'opencode']),
    member: z
      .object({
        memberId: id,
        name: id,
        role: z.literal('member'),
        settings: memberSettingsSchema,
      })
      .strict(),
    mcpRecipeReference: capturedRuntimeMcpReferencesSchema.element,
    recipeDigest: hash,
  })
  .strict();
export type NativeMemberRuntimeCapture = z.infer<typeof nativeMemberRuntimeCaptureSchema>;

/** Canonical team root is immutable capture data. Lead worktree cwd is never a fallback. */
export function nativeMemberCaptureSource(
  team: HostedTeam,
  input: NativeMemberCreationInput,
  expected: NativeMemberCreationView,
  leadProvider: NativeMemberRuntimeCapture['leadProvider']
) {
  const original =
    team.capture === undefined ? undefined : runtimeCaptureSourceSchema.safeParse(team.capture);
  if (original && !original.success) throw new TeamLaunchError('hold', 'native-member-capture');
  if (!original && team.configurationRevision !== undefined)
    throw new TeamLaunchError('hold', 'native-member-capture');
  const savedSettings = original?.success
    ? original.data.savedSettings
    : team.definition.savedSettings;
  if (!savedSettings || !isAbsolute(savedSettings.cwd))
    throw new TeamLaunchError('hold', 'native-member-workspace');
  const { name, ...settings } = input.member;
  return {
    schemaVersion: 1 as const,
    commandId: input.commandId,
    configurationRevision: expected.revision,
    launchId: team.launchId ?? team.definition.scope.runId,
    savedSettings: structuredClone(savedSettings),
    leadProvider,
    member: {
      memberId: expected.memberId,
      name,
      role: 'member' as const,
      settings,
    },
  };
}

/** Only trusted private templates select account/env/executable. New native members share canonical root. */
export function nativeMemberBaseRecipe(
  profile: TeamHostProfile,
  teamId: string,
  source: Omit<NativeMemberRuntimeCapture, 'mcpRecipeReference' | 'recipeDigest'>,
  restoring = false
) {
  const recipe = resolveRuntimeRecipe(
    profile.runtime,
    teamId,
    source.member.memberId,
    source.member.settings.providerId,
    restoring
  );
  return {
    ...captureRuntimeExtraArgs([recipe], source.savedSettings.extraCliArgs)[0]!,
    cwd: source.savedSettings.cwd,
  };
}

export function compileNativeMemberRuntimeCapture(
  profile: TeamHostProfile,
  team: HostedTeam,
  raw: unknown,
  restoring = false
) {
  const capture = nativeMemberRuntimeCaptureSchema.parse(raw);
  if (capture.mcpRecipeReference.memberId !== capture.member.memberId)
    throw new TeamLaunchError('hold', 'native-member-binding');
  const store = new TeamOwnerStore(profile.owner.storageRoot, team.definition.binding.teamName);
  if (restoring) validateCapturedRuntimeMcpRecipe(
    store, capture.commandId, capture.mcpRecipeReference, capture.savedSettings.cwd
  );
  const base = nativeMemberBaseRecipe(profile, team.definition.binding.teamId, capture, restoring);
  const selected = loadCapturedRuntimeMcpRecipe(
    store,
    capture.commandId,
    base,
    capture.mcpRecipeReference,
    restoring
  );
  if (runtimeDigest(selected) !== capture.recipeDigest) {
    if (restoring) throw new RuntimeSourceUnavailable();
    throw new TeamLaunchError('hold', 'native-member-recipe');
  }
  const compiled = compileRuntimeMemberProfile(
    selected,
    capture,
    capture.member,
    capture.leadProvider,
    capture.launchId
  );
  return {
    capture,
    profile: compiled,
    selection: {
      principalId: compiled.principalId,
      configurationDigest: runtimeDigest(compiled),
      delivery: {
        ...team.definition.binding,
        runId: capture.launchId,
        memberId: capture.member.memberId,
        generation: `capture-${effectId('generation', capture.launchId, capture.member.memberId)}`,
      },
    },
  };
}
