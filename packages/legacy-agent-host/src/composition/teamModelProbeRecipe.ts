import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { resolveCapturedRuntimeRecipe, resolveRuntimeRecipe, runtimeProviderId } from './runtimeRecipe.js';
import { applyLaunchConfiguration } from './launchConfiguration.js';
import { selectedOpenCodeManagedLimits } from './openCodeManagedPreferences.js';
import { withOpenCodeModelLimits } from '../adapters/providers/withOpenCodeModelLimits.js';
import type { HostedTeam } from './MemberEntry.js';
import type { RuntimeMemberProfile, RuntimeProfile } from './runtimeProfile.js';
import type { TeamModelProbeSelection } from './teamLaunchModelProbe.js';
import type { RuntimeRecipeSources, RuntimeSourceReference } from './runtimeSourceContracts.js';

/** Model-only draft selection. It creates no roster, grants, capture or conversation bindings. */
export function resolveTeamModelProbeRecipe(options: {
  runtime: RuntimeProfile | undefined;
  team: HostedTeam;
  input: TeamModelProbeSelection;
  saved: RuntimeMemberProfile | undefined;
  sources?: RuntimeRecipeSources;
  sourceReference?: RuntimeSourceReference | undefined;
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
  const savedV1Preferences = sameProvider && saved.provider === 'opencode' &&
    saved.nativeGeneration !== 'v2' && saved.managedPreferences;
  if (sameProvider && (input.model === '__provider_default__' || input.effort === undefined || savedV1Preferences)) {
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
        ...(profile.provider === 'opencode'
          ? {
              endpoint: profile.endpoint,
              ...(profile.managedPreferences ? { managedPreferences: profile.managedPreferences } : {}),
              ...(profile.nativeGeneration === 'v2'
                ? {
                    nativeGeneration: profile.nativeGeneration,
                    protocolRevision: profile.protocolRevision,
                    ...(profile.embedded ? { embedded: {
                      version: profile.embedded.version,
                      directory: profile.embedded.directory,
                      manifestSha256: profile.embedded.manifestSha256,
                      platform: profile.embedded.platform,
                      arch: profile.embedded.arch,
                      externalDirectory: profile.embedded.externalDirectory,
                    } } : {
                      nativeProviderId: profile.nativeOptions.providerId,
                      model: profile.model,
                      nativeVariant: profile.nativeOptions.variant,
                    }),
                  }
                : {}),
            }
          : {}),
      });
    let expected = defaults;
    if (savedV1Preferences && saved.provider === 'opencode' && defaults.provider === 'opencode') {
      const modelId = `${saved.nativeOptions.providerId}/${saved.model}`;
      const limits = selectedOpenCodeManagedLimits(defaults.managedPreferences, modelId);
      if (limits) expected = withOpenCodeModelLimits(defaults, {
        providerId: saved.nativeOptions.providerId, modelId, limits,
      });
    }
    if (identity(expected) !== identity(saved))
      throw new TeamLaunchError('conflict', 'probe-default-recipe');
    // Rebase only a proven derived V1 limit overlay, so changing the selected
    // model never carries the previous model's application override forward.
    if (savedV1Preferences) recipe.environment = structuredClone(defaults.environment);
    // An externally owned old V2 session cannot change its pair. A fresh embedded
    // probe uses the original private default without rebinding the account/engine.
    if (input.model === '__provider_default__' &&
        !(recipe.provider === 'opencode' && recipe.nativeGeneration === 'v2' && !recipe.embedded))
      recipe.model = defaults.model;
    if (input.model === '__provider_default__' && recipe.provider === 'opencode' &&
        defaults.provider === 'opencode' &&
        (recipe.nativeGeneration !== 'v2' || (recipe.embedded && defaults.embedded))) {
      recipe.nativeOptions.providerId = defaults.nativeOptions.providerId;
      if (defaults.embedded) recipe.embedded = structuredClone(defaults.embedded);
      delete recipe.nativeOptions.variant;
      if (defaults.nativeOptions.variant !== undefined)
        recipe.nativeOptions.variant = defaults.nativeOptions.variant;
    }
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
      } else if (recipe.provider === 'opencode' && defaults.provider === 'opencode' &&
                 recipe.nativeGeneration !== 'v2') {
        delete recipe.nativeOptions.variant;
        if (defaults.nativeOptions.variant !== undefined)
          recipe.nativeOptions.variant = defaults.nativeOptions.variant;
      }
    }
  }
  function privateRecipe() {
    // A new member never borrows an existing member's native account/session.
    const seed = resolveRuntimeRecipe(
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
    const projectPath = roster.savedSettings?.cwd ?? team.definition.savedSettings?.cwd ?? seed.cwd;
    const reference = sameProvider ? options.sourceReference :
      options.sources?.currentForRecipe(team.definition.scope, projectPath, seed);
    return resolveCapturedRuntimeRecipe(seed, reference, team.definition.scope, projectPath, options.sources);
  }
  if (draft.workspace !== undefined) recipe.cwd = draft.workspace;
  return recipe;
}

export function applyTeamModelProbeSelection(
  recipe: RuntimeMemberProfile,
  input: TeamModelProbeSelection
) {
  return applyLaunchConfiguration(recipe, {
    // V2 Default is absence of an override, never a bare model selection.
    ...(input.model === '__provider_default__' &&
    recipe.provider === 'opencode' && recipe.nativeGeneration === 'v2'
      ? {}
      : { model: input.model === '__provider_default__' ? recipe.model : input.model }),
    // Preserve unchanged historical options; fresh embedded choices additionally
    // attest their named variant from the native catalog before creating a session.
    ...(input.effort === undefined ||
      (recipe.provider === 'opencode' && recipe.nativeGeneration === 'v2' &&
       input.effort === recipe.nativeOptions.variant) ? {} : { effort: input.effort }),
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}
