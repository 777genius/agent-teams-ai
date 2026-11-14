import { runtimeDigest } from '../runtime/identity.js';
import { effectId } from '../team/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeMemberProfileSchema } from './runtimeProfile.js';
import { RuntimeSourceUnavailable } from './runtimeSourceGrantAuthority.js';
import type { RuntimeMemberProfile, RuntimeProfile } from './runtimeProfile.js';
import type { TeamMemberSettings } from '../team/rosterContracts.js';
import type { RuntimeRecipeSources, RuntimeSourceReference, RuntimeSourceTeamScope } from './runtimeSourceContracts.js';

export const runtimeProviderId = (profile: RuntimeMemberProfile) =>
  profile.provider === 'claude' ? 'anthropic' : profile.provider;

/** A missing reference is the original seed, including after the current selection changes. */
export function resolveCapturedRuntimeRecipe(recipe: RuntimeMemberProfile, reference: RuntimeSourceReference | undefined,
  scope: RuntimeSourceTeamScope | undefined, projectPath: string, sources?: RuntimeRecipeSources): RuntimeMemberProfile {
  if (!reference) return recipe;
  if (!sources || !scope) throw new TeamLaunchError('hold', 'runtime-source-unavailable');
  return sources.resolveRecipe(reference, scope, projectPath, recipe);
}

/** Host-only recipe selection. A member's account never becomes another member's default. */
export function resolveRuntimeRecipe(
  runtime: RuntimeProfile | undefined,
  teamId: string,
  memberId: string,
  providerId?: TeamMemberSettings['providerId'],
  restoring = false
): RuntimeMemberProfile {
  const exact =
    runtime?.members.filter((row) => row.teamId === teamId && row.memberId === memberId) ?? [];
  if (exact.length > 1) throw new TeamLaunchError('invalid', 'runtime-recipe-ambiguous');
  const existing = exact[0];
  if (existing && (providerId === undefined || providerId === runtimeProviderId(existing)))
    return structuredClone(existing);
  const templates =
    runtime?.providerTemplates?.filter((row) => runtimeProviderId(row) === providerId) ?? [];
  if (templates.length > 1) throw new TeamLaunchError('invalid', 'runtime-template-ambiguous');
  const template = templates[0];
  if (!template) {
    // Only a structurally validated retained restore may isolate a missing private recipe.
    if (restoring) throw new RuntimeSourceUnavailable();
    throw new TeamLaunchError(
      'invalid',
      existing ? 'runtime-recipe-provider-unconfigured' : 'runtime-recipe-unconfigured'
    );
  }
  // A fresh member cannot adopt a template author's existing native conversation.
  if (template.provider === 'opencode' && template.nativeSessionId !== undefined)
    throw new TeamLaunchError('invalid', 'runtime-template-session-unconfigured');
  const selection = effectId('runtime-template', teamId, memberId, runtimeDigest(template));
  return runtimeMemberProfileSchema.parse({
    ...structuredClone(template),
    teamId,
    memberId,
    principalId: `agent:${selection}`,
    sessionId: effectId('session', selection),
    configRevision: `template-${selection}`,
  });
}
