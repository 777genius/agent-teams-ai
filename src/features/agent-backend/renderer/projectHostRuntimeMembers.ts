import { projectHostMemberAttachmentCapabilities } from './projectHostMemberAttachmentCapabilities';

import type { BackendLaunchConfigurationView } from '../contracts/launch';
import type { BackendRosterConfiguration } from '../contracts/roster';
import type { HostTeamRuntimeState } from './createHostTeamLifecycle';
import type { TeamCreateRequest, TeamViewSnapshot } from '@shared/types/team';

type ConfiguredMember = BackendRosterConfiguration['members'][number];

/** The launch observations share their own revision; saved definition revisions are independent. */
function capturedSelection(
  member: ConfiguredMember,
  state: HostTeamRuntimeState | null,
  capture: BackendLaunchConfigurationView | null
) {
  if (
    !state ||
    !capture ||
    state.launch.launchId !== capture.launch.launchId ||
    state.launch.rosterRevision !== capture.launch.rosterRevision ||
    state.unknownMembers.includes(member.memberId)
  )
    return null;
  const original = state.launch.members.filter((row) => row.memberId === member.memberId);
  const observed = capture.launch.members.filter((row) => row.memberId === member.memberId);
  const selections = capture.members.filter(
    (row) =>
      row.memberId === member.memberId && row.label === member.name && row.role === member.role
  );
  if (
    original.length !== 1 ||
    observed.length !== 1 ||
    selections.length !== 1 ||
    original[0].generation !== observed[0].generation ||
    original[0].attemptId !== observed[0].attemptId
  )
    return null;
  return selections[0].selected;
}

/** Saved-only inheritance describes authored choices, without resolving any private/default recipe. */
function savedSelection(member: ConfiguredMember, saved: TeamCreateRequest | null) {
  const settings = member.role === 'lead' && saved ? saved : member.settings;
  const explicit = (model?: string) =>
    model && model !== '__provider_default__' ? model : undefined;
  const providerId = settings.providerId ?? saved?.providerId;
  const ownModel = explicit(settings.model);
  const inherits =
    saved?.syncModelsWithLead !== false &&
    providerId !== undefined &&
    providerId === saved?.providerId;
  return {
    providerId,
    providerBackendId: settings.providerBackendId,
    model: ownModel ?? (inherits ? explicit(saved?.model) : undefined),
    effort: settings.effort ?? (inherits && !ownModel ? saved?.effort : undefined),
    cwd: settings.cwd ?? saved?.cwd,
    resolvedFastMode: undefined,
  };
}

/** Caller fences the product/roster and both launch observations before exposing this view. */
export function projectHostRuntimeMembers(input: {
  result: TeamViewSnapshot;
  configuration: BackendRosterConfiguration;
  saved: TeamCreateRequest | null;
  state: HostTeamRuntimeState | null;
  capture: BackendLaunchConfigurationView | null;
  neverLaunched: boolean;
}) {
  const { result, configuration, saved, state, capture } = input;
  const configuredMembers = [
    ...configuration.members,
    ...configuration.removedMembers.map((member) => ({
      ...member,
      role: 'member' as const,
      settingsFingerprint: undefined,
    })),
  ];
  const selectedMembers = new Set<string>();
  let unavailable = false;
  const settings = configuredMembers.map((member) => {
    const removed = 'removedAt' in member;
    const configured = {
      ...member.settings,
      ...(member.role === 'lead' && saved
        ? {
            cwd: saved.cwd,
            providerId: saved.providerId,
            model: saved.model,
            effort: saved.effort,
            fastMode: saved.fastMode,
            providerBackendId: saved.providerBackendId,
          }
        : {}),
    };
    const selected = removed ? null : capturedSelection(member, state, capture);
    if (selected) selectedMembers.add(member.memberId);
    else if (!removed && !(input.neverLaunched && !state)) unavailable = true;
    const effective = selected
      ? {
          providerId: selected.provider === 'claude' ? ('anthropic' as const) : selected.provider,
          // An unqualified native ID can look like a different public provider's model.
          model: selected.provider === 'opencode' ? selected.qualifiedModel : selected.model,
          providerBackendId: undefined,
          effort: selected.effort,
          cwd: selected.workspace,
          resolvedFastMode: selected.fastMode,
        }
      : !removed && input.neverLaunched && !state
        ? savedSelection(member, saved)
        : {
            providerId: undefined,
            model: undefined,
            providerBackendId: undefined,
            effort: undefined,
            cwd: undefined,
            resolvedFastMode: undefined,
          };
    const authored = {
      ...configured,
      name: member.name,
      hostMemberId: member.memberId,
      configuredSettingsFingerprint: member.settingsFingerprint,
      selectedFastMode: configured.fastMode,
      configuredRuntimeSettings: {
        providerId: configured.providerId,
        providerBackendId: configured.providerBackendId,
        model: configured.model,
        effort: configured.effort,
        fastMode: configured.fastMode,
      },
    };
    return { name: member.name, authored, runtime: { ...authored, ...effective } };
  });
  const withSettings = <T extends { name: string }>(member: T): T => ({
    ...member,
    ...settings.find((row) => row.name === member.name)?.runtime,
  });
  const members = [
    ...result.members,
    ...configuration.removedMembers.map((member) => ({
      name: member.name,
      runtimeOwner: 'captured-host' as const,
      role: 'member',
      agentType: 'general-purpose',
      removedAt: Date.parse(member.removedAt),
      taskCount: result.tasks.filter(
        (task) => task.owner === member.name && task.status !== 'deleted'
      ).length,
      currentTaskId: null,
    })),
  ].map(withSettings);
  return {
    configMembers: result.config.members?.map((member) => ({
      ...member,
      ...settings.find((row) => row.name === member.name)?.authored,
    })),
    members: projectHostMemberAttachmentCapabilities(
      members,
      {
        ...configuration,
        members: configuration.members.filter((member) => selectedMembers.has(member.memberId)),
      },
      state && capture ? { ...state, launch: capture.launch } : null
    ),
    unavailable,
  };
}
