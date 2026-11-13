import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { selectedLaunchConfiguration } from './executeTeamLaunch.js';
import {
  resolveTeamModelProbeRecipe,
  applyTeamModelProbeSelection,
} from './teamModelProbeRecipe.js';
import { captureRuntimeSource, compileRuntimeCapture, runtimeCaptureCwd, runtimeCaptureSourceSchema } from './runtimeCaptureSource.js';
import {
  captureTeamModelProbe,
  teamModelProbeProfile,
  teamModelProbeEffort,
  teamModelProbeContext,
} from './teamLaunchModelProbe.js';
import { assertCapturedRosterCurrent, isUnstartedCaptureEditable } from './teamRoster.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
import type { RuntimeSourceProcessOrigin } from './runtimeSourceProcessOrigin.js';
import type { TeamModelProbeSelection } from './teamLaunchModelProbe.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RetainedLaunchInspection } from './teamRoster.js';

const prefix = 'saved-model-';
export const isSavedTeamModelSource = (sourceId: string) => sourceId.startsWith(prefix);
export const savedTeamModelContext = teamModelProbeContext;
type Options = {
  profile: TeamHostProfile;
  sources?: RuntimeRecipeSources;
  team: HostedTeam;
  assertCurrent(): void;
  assertRuntimeHistory?(): void;
};

/** Model-only compilation of saved choices; retained history requires its original offline proof. */
function source(options: Options) {
  options.assertCurrent();
  const { profile, team } = options;
  const authority = team.owner.withLaunchAuthority(
    profile.principalId,
    'read',
    (revision) => revision
  );
  if (
    team.owner.runtimeCaptures(profile.principalId).length ||
    team.definition.members.some((member) => member.delivery)
  ) {
    if (!options.assertRuntimeHistory) throw new TeamLaunchError('hold', 'saved-model-runtime-history');
    options.assertRuntimeHistory();
  }
  const roster = team.connection.readRoster();
  const captured = captureRuntimeSource(
    profile,
    team,
    'model-preflight',
    'model-preflight',
    roster,
    options.sources ? { sources: options.sources } : {}
  );
  const compiled = compileRuntimeCapture(profile, team, captured, 'model-preflight', options.sources);
  const sourceId = `${prefix}${runtimeDigest({ owner: profile.owner, authority, captured })}`;
  options.assertCurrent();
  return { sourceId, captured, profiles: compiled.profiles };
}

export function readSavedTeamModelConfiguration(options: Options): JsonValue {
  const saved = source(options);
  return JSON.parse(
    JSON.stringify({
      source: {
        sourceId: saved.sourceId,
        rosterRevision: saved.captured.configurationRevision,
      },
      members: saved.captured.members.map((member, index) => ({
        memberId: member.memberId,
        label: member.name,
        role: member.role,
        selected: selectedLaunchConfiguration(
          saved.profiles[index]!,
          member.role === 'lead' || member.settings.cwd === undefined
        ),
      })),
    })
  ) as JsonValue;
}

export function modelConfigurationFromLaunch(value: JsonValue): JsonValue {
  const view = value as {
    launch: { launchId: string; rosterRevision: string };
    members: JsonValue;
  };
  return {
    source: {
      sourceId: view.launch.launchId,
      rosterRevision: view.launch.rosterRevision,
    },
    members: view.members,
  };
}

export function captureSavedTeamModelProbe(
  options: Options & {
    input: TeamModelProbeSelection;
    action: 'start' | 'read' | 'cancel';
  }
) {
  const { team, profile, input, action } = options;
  options.assertCurrent();
  const context = savedTeamModelContext(team.definition.binding.teamId, input);
  if (action === 'cancel' && isSavedTeamModelSource(input.launchId))
    // Cleanup survives operator revocation but can only reach the journal's exact
    // original context under the current owner/lease. It cannot resolve a new
    // roster/template/account or admit/read another probe.
    return {
      profile: null,
      context,
      model: input.model,
      effort: input.effort,
      modelContext: input.context,
      isCurrent: () => false,
    };
  team.owner.withLaunchAuthority(
    profile.principalId,
    action === 'start' ? 'control' : 'read',
    () => undefined
  );
  const saved = source(options);
  if (
    input.launchId !== saved.sourceId ||
    input.rosterRevision !== saved.captured.configurationRevision
  )
    throw new TeamLaunchError('conflict', 'saved-model-source');
  let processOrigin: RuntimeSourceProcessOrigin | undefined;
  const savedMember = saved.captured.members.find(member => member.memberId === input.memberId);
  const recipe = (captureOrigin = false) =>
    resolveTeamModelProbeRecipe({
      runtime: profile.runtime,
      team,
      input,
      saved: saved.profiles.find((member) => member.memberId === input.memberId),
      ...(options.sources ? { sources: options.sources } : {}),
      sourceReference: saved.captured.recipeSources?.find(reference => reference.memberId === input.memberId),
      sourceProjectPath: savedMember ? runtimeCaptureCwd({ savedSettings: saved.captured.savedSettings }, savedMember) : undefined,
      ...(captureOrigin ? { onProcessOrigin: (value: RuntimeSourceProcessOrigin | undefined) => { processOrigin = value; } } : {}),
    });
  const selected = recipe(true);
  const selectionDigest = runtimeDigest(selected);
  const effective = applyTeamModelProbeSelection(selected, input);
  const current = () => {
    try {
      team.owner.withLaunchAuthority(
        profile.principalId,
        action === 'start' ? 'control' : 'read',
        () => undefined
      );
      return (
        source(options).sourceId === saved.sourceId && runtimeDigest(recipe()) === selectionDigest
      );
    } catch {
      return false;
    }
  };
  return {
    profile: teamModelProbeProfile(effective.provider === 'claude' ? selected : effective),
    ...(processOrigin ? { processOrigin } : {}),
    context,
    model: effective.model,
    providerId:
      effective.provider === 'claude'
        ? 'anthropic'
        : effective.provider === 'codex'
          ? 'codex'
          : effective.nativeOptions.providerId,
    effort: teamModelProbeEffort(effective),
    modelContext: effective.provider === 'claude' ? effective.nativeOptions?.context : undefined,
    isCurrent: current,
  };
}

export function isCurrentCapturedTeam(team: HostedTeam | undefined): boolean {
  if (!team) return false;
  try {
    assertCapturedRosterCurrent(team);
    return true;
  } catch {
    return false;
  }
}

/** The Runtime coordinator supplies its exact owners; saved inspection never becomes a capture. */
export function captureTeamModelProbeSelection(options: {
  profile: TeamHostProfile;
  sources?: RuntimeRecipeSources;
  team: HostedTeam | undefined;
  capturedTeam: HostedTeam | undefined;
  launch: TeamLaunchOwner | undefined;
  entries: readonly MemberEntry[];
  runtime: RuntimeOwner;
  retainedLaunches: ReadonlyMap<string, RetainedLaunchInspection>;
  input: TeamModelProbeSelection;
  action: 'start' | 'read' | 'cancel';
  assertCurrent(): void;
}) {
  options.assertCurrent();
  const { capturedTeam: team, launch, action, input } = options;
  if (action === 'cancel' && input.draft) {
    const original = options.team ?? team;
    if (!original) throw new TeamLaunchError('invalid', 'team');
    return {
      profile: null,
      context: teamModelProbeContext(original.definition.binding.teamId, input),
      model: input.model,
      effort: input.effort,
      modelContext: input.context,
      isCurrent: () => false,
    };
  }
  if (!team || !launch || isSavedTeamModelSource(input.launchId)) {
    if (!options.team) throw new TeamLaunchError('invalid', 'team');
    return captureSavedTeamModelProbe({ ...options, team: options.team,
      assertRuntimeHistory: () => {
        if (!isUnstartedCaptureEditable({ ...options, team: options.capturedTeam }))
          throw new TeamLaunchError('hold', 'saved-model-runtime-history');
      } });
  }
  if (action !== 'cancel') assertCapturedRosterCurrent(team);
  const source = team.capture === undefined ? undefined : runtimeCaptureSourceSchema.parse(team.capture);
  const sourceMember = source?.members.find(member => member.memberId === input.memberId);
  return captureTeamModelProbe({
    launch,
    team,
    runtime: options.profile.runtime,
    ...(options.sources ? { sources: options.sources } : {}),
    sourceReference: source?.recipeSources?.find(reference => reference.memberId === input.memberId),
    sourceProjectPath: source && sourceMember ? runtimeCaptureCwd({ savedSettings: source.savedSettings }, sourceMember) : undefined,
    input,
    action,
    principalId: options.profile.principalId,
    entries: options.entries.filter((entry) => entry.team === team),
    assertCurrent: options.assertCurrent,
  });
}
