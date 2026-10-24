import { isAbsolute } from 'node:path';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import {
  capturedRuntimeMcpReferencesSchema,
  loadCapturedRuntimeMcpRecipe,
} from './capturedRuntimeMcpRecipes.js';
import {
  capturedWorktreesSchema,
  ownedWorktreeBindingSchema,
} from '../team-launch/worktreeSchema.js';
import { z } from 'zod';
import { effectId } from '../team/identity.js';
import { memberSettingsSchema, savedTeamSettingsSchema } from '../team/rosterSchema.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { applyLaunchConfiguration } from './launchConfiguration.js';
import { captureClaudeSettingSources } from './claudeSettingSources.js';
import { captureRuntimeMcp } from './captureRuntimeMcp.js';
import { captureRuntimeExtraArgs } from './runtimeExtraArgs.js';
import { runtimeMemberProfileSchema } from './runtimeProfile.js';
import { resolveRuntimeRecipe, runtimeProviderId } from './runtimeRecipe.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam } from './MemberEntry.js';
import type { TeamRosterConfiguration } from '../team/rosterContracts.js';
import type { TeamRuntimeCapture } from '../team/runtimeRegistrationContracts.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeCaptureSourceSchema = z
  .object({
    commandId: id,
    rosterCommandId: id,
    configurationRevision: hash,
    mcpCaptureVersion: z.literal(1).optional(),
    mcpRecipeReferences: capturedRuntimeMcpReferencesSchema.optional(),
    savedSettings: savedTeamSettingsSchema,
    members: z
      .array(
        z
          .object({
            memberId: id,
            name: id,
            role: z.enum(['lead', 'member']),
            settings: memberSettingsSchema,
            recipeDigest: hash,
          })
          .strict()
      )
      .min(1)
      .max(256),
    worktrees: capturedWorktreesSchema.optional(),
    worktreeIntentDigest: hash.optional(),
    worktreeBindings: z.array(ownedWorktreeBindingSchema).max(256).optional(),
  })
  .strict();
export type RuntimeCaptureSource = z.infer<typeof runtimeCaptureSourceSchema>;

function refuse(reason: string): never {
  throw new TeamLaunchError('invalid', reason);
}
function recipes(
  profile: TeamHostProfile,
  teamId: string,
  source: {
    savedSettings: RuntimeCaptureSource['savedSettings'];
    commandId?: string;
    mcpCaptureVersion?: 1 | undefined;
    mcpRecipeReferences?: RuntimeCaptureSource['mcpRecipeReferences'];
    worktrees?: RuntimeCaptureSource['worktrees'];
    members: readonly Pick<
      RuntimeCaptureSource['members'][number],
      'memberId' | 'role' | 'settings'
    >[];
  },
  teamName?: string
): RuntimeMemberProfile[] {
  const leads = source.members.filter((member) => member.role === 'lead');
  if (leads.length !== 1) refuse('capture-lead');
  const lead = leads[0]!;
  const leadRecipe = resolveRuntimeRecipe(
    profile.runtime,
    teamId,
    lead.memberId,
    source.savedSettings.providerId ?? lead.settings.providerId
  );
  const leadProvider = runtimeProviderId(leadRecipe);
  const selected = captureRuntimeExtraArgs(
    source.members.map((member) =>
      member === lead
        ? leadRecipe
        : resolveRuntimeRecipe(
            profile.runtime,
            teamId,
            member.memberId,
            member.settings.providerId ?? leadProvider
          )
    ),
    source.savedSettings.extraCliArgs
  );
  if (source.mcpRecipeReferences) {
    if (
      !source.commandId ||
      !teamName ||
      source.mcpRecipeReferences.length !== source.members.length
    )
      refuse('capture-mcp-references');
    const store = new TeamOwnerStore(profile.owner.storageRoot, teamName);
    return selected.map((recipe, index) => {
      const member = source.members[index]!;
      const reference = source.mcpRecipeReferences!.find((row) => row.memberId === member.memberId);
      if (!reference) refuse('capture-mcp-references');
      return loadCapturedRuntimeMcpRecipe(
        store,
        source.commandId!,
        {
          ...recipe,
          cwd: runtimeCaptureCwd(source, member),
        },
        reference
      );
    });
  }
  return source.mcpCaptureVersion === 1
    ? captureRuntimeMcp({
        recipes: selected,
        savedCwd: runtimeCaptureCwd(source, lead),
        members: source.members.map((member) => ({
          ...member,
          settings: {
            ...member.settings,
            cwd: runtimeCaptureCwd(source, member),
          },
        })),
      })
    : selected;
}

/** Caller choices are persisted before deriving any native identities. No process is started here. */
export function captureRuntimeSource(
  profile: TeamHostProfile,
  team: Pick<HostedTeam, 'definition'>,
  commandId: string,
  rosterCommandId: string,
  roster: TeamRosterConfiguration,
  context: {
    worktrees?: RuntimeCaptureSource['worktrees'];
    deferMcp?: true;
    mcpRecipeReferences?: RuntimeCaptureSource['mcpRecipeReferences'];
    worktreeIntentDigest?: string;
    worktreeBindings?: RuntimeCaptureSource['worktreeBindings'];
  } = {}
): RuntimeCaptureSource {
  if (!roster.savedSettings) refuse('saved-configuration-unavailable');
  const selectedRecipes = recipes(
    profile,
    team.definition.binding.teamId,
    {
      commandId,
      savedSettings: roster.savedSettings,
      ...(!context.deferMcp ? { mcpCaptureVersion: 1 as const } : {}),
      ...(context.worktrees ? { worktrees: context.worktrees } : {}),
      ...(context.mcpRecipeReferences ? { mcpRecipeReferences: context.mcpRecipeReferences } : {}),
      members: roster.members,
    },
    team.definition.binding.teamName
  );
  return runtimeCaptureSourceSchema.parse({
    commandId,
    rosterCommandId,
    configurationRevision: roster.revision,
    ...(!context.deferMcp ? { mcpCaptureVersion: 1 as const } : {}),
    ...(context.mcpRecipeReferences ? { mcpRecipeReferences: context.mcpRecipeReferences } : {}),
    savedSettings: roster.savedSettings,
    members: roster.members.map((member, index) => ({
      memberId: member.memberId,
      name: member.name,
      role: member.role,
      settings: member.settings,
      recipeDigest: runtimeDigest(selectedRecipes[index]!),
    })),
    ...(context.worktrees ? { worktrees: context.worktrees } : {}),
    ...(context.worktreeIntentDigest ? { worktreeIntentDigest: context.worktreeIntentDigest } : {}),
    ...(context.worktreeBindings ? { worktreeBindings: context.worktreeBindings } : {}),
  });
}

/** Private recipes supply executable/account/env/defaults; application data cannot select them. */
export function compileRuntimeCapture(
  profile: TeamHostProfile,
  team: Pick<HostedTeam, 'definition'>,
  raw: RuntimeCaptureSource,
  mode: 'launch' | 'model-preflight' = 'launch'
) {
  const source = runtimeCaptureSourceSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(source)) > 512 * 1024) refuse('capture-budget');
  if (mode === 'launch') validateWorktreeMembers(source);
  const launchId = effectId('team-launch', team.definition.binding.teamId, source.commandId);
  const lead = source.members.find((member) => member.role === 'lead');
  if (!lead || source.members.filter((member) => member.role === 'lead').length !== 1)
    refuse('capture-lead');
  let selectedRecipes: RuntimeMemberProfile[];
  try {
    selectedRecipes = recipes(
      profile,
      team.definition.binding.teamId,
      source,
      team.definition.binding.teamName
    );
  } catch (error) {
    if (error instanceof TeamLaunchError)
      throw new TeamLaunchError('hold', 'capture-recipe-changed');
    throw error;
  }
  const leadProvider = runtimeProviderId(selectedRecipes[source.members.indexOf(lead)]!);
  const profiles = source.members.map((member, index) => {
    const base = selectedRecipes[index]!;
    if (runtimeDigest(base) !== member.recipeDigest) throw new TeamLaunchError('hold', 'capture-recipe-changed');
    return compileRuntimeMemberProfile(base, source, member, leadProvider, launchId);
  });
  const registration = runtimeCaptureRegistration(team, source);
  return { source, registration, profiles };
}


/** One canonical app-choice mapping for original full captures and additive configured members. */
export function compileRuntimeMemberProfile(
  base: RuntimeMemberProfile,
  source: Pick<RuntimeCaptureSource, 'commandId' | 'configurationRevision' | 'savedSettings' | 'worktrees'>,
  member: Pick<RuntimeCaptureSource['members'][number], 'memberId' | 'role' | 'settings'>,
  leadProvider: RuntimeCaptureSource['members'][number]['settings']['providerId'],
  launchId: string
): RuntimeMemberProfile {
  const explicit = (model: string | undefined) =>
    model?.trim() && model !== '__provider_default__' ? model.trim() : undefined;
  const saved = source.savedSettings,
    settings = member.settings;
  const isLead = member.role === 'lead';
  const provider = isLead ? leadProvider : (settings.providerId ?? leadProvider);
  const backend = isLead ? saved.providerBackendId : settings.providerBackendId;
  const supportedBackends =
    base.provider === 'claude'
      ? ['auto', 'adapter', 'cli-sdk']
      : base.provider === 'codex'
        ? ['auto', 'codex-native']
        : ['auto', 'opencode-cli'];
  if (backend !== undefined && !supportedBackends.includes(backend))
    refuse('runtime-recipe-backend-unconfigured');
  const inherits = saved.syncModelsWithLead !== false && provider === leadProvider;
  const ownModel = isLead ? explicit(saved.model) : explicit(settings.model);
  const model =
    ownModel ?? (!isLead && inherits ? explicit(saved.model) : undefined) ?? base.model;
  const effort = isLead
    ? saved.effort
    : (settings.effort ?? (inherits && !ownModel ? saved.effort : undefined));
  const fast = isLead
    ? saved.fastMode
    : settings.fastMode !== undefined && settings.fastMode !== 'inherit'
      ? settings.fastMode
      : provider === leadProvider
        ? saved.fastMode
        : undefined;
  let compiled = applyLaunchConfiguration(base, {
    model,
    ...(effort === undefined ? {} : { effort }),
    ...(base.provider === 'opencode' || fast === undefined || fast === 'inherit'
      ? {}
      : { fastMode: fast === 'on' }),
    ...(base.provider !== 'claude'
      ? {}
      : { context: saved.limitContext ? 'model-default' : 'one-million' }),
    ...(saved.skipPermissions === undefined
      ? {}
      : { permissions: saved.skipPermissions ? 'bypass' : 'manual' }),
  });
  if (base.provider === 'opencode' && fast !== undefined && fast !== 'inherit')
    refuse('member-fast-mode-unconfigured');
  const cwd = runtimeCaptureCwd(source, member);
  if (!isAbsolute(cwd)) refuse('workspace-invalid');
  compiled = {
    ...compiled,
    cwd,
    principalId: `agent:${effectId('agent', launchId, member.memberId)}`,
    sessionId: effectId('session', launchId, member.memberId),
    generation: base.generation + 1,
    configRevision: `capture-${runtimeDigest({ source, memberId: member.memberId })}`,
  };
  const instructions = [settings.role && `Role: ${settings.role}`, settings.workflow]
    .filter(Boolean)
    .join('\n\n');
  if (compiled.provider === 'claude')
    compiled.nativeOptions = {
      ...compiled.nativeOptions,
      settingSources: captureClaudeSettingSources(compiled.nativeOptions?.settingSources),
      projectInstructions: {
        append: [compiled.nativeOptions?.projectInstructions?.append, instructions]
          .filter(Boolean)
          .join('\n\n'),
      },
    };
  else if (compiled.provider === 'codex')
    compiled.nativeOptions.developerInstructions = [
      compiled.nativeOptions.developerInstructions,
      instructions,
    ]
      .filter(Boolean)
      .join('\n\n');
  else
    compiled.nativeOptions.instructions = [compiled.nativeOptions.instructions, instructions]
      .filter(Boolean)
      .join('\n\n');
  return runtimeMemberProfileSchema.parse(compiled);
}

export function capturedTeam(
  team: HostedTeam,
  source: RuntimeCaptureSource,
  selected: TeamRuntimeCapture
): HostedTeam {
  return {
    owner: team.owner,
    connection: team.connection,
    ...(team.operatorPrincipalId === undefined
      ? {}
      : { operatorPrincipalId: team.operatorPrincipalId }),
    configurationRevision: selected.configurationRevision,
    launchId: selected.launchId,
    capture: JSON.parse(JSON.stringify(source)) as import('../contracts.js').JsonValue,
    definition: {
      ...structuredClone(team.definition),
      savedSettings: structuredClone(source.savedSettings),
      members: source.members.map((member) => ({
        memberId: member.memberId,
        name: member.name,
        role: member.role,
        settings: structuredClone(member.settings),
        delivery: structuredClone(
          selected.members.find((row) => row.memberId === member.memberId)!.delivery
        ),
      })),
      grants: selected.members.map((member) => ({
        principalId: member.principalId,
        memberName: source.members.find((row) => row.memberId === member.memberId)!.name,
        permissions: ['read', 'task.write', 'message.write', 'process.write'],
      })),
    },
  };
}

/** Technical identities depend on original Team/member/command, never on mutable workspace observations. */
export function runtimeCaptureRegistration(
  team: Pick<HostedTeam, 'definition'>,
  source: RuntimeCaptureSource
) {
  const launchId = effectId('team-launch', team.definition.binding.teamId, source.commandId);
  return {
    commandId: source.commandId,
    expectedRevision: source.configurationRevision,
    launchId,
    members: source.members.map((member) => ({
      memberId: member.memberId,
      principalId: `agent:${effectId('agent', launchId, member.memberId)}`,
      delivery: {
        ...team.definition.binding,
        runId: launchId,
        memberId: member.memberId,
        generation: `capture-${effectId('generation', launchId, member.memberId)}`,
      },
    })),
  };
}

export function runtimeCaptureCwd(
  source: {
    savedSettings: RuntimeCaptureSource['savedSettings'];
    worktrees?: RuntimeCaptureSource['worktrees'];
  },
  member: {
    memberId: string;
    role: 'lead' | 'member';
    settings: RuntimeCaptureSource['members'][number]['settings'];
  }
): string {
  return (
    source.worktrees?.find((row) => row.memberIds.includes(member.memberId))?.plan.targetPath ??
    (member.role === 'lead'
      ? source.savedSettings.cwd
      : (member.settings.cwd ?? source.savedSettings.cwd))
  );
}

function validateWorktreeMembers(source: RuntimeCaptureSource): void {
  const expected = source.members.filter(
    (member) =>
      member.settings.isolation === 'worktree' ||
      (source.savedSettings.worktree &&
        (member.role === 'lead' || member.settings.cwd === undefined))
  );
  const actual = source.worktrees?.flatMap((row) => row.memberIds) ?? [];
  if (actual.length && source.worktreeBindings?.length !== source.worktrees?.length)
    refuse('worktree-bindings-unprepared');
  if (
    actual.length !== expected.length ||
    expected.some((member) => !actual.includes(member.memberId))
  )
    refuse('worktree-capture-unprepared');
  for (const row of source.worktrees ?? [])
    if (
      row.memberIds.some(
        (id) =>
          source.members.find((member) => member.memberId === id)?.settings.isolation === 'worktree'
      ) &&
      row.memberIds.length !== 1
    )
      refuse('member-worktree-capture-invalid');
}

/** Actual-cwd private candidates for finite native catalog preparation, before final capture digests. */
export function runtimeCaptureRecipeCandidates(
  profile: TeamHostProfile,
  teamId: string,
  source: RuntimeCaptureSource
): RuntimeMemberProfile[] {
  const selected = runtimeCaptureBaseRecipes(profile, teamId, source);
  return source.mcpCaptureVersion === 1
    ? captureRuntimeMcp({
        recipes: selected,
        savedCwd: runtimeCaptureCwd(
          source,
          source.members.find((member) => member.role === 'lead')!
        ),
        members: source.members.map((member) => ({
          ...member,
          settings: {
            ...member.settings,
            cwd: runtimeCaptureCwd(source, member),
          },
        })),
      })
    : selected;
}

/** Trusted template and argv identity at the exact prepared cwd, before any MCP overlay. */
export function runtimeCaptureBaseRecipes(
  profile: TeamHostProfile,
  teamId: string,
  source: RuntimeCaptureSource
): RuntimeMemberProfile[] {
  return recipes(profile, teamId, {
    savedSettings: source.savedSettings,
    members: source.members,
    ...(source.worktrees ? { worktrees: source.worktrees } : {}),
  }).map((recipe, index) => ({
    ...recipe,
    cwd: runtimeCaptureCwd(source, source.members[index]!),
  }));
}
