import { realpathSync, statSync } from 'node:fs';
import { digest, effectId } from '../team/identity.js';
import { teamRosterRevision } from '../team/rosterSchema.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { createTeamLaunchPreparationInputSchema } from '../team-registry/createLaunchContracts.js';
import { captureRuntimeSource, compileRuntimeCapture } from './runtimeCaptureSource.js';
import { teamModelProbeProfile, teamModelProbeEffort } from './teamLaunchModelProbe.js';
import type { TeamHostProfile } from './TeamHost.js';

/** Compile product intent with the existing launch mapper before any Team namespace exists. */
export function captureCreateTeamDraft(
  profile: TeamHostProfile,
  raw: unknown,
  validateWorkspace = true
) {
  const input = createTeamLaunchPreparationInputSchema.parse(raw);
  const { draft } = input;
  if (!profile.creation?.contextIds.includes(draft.contextId))
    throw new TeamLaunchError('forbidden', 'creation-context');
  const templates = profile.runtime?.providerTemplates ?? [];
  if (!templates.length) throw new TeamLaunchError('invalid', 'creation-provider-unconfigured');
  if (
    draft.members.some(({ name }) => Number(name.match(/-(\d+)$/)?.[1] ?? 0) >= 2)
  )
    throw new TeamLaunchError('invalid', 'creation-option-unconfigured');
  const draftDigest = digest({
    owner: profile.owner,
    principalId: profile.principalId,
    draft,
    templates,
  });
  const teamId = effectId('creation-preflight', draftDigest);
  const members = [
    {
      memberId: 'lead',
      name: 'team-lead',
      role: 'lead' as const,
      settings: {},
    },
    ...draft.members.map(({ name, memberSettings }) => ({
      memberId: effectId('creation-preflight-member', name),
      name,
      role: 'member' as const,
      settings: memberSettings,
    })),
  ];
  const definition = {
    binding: {
      backendId: profile.owner.ownerId,
      teamId,
      teamName: draft.teamName,
    },
    scope: {
      projectId: draft.contextId,
      workspaceId: draft.contextId,
      teamId,
      runId: 'preflight',
      memberId: 'user',
      generation: '1',
    },
    members,
    savedSettings: draft.savedSettings,
    grants: [],
  };
  // A draft may never borrow an existing member's account or conversation recipe.
  const explicit = {
    ...profile,
    runtime: { members: [], providerTemplates: templates },
  };
  const source = captureRuntimeSource(explicit, { definition }, 'preflight', 'preflight', {
    revision: teamRosterRevision(members, 0, draft.savedSettings),
    members,
    removedMembers: [],
    savedSettings: draft.savedSettings,
  });
  const compiled = compileRuntimeCapture(explicit, { definition }, source, 'model-preflight');
  const selections = compiled.profiles.map((row, index) => {
    const selected = row;
    const effort = teamModelProbeEffort(selected);
    const context = selected.provider === 'claude' ? selected.nativeOptions?.context : undefined;
    if (
      validateWorkspace &&
      (realpathSync(selected.cwd) !== selected.cwd || !statSync(selected.cwd).isDirectory())
    )
      throw new TeamLaunchError('invalid', 'creation-workspace');
    const template = templates.find((candidate) => candidate.provider === selected.provider);
    if (!template) throw new TeamLaunchError('invalid', 'creation-provider-unconfigured');
    const probeRecipe = structuredClone(template);
    probeRecipe.cwd = selected.cwd;
    if (
      probeRecipe.provider === 'claude' &&
      selected.provider === 'claude' &&
      selected.nativeOptions?.settingSources !== undefined
    )
      probeRecipe.nativeOptions = {
        ...probeRecipe.nativeOptions,
        settingSources: [...selected.nativeOptions.settingSources],
      };
    if (probeRecipe.provider === 'codex' && selected.provider === 'codex')
      probeRecipe.nativeOptions = structuredClone(selected.nativeOptions);
    if (probeRecipe.provider === 'opencode' && selected.provider === 'opencode')
      probeRecipe.nativeOptions = structuredClone(selected.nativeOptions);
    const probeProfile = teamModelProbeProfile(probeRecipe);
    const selection = {
      profile: probeProfile,
      providerId:
        selected.provider === 'claude'
          ? 'anthropic'
          : selected.provider === 'codex'
            ? 'codex'
            : selected.nativeOptions.providerId,
      model: selected.model,
      ...(effort === undefined ? {} : { effort }),
      ...(context === undefined ? {} : { context }),
    };
    return {
      memberName: members[index]!.name,
      selection,
      key: digest(selection),
    };
  });
  return { input, draftDigest, selections };
}
