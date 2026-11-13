import { RuntimeSourceUnavailable } from './runtimeSourceGrantAuthority.js';
import { resolveRuntimeRecipe } from './runtimeRecipe.js';
import { runtimeCaptureCwd, runtimeCaptureSourceSchema } from './runtimeCaptureSource.js';

import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeCaptureSource } from './runtimeCaptureSource.js';
import type { RuntimeMemberProfile, RuntimeProfile } from './runtimeProfile.js';
import type { RuntimeRecipeSources, RuntimeSourceReference, RuntimeSourceTeamScope } from './runtimeSourceContracts.js';
import type { RuntimeSourceProcessOrigin } from './runtimeSourceProcessOrigin.js';
import type { ScheduledRunCapture } from './scheduledRunCapture.js';

/** Original reference and private recipe only. No current-source selection or persisted profile tag. */
export function captureRecipeProcessOrigin(options: {
  runtime: RuntimeProfile | undefined;
  sources?: RuntimeRecipeSources | undefined;
  reference?: RuntimeSourceReference | undefined;
  scope: RuntimeSourceTeamScope;
  projectPath: string;
  teamId: string;
  memberId: string;
  provider: RuntimeMemberProfile['provider'];
}): RuntimeSourceProcessOrigin | undefined {
  if (!options.reference) return undefined;
  const seed = resolveRuntimeRecipe(options.runtime, options.teamId, options.memberId,
    options.provider === 'claude' ? 'anthropic' : options.provider, true);
  if (!seed.windowsBroker) return undefined;
  if (!options.sources?.processOrigin) throw new RuntimeSourceUnavailable();
  return options.sources.processOrigin(options.reference, options.scope, options.projectPath, seed);
}

export function captureRuntimeSourceProcessOrigin(profile: TeamHostProfile,
  scope: RuntimeSourceTeamScope, teamId: string,
  source: Pick<RuntimeCaptureSource, 'savedSettings' | 'members' | 'recipeSources'>,
  member: Pick<RuntimeMemberProfile, 'memberId' | 'provider'>,
  sources?: RuntimeRecipeSources): RuntimeSourceProcessOrigin | undefined {
  const reference = source.recipeSources?.find(row => row.memberId === member.memberId);
  if (!reference) return undefined;
  const original = source.members.find(row => row.memberId === member.memberId);
  if (!original) throw new RuntimeSourceUnavailable();
  return captureRecipeProcessOrigin({ runtime: profile.runtime, sources, reference, scope,
    projectPath: runtimeCaptureCwd({ savedSettings: source.savedSettings }, original), teamId,
    memberId: member.memberId, provider: member.provider });
}

export function captureMemberProcessOrigin(profile: TeamHostProfile, entry: MemberEntry,
  sources?: RuntimeRecipeSources): RuntimeSourceProcessOrigin | undefined {
  if (!entry.profile.windowsBroker || entry.team.capture === undefined) return undefined;
  return captureRuntimeSourceProcessOrigin(profile, entry.team.definition.scope,
    entry.team.definition.binding.teamId, runtimeCaptureSourceSchema.parse(entry.team.capture),
    entry.profile, sources);
}

export function captureScheduledProcessOrigin(profile: TeamHostProfile, team: HostedTeam,
  capture: ScheduledRunCapture, sources?: RuntimeRecipeSources): RuntimeSourceProcessOrigin | undefined {
  return captureRecipeProcessOrigin({ runtime: profile.runtime, sources, reference: capture.source,
    scope: team.definition.scope, projectPath: capture.input.config.cwd,
    teamId: team.definition.binding.teamId, memberId: capture.memberId,
    provider: capture.input.config.providerId === 'codex' ? 'codex' : 'claude' });
}
