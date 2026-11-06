import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { resolveRuntimeRecipe, runtimeProviderId } from './runtimeRecipe.js';
import { applyLaunchConfiguration } from './launchConfiguration.js';
import type { HostedTeam } from './MemberEntry.js';
import type { RuntimeMemberProfile, RuntimeProfile } from './runtimeProfile.js';
import type { TeamModelProbeSelection } from './teamLaunchModelProbe.js';

/** Model-only draft selection. It creates no roster, grants, capture or conversation bindings. */
export function resolveTeamModelProbeRecipe(options: {
  runtime: RuntimeProfile | undefined;
  team: HostedTeam;
  input: TeamModelProbeSelection;
  saved: RuntimeMemberProfile | undefined;
}): RuntimeMemberProfile {
  const { input, saved, team } = options;
  const draft = input.draft;
  if (!draft) {
    if (!saved) throw new TeamLaunchError('invalid', 'probe-member');
    return saved;
  }
  const desiredProviderId = draft.providerId;
  const roster = team.connection.readRoster();
  const target = draft.target;
  const row =
    target.kind === 'lead'
      ? roster.members.find((member) => member.role === 'lead')
      : roster.members.find(
          (member) =>
            member.role === 'member' && member.name === (target.originalName ?? target.name)
        );
  if (
    row
      ? row.memberId !== input.memberId
      : target.kind !== 'member' ||
        target.originalName !== undefined ||
        input.memberId !== `draft:${target.name}` ||
        roster.members.some((member) => member.memberId === input.memberId)
  )
    throw new TeamLaunchError('conflict', 'probe-draft-target');
  const sameProvider = saved && runtimeProviderId(saved) === draft.providerId;
  const recipe = sameProvider ? structuredClone(saved) : privateRecipe();
  if (sameProvider && (input.model === '__provider_default__' || input.effort === undefined)) {
    const defaults = privateRecipe();
    const identity = (profile: RuntimeMemberProfile) =>
      runtimeDigest({
        provider: profile.provider,
        accountBinding: profile.accountBinding,
        executable: profile.executable,
        environment: profile.environment,
        ...(profile.provider === 'claude' ? { configNamespace: profile.configNamespace } : {}),
        ...(profile.provider === 'codex'
          ? { modelProvider: profile.nativeOptions.modelProvider }
          : {}),
        ...(profile.provider === 'opencode' ? { endpoint: profile.endpoint } : {}),
      });
    if (identity(defaults) !== identity(saved))
      throw new TeamLaunchError('conflict', 'probe-default-recipe');
    if (input.model === '__provider_default__') recipe.model = defaults.model;
    // Default resets only the requested application override. Other selected
    // native settings and the captured account/namespace remain unchanged.
    if (input.effort === undefined) {
      if (recipe.provider === 'claude' && defaults.provider === 'claude') {
        recipe.nativeOptions = { ...recipe.nativeOptions };
        delete recipe.nativeOptions.effort;
        if (defaults.nativeOptions?.effort !== undefined)
          recipe.nativeOptions.effort = defaults.nativeOptions.effort;
      } else if (recipe.provider === 'codex' && defaults.provider === 'codex') {
        delete recipe.nativeOptions.reasoningEffort;
        if (defaults.nativeOptions.reasoningEffort !== undefined)
          recipe.nativeOptions.reasoningEffort = defaults.nativeOptions.reasoningEffort;
      } else if (recipe.provider === 'opencode' && defaults.provider === 'opencode') {
        delete recipe.nativeOptions.variant;
        if (defaults.nativeOptions.variant !== undefined)
          recipe.nativeOptions.variant = defaults.nativeOptions.variant;
      }
    }
  }
  function privateRecipe() {
    // A new member never borrows an existing member's native account/session.
    return resolveRuntimeRecipe(
      row
        ? options.runtime
        : {
            members: [],
            ...(options.runtime?.providerTemplates === undefined
              ? {}
              : { providerTemplates: options.runtime.providerTemplates }),
          },
      team.definition.binding.teamId,
      input.memberId,
      desiredProviderId
    );
  }
  if (draft.workspace !== undefined) recipe.cwd = draft.workspace;
  return recipe;
}

export function applyTeamModelProbeSelection(
  recipe: RuntimeMemberProfile,
  input: TeamModelProbeSelection
) {
  return applyLaunchConfiguration(recipe, {
    model: input.model === '__provider_default__' ? recipe.model : input.model,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}
