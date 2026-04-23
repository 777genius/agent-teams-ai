import { buildPlannedMemberLaneIdentity } from '@features/team-runtime-lanes';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import {
  createCliAutoSuffixNameGuard,
  createCliProvisionerNameGuard,
} from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { getStableTeamOwnerId } from '@shared/utils/teamStableOwnerId';

import type {
  PersistedTeamLaunchSnapshot,
  TeamConfig,
  TeamMember,
  TeamMemberSnapshot,
  TeamProviderBackendId,
  TeamProviderId,
  TeamTaskWithKanban,
} from '@shared/types';

const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const CROSS_TEAM_TOOL_RECIPIENT_NAMES = new Set([
  'cross_team_send',
  'cross_team_list_targets',
  'cross_team_get_outbox',
]);
const GENERATED_AGENT_ID_PATTERN = /^a[0-9a-f]{16}$/i;

function looksLikeQualifiedExternalRecipient(name: string): boolean {
  const trimmed = name.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return false;
  const teamName = trimmed.slice(0, dot).trim();
  const memberName = trimmed.slice(dot + 1).trim();
  return TEAM_NAME_PATTERN.test(teamName) && memberName.length > 0;
}

function looksLikeCrossTeamPseudoRecipient(name: string): boolean {
  const trimmed = name.trim();
  const prefixes = [
    'cross_team::',
    'cross_team--',
    'cross-team:',
    'cross-team-',
    'cross_team:',
    'cross_team-',
  ];
  for (const prefix of prefixes) {
    if (!trimmed.startsWith(prefix)) continue;
    const teamName = trimmed.slice(prefix.length).trim();
    if (TEAM_NAME_PATTERN.test(teamName)) {
      return true;
    }
  }
  return false;
}

function looksLikeCrossTeamToolRecipient(name: string): boolean {
  return CROSS_TEAM_TOOL_RECIPIENT_NAMES.has(name.trim());
}

function looksLikeGeneratedAgentId(name: string): boolean {
  return GENERATED_AGENT_ID_PATTERN.test(name.trim());
}

export class TeamMemberResolver {
  resolveMembers(
    config: TeamConfig,
    metaMembers: TeamConfig['members'],
    inboxNames: string[],
    tasks: TeamTaskWithKanban[],
    options?: {
      launchSnapshot?: PersistedTeamLaunchSnapshot | null;
      leadProviderId?: TeamProviderId;
      leadProviderBackendId?: TeamProviderBackendId | null;
      leadFastMode?: TeamMember['fastMode'];
      leadResolvedFastMode?: boolean | null;
    }
  ): TeamMemberSnapshot[] {
    const names = new Set<string>();
    const explicitNames = new Set<string>();
    const seenNames = new Set<string>();
    const addName = (name: string): void => {
      const normalized = name.toLowerCase();
      if (seenNames.has(normalized)) {
        return;
      }
      seenNames.add(normalized);
      names.add(name);
    };

    if (Array.isArray(config.members)) {
      for (const member of config.members) {
        if (typeof member?.name === 'string' && member.name.trim() !== '') {
          const trimmed = member.name.trim();
          addName(trimmed);
          explicitNames.add(trimmed.toLowerCase());
        }
      }
    }

    if (Array.isArray(metaMembers)) {
      for (const member of metaMembers) {
        if (typeof member?.name === 'string' && member.name.trim() !== '') {
          const trimmed = member.name.trim();
          addName(trimmed);
          explicitNames.add(trimmed.toLowerCase());
        }
      }
    }

    const launchSnapshot = options?.launchSnapshot;
    if (launchSnapshot) {
      for (const name of launchSnapshot.expectedMembers) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        addName(trimmed);
        explicitNames.add(trimmed.toLowerCase());
      }
      for (const name of Object.keys(launchSnapshot.members)) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        addName(trimmed);
        explicitNames.add(trimmed.toLowerCase());
      }
    }

    for (const inboxName of inboxNames) {
      if (typeof inboxName === 'string' && inboxName.trim() !== '') {
        const trimmed = inboxName.trim();
        if (
          looksLikeCrossTeamPseudoRecipient(trimmed) ||
          looksLikeCrossTeamToolRecipient(trimmed)
        ) {
          continue;
        }
        if (
          !explicitNames.has(trimmed.toLowerCase()) &&
          looksLikeQualifiedExternalRecipient(trimmed)
        ) {
          continue;
        }
        if (!explicitNames.has(trimmed.toLowerCase()) && looksLikeGeneratedAgentId(trimmed)) {
          continue;
        }
        addName(trimmed);
      }
    }

    const configMemberMap = new Map<
      string,
      {
        agentId?: string;
        agentType?: string;
        role?: string;
        workflow?: string;
        isolation?: 'worktree';
        providerId?: TeamProviderId;
        providerBackendId?: TeamProviderBackendId;
        model?: string;
        effort?: TeamMember['effort'];
        fastMode?: TeamMember['fastMode'];
        color?: string;
        cwd?: string;
      }
    >();
    if (Array.isArray(config.members)) {
      for (const m of config.members) {
        if (typeof m?.name === 'string' && m.name.trim() !== '') {
          const configMember = m as TeamMember & { provider?: TeamProviderId };
          const providerId =
            normalizeOptionalTeamProviderId(configMember.providerId) ??
            normalizeOptionalTeamProviderId(configMember.provider);
          configMemberMap.set(m.name.trim(), {
            agentId: configMember.agentId,
            agentType: configMember.agentType,
            role: configMember.role,
            workflow: configMember.workflow,
            isolation: configMember.isolation === 'worktree' ? ('worktree' as const) : undefined,
            providerId,
            providerBackendId: migrateProviderBackendId(providerId, configMember.providerBackendId),
            model: configMember.model,
            effort: configMember.effort,
            fastMode:
              configMember.fastMode === 'inherit' ||
              configMember.fastMode === 'on' ||
              configMember.fastMode === 'off'
                ? configMember.fastMode
                : undefined,
            color: configMember.color,
            cwd: configMember.cwd,
          });
        }
      }
    }

    const metaMemberMap = new Map<
      string,
      {
        agentId?: string;
        agentType?: string;
        role?: string;
        workflow?: string;
        isolation?: 'worktree';
        providerId?: TeamProviderId;
        providerBackendId?: TeamProviderBackendId;
        model?: string;
        effort?: TeamMember['effort'];
        fastMode?: TeamMember['fastMode'];
        color?: string;
        cwd?: string;
        removedAt?: number;
      }
    >();
    if (Array.isArray(metaMembers)) {
      for (const member of metaMembers) {
        if (typeof member?.name === 'string' && member.name.trim() !== '') {
          metaMemberMap.set(member.name.trim(), {
            agentId: member.agentId,
            agentType: member.agentType,
            role: member.role,
            workflow: member.workflow,
            isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
            providerId: member.providerId,
            providerBackendId: migrateProviderBackendId(
              member.providerId,
              member.providerBackendId
            ),
            model: member.model,
            effort: member.effort,
            fastMode:
              member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
                ? member.fastMode
                : undefined,
            color: member.color,
            cwd: member.cwd,
            removedAt: member.removedAt,
          });
        }
      }
    }

    const launchMemberMap = new Map<
      string,
      NonNullable<NonNullable<typeof launchSnapshot>['members'][string]>
    >();
    if (launchSnapshot) {
      for (const [memberName, member] of Object.entries(launchSnapshot.members)) {
        if (typeof memberName === 'string' && memberName.trim().length > 0 && member) {
          launchMemberMap.set(memberName.trim(), member);
        }
      }
    }

    // "user" is a built-in pseudo-member in Claude Code's team framework
    // (recipient of SendMessage to "user"). It's not a real AI teammate.
    names.delete('user');

    // Defense: merge inbox-derived "lead" alias into canonical "team-lead".
    // Teammates sometimes address messages to "lead" instead of "team-lead",
    // creating a separate inbox file that the resolver picks up as a phantom member.
    if (names.has('lead') && names.has('team-lead')) {
      names.delete('lead');
    }

    // Defense: hide CLI auto-suffixed duplicates (alice-2) only when the base
    // name still exists as an active member. Removed base members must not hide
    // active suffixed teammates after live mutation / rollback flows.
    const activeNamesForAutoSuffix = Array.from(names).filter((name) => {
      return !metaMemberMap.get(name)?.removedAt;
    });
    const keepName = createCliAutoSuffixNameGuard(activeNamesForAutoSuffix);
    // Defense: hide CLI provisioner artifacts (alice-provisioner) when base name (alice) exists.
    const keepProvisioner = createCliProvisionerNameGuard(names);
    for (const name of Array.from(names)) {
      if (!keepName(name) || !keepProvisioner(name)) {
        names.delete(name);
      }
    }

    const members: TeamMemberSnapshot[] = [];
    for (const name of names) {
      const ownedTasks = tasks.filter((task) => task.owner === name);
      const currentTask =
        ownedTasks.find(
          (task) =>
            task.status === 'in_progress' &&
            task.reviewState !== 'approved' &&
            task.kanbanColumn !== 'approved'
        ) ?? null;
      const configMember = configMemberMap.get(name);
      const metaMember = metaMemberMap.get(name);
      const launchMember = launchMemberMap.get(name);
      const effectiveProviderId =
        launchMember?.providerId ??
        configMember?.providerId ??
        metaMember?.providerId ??
        options?.leadProviderId;
      const plannedLane = buildPlannedMemberLaneIdentity({
        leadProviderId: options?.leadProviderId,
        member: {
          name,
          providerId: effectiveProviderId,
        },
      });
      const providerBackendId =
        launchMember?.providerBackendId ??
        configMember?.providerBackendId ??
        metaMember?.providerBackendId ??
        (effectiveProviderId === options?.leadProviderId
          ? (options?.leadProviderBackendId ?? undefined)
          : undefined);
      const agentId = configMember?.agentId ?? metaMember?.agentId;
      members.push({
        name,
        agentId,
        currentTaskId: currentTask?.id ?? null,
        taskCount: ownedTasks.length,
        color: configMember?.color ?? metaMember?.color ?? getMemberColorByName(name),
        agentType: configMember?.agentType ?? metaMember?.agentType,
        role: configMember?.role ?? metaMember?.role,
        workflow: configMember?.workflow ?? metaMember?.workflow,
        isolation: configMember?.isolation ?? metaMember?.isolation,
        providerId: effectiveProviderId,
        providerBackendId,
        model: launchMember?.model ?? configMember?.model ?? metaMember?.model,
        effort: launchMember?.effort ?? configMember?.effort ?? metaMember?.effort,
        selectedFastMode:
          launchMember?.selectedFastMode ??
          configMember?.fastMode ??
          metaMember?.fastMode ??
          (effectiveProviderId === options?.leadProviderId
            ? (options?.leadFastMode ?? undefined)
            : undefined),
        resolvedFastMode:
          typeof launchMember?.resolvedFastMode === 'boolean'
            ? launchMember.resolvedFastMode
            : effectiveProviderId === options?.leadProviderId
              ? (options?.leadResolvedFastMode ?? undefined)
              : undefined,
        laneId: launchMember?.laneId ?? plannedLane.laneId,
        laneKind: launchMember?.laneKind ?? plannedLane.laneKind,
        laneOwnerProviderId: launchMember?.laneOwnerProviderId ?? plannedLane.laneOwnerProviderId,
        cwd: configMember?.cwd ?? metaMember?.cwd,
        removedAt: metaMember?.removedAt,
      });
    }

    const explicitConfigOrder = new Map<string, number>();
    for (const [index, member] of config.members?.entries() ?? []) {
      const stableOwnerId = getStableTeamOwnerId(member);
      explicitConfigOrder.set(stableOwnerId, index);
      explicitConfigOrder.set(member.name, index);
    }

    members.sort((a, b) => {
      const aStableId = getStableTeamOwnerId(a);
      const bStableId = getStableTeamOwnerId(b);
      const aConfigIndex =
        explicitConfigOrder.get(aStableId) ??
        explicitConfigOrder.get(a.name) ??
        Number.POSITIVE_INFINITY;
      const bConfigIndex =
        explicitConfigOrder.get(bStableId) ??
        explicitConfigOrder.get(b.name) ??
        Number.POSITIVE_INFINITY;
      if (aConfigIndex !== bConfigIndex) {
        return aConfigIndex - bConfigIndex;
      }
      return aStableId.localeCompare(bStableId);
    });

    const colorMap = buildTeamMemberColorMap(members, { preferProvidedColors: false });
    return members.map((member) => ({
      ...member,
      color: colorMap.get(member.name) ?? member.color ?? getMemberColorByName(member.name),
    }));
  }
}
