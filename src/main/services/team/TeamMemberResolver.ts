import { buildPlannedMemberLaneIdentity } from '@features/team-runtime-lanes';
import { getMemberColorByName } from '@shared/constants/memberColors';
import {
  isLeadMember,
  isReservedLeadRole,
  normalizeTeamMemberRole,
} from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import {
  createCliAutoSuffixNameGuard,
  createCliProvisionerNameGuard,
} from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { getStableTeamOwnerId } from '@shared/utils/teamStableOwnerId';

import { selectCurrentActiveTeamTask } from './teamTaskActiveState';

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

function isCanonicalLeadMember(member: {
  name: string;
  agentType?: string;
  role?: string;
}): boolean {
  if (isLeadMember(member)) return true;
  if (member.agentType?.trim()) return false;
  const normalizedName = member.name.trim().toLowerCase();
  const normalizedRole = normalizeTeamMemberRole(member.role ?? '');
  return (
    isReservedLeadRole(normalizedRole) && (normalizedRole !== 'lead' || normalizedName === 'lead')
  );
}

export function isMaterializableInboxMemberName(
  name: string,
  explicitNames: ReadonlySet<string>
): boolean {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  if (!trimmed) return false;
  if (looksLikeCrossTeamPseudoRecipient(trimmed) || looksLikeCrossTeamToolRecipient(trimmed)) {
    return false;
  }
  if (explicitNames.has(normalized)) return true;
  return !looksLikeQualifiedExternalRecipient(trimmed) && !looksLikeGeneratedAgentId(trimmed);
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
      leadRuntimeSettings?: Pick<
        TeamMemberSnapshot,
        'model' | 'effort' | 'configuredRuntimeSettings' | 'resolvedFastMode'
      >;
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
        if (!isMaterializableInboxMemberName(trimmed, explicitNames)) {
          continue;
        }
        addName(trimmed);
      }
    }

    const configMemberMap = new Map<
      string,
      {
        agentId?: string;
        joinedAt?: number;
        agentType?: string;
        role?: string;
        workflow?: string;
        isolation?: 'worktree';
        providerId?: TeamProviderId;
        providerBackendId?: TeamProviderBackendId;
        configuredProviderBackendId?: TeamProviderBackendId;
        model?: string;
        effort?: TeamMember['effort'];
        fastMode?: TeamMember['fastMode'];
        mcpPolicy?: TeamMember['mcpPolicy'];
        color?: string;
        cwd?: string;
        removedAt?: number;
      }
    >();
    if (Array.isArray(config.members)) {
      for (const m of config.members) {
        if (typeof m?.name === 'string' && m.name.trim() !== '') {
          const configMember = m as TeamMember & { provider?: TeamProviderId };
          const providerId =
            normalizeOptionalTeamProviderId(configMember.providerId) ??
            normalizeOptionalTeamProviderId(configMember.provider);
          configMemberMap.set(m.name.trim().toLowerCase(), {
            agentId: configMember.agentId,
            joinedAt: configMember.joinedAt,
            agentType: configMember.agentType,
            role: configMember.role,
            workflow: configMember.workflow,
            isolation: configMember.isolation === 'worktree' ? ('worktree' as const) : undefined,
            providerId,
            providerBackendId: migrateProviderBackendId(providerId, configMember.providerBackendId),
            configuredProviderBackendId: configMember.providerBackendId,
            model: configMember.model,
            effort: configMember.effort,
            fastMode:
              configMember.fastMode === 'inherit' ||
              configMember.fastMode === 'on' ||
              configMember.fastMode === 'off'
                ? configMember.fastMode
                : undefined,
            mcpPolicy: normalizeTeamMemberMcpPolicy(configMember.mcpPolicy),
            color: configMember.color,
            cwd: configMember.cwd,
            removedAt: configMember.removedAt,
          });
        }
      }
    }

    const metaMemberMap = new Map<
      string,
      {
        agentId?: string;
        joinedAt?: number;
        agentType?: string;
        role?: string;
        workflow?: string;
        isolation?: 'worktree';
        providerId?: TeamProviderId;
        providerBackendId?: TeamProviderBackendId;
        configuredProviderBackendId?: TeamProviderBackendId;
        model?: string;
        effort?: TeamMember['effort'];
        fastMode?: TeamMember['fastMode'];
        mcpPolicy?: TeamMember['mcpPolicy'];
        color?: string;
        cwd?: string;
        removedAt?: number;
      }
    >();
    if (Array.isArray(metaMembers)) {
      for (const member of metaMembers) {
        if (typeof member?.name === 'string' && member.name.trim() !== '') {
          metaMemberMap.set(member.name.trim().toLowerCase(), {
            agentId: member.agentId,
            joinedAt: member.joinedAt,
            agentType: member.agentType,
            role: member.role,
            workflow: member.workflow,
            isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
            providerId: member.providerId,
            providerBackendId: migrateProviderBackendId(
              member.providerId,
              member.providerBackendId
            ),
            configuredProviderBackendId: member.providerBackendId,
            model: member.model,
            effort: member.effort,
            fastMode:
              member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
                ? member.fastMode
                : undefined,
            mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
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
    const activeNamesForAutoSuffix = Array.from(names).filter(
      (name) =>
        !configMemberMap.get(name.toLowerCase())?.removedAt &&
        !metaMemberMap.get(name.toLowerCase())?.removedAt
    );
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
      const currentTask = selectCurrentActiveTeamTask(ownedTasks);
      const configMember = configMemberMap.get(name.toLowerCase());
      const metaMember = metaMemberMap.get(name.toLowerCase());
      const launchMember = launchMemberMap.get(name);
      const memberIsLead = isCanonicalLeadMember({
        name,
        agentType: configMember?.agentType ?? metaMember?.agentType,
        role: configMember?.role ?? metaMember?.role,
      });
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
      const providerBackendId = migrateProviderBackendId(
        effectiveProviderId,
        launchMember?.providerBackendId ??
          configMember?.providerBackendId ??
          metaMember?.providerBackendId ??
          (effectiveProviderId === options?.leadProviderId
            ? (options?.leadProviderBackendId ?? undefined)
            : undefined)
      );
      const agentId = configMember?.agentId ?? metaMember?.agentId;
      members.push({
        name,
        agentId,
        joinedAt: configMember?.joinedAt ?? metaMember?.joinedAt,
        currentTaskId: currentTask?.id ?? null,
        taskCount: ownedTasks.length,
        color: configMember?.color ?? metaMember?.color ?? getMemberColorByName(name),
        agentType: configMember?.agentType ?? metaMember?.agentType,
        role: configMember?.role ?? metaMember?.role,
        workflow: configMember?.workflow ?? metaMember?.workflow,
        isolation: configMember?.isolation ?? metaMember?.isolation,
        providerId: effectiveProviderId,
        providerBackendId,
        model:
          launchMember?.model ??
          configMember?.model ??
          metaMember?.model ??
          (memberIsLead ? options?.leadRuntimeSettings?.model : undefined),
        effort:
          launchMember?.effort ??
          configMember?.effort ??
          metaMember?.effort ??
          (memberIsLead ? options?.leadRuntimeSettings?.effort : undefined),
        mcpPolicy: configMember?.mcpPolicy ?? metaMember?.mcpPolicy,
        selectedFastMode:
          launchMember?.selectedFastMode ??
          configMember?.fastMode ??
          metaMember?.fastMode ??
          (effectiveProviderId === options?.leadProviderId
            ? (options?.leadFastMode ?? undefined)
            : undefined),
        configuredRuntimeSettings: {
          providerId:
            configMember?.providerId ??
            metaMember?.providerId ??
            (memberIsLead
              ? options?.leadRuntimeSettings?.configuredRuntimeSettings?.providerId
              : undefined),
          providerBackendId:
            configMember?.configuredProviderBackendId ??
            metaMember?.configuredProviderBackendId ??
            (memberIsLead
              ? options?.leadRuntimeSettings?.configuredRuntimeSettings?.providerBackendId
              : undefined),
          model:
            configMember?.model ??
            metaMember?.model ??
            (memberIsLead
              ? options?.leadRuntimeSettings?.configuredRuntimeSettings?.model
              : undefined),
          effort:
            configMember?.effort ??
            metaMember?.effort ??
            (memberIsLead
              ? options?.leadRuntimeSettings?.configuredRuntimeSettings?.effort
              : undefined),
          fastMode:
            configMember?.fastMode ??
            metaMember?.fastMode ??
            (memberIsLead
              ? options?.leadRuntimeSettings?.configuredRuntimeSettings?.fastMode
              : undefined),
        },
        resolvedFastMode:
          typeof launchMember?.resolvedFastMode === 'boolean'
            ? launchMember.resolvedFastMode
            : effectiveProviderId === options?.leadProviderId
              ? (options?.leadRuntimeSettings?.resolvedFastMode ??
                options?.leadResolvedFastMode ??
                undefined)
              : undefined,
        laneId: launchMember?.laneId ?? plannedLane.laneId,
        laneKind: launchMember?.laneKind ?? plannedLane.laneKind,
        laneOwnerProviderId: launchMember?.laneOwnerProviderId ?? plannedLane.laneOwnerProviderId,
        cwd: configMember?.cwd ?? metaMember?.cwd,
        removedAt: configMember?.removedAt ?? metaMember?.removedAt,
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
