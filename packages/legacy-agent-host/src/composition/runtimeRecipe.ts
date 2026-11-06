import { runtimeDigest } from '../runtime/identity.js';
import { effectId } from '../team/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeMemberProfileSchema } from './runtimeProfile.js';
import type { RuntimeMemberProfile, RuntimeProfile } from './runtimeProfile.js';
import type { TeamMemberSettings } from '../team/rosterContracts.js';

export const runtimeProviderId = (profile: RuntimeMemberProfile) =>
  profile.provider === 'claude' ? 'anthropic' : profile.provider;

/** Host-only recipe selection. A member's account never becomes another member's default. */
export function resolveRuntimeRecipe(
  runtime: RuntimeProfile | undefined,
  teamId: string,
  memberId: string,
  providerId?: TeamMemberSettings['providerId']
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
  if (!template)
    throw new TeamLaunchError(
      'invalid',
      existing ? 'runtime-recipe-provider-unconfigured' : 'runtime-recipe-unconfigured'
    );
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
