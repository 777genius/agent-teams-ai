import { getMemberColorByName } from '@shared/constants/memberColors';
import {
  createCliAutoSuffixNameGuard,
  createCliProvisionerNameGuard,
} from '@shared/utils/teamMemberName';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { getStableTeamOwnerId } from '@shared/utils/teamStableOwnerId';

import type { TeamConfig, TeamMember, TeamMemberSnapshot, TeamTaskWithKanban } from '@shared/types';

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
    tasks: TeamTaskWithKanban[]
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
        providerId?: 'anthropic' | 'codex' | 'gemini';
        model?: string;
        effort?: 'low' | 'medium' | 'high';
        color?: string;
        cwd?: string;
      }
    >();
    if (Array.isArray(config.members)) {
      for (const m of config.members) {
        if (typeof m?.name === 'string' && m.name.trim() !== '') {
          const configMember = m as TeamMember & { provider?: 'anthropic' | 'codex' | 'gemini' };
          const providerId =
            configMember.providerId === 'anthropic' ||
            configMember.providerId === 'codex' ||
            configMember.providerId === 'gemini'
              ? configMember.providerId
              : configMember.provider === 'anthropic' ||
                  configMember.provider === 'codex' ||
                  configMember.provider === 'gemini'
                ? configMember.provider
                : undefined;
          configMemberMap.set(m.name.trim(), {
            agentId: configMember.agentId,
            agentType: configMember.agentType,
            role: configMember.role,
            workflow: configMember.workflow,
            providerId,
            model: configMember.model,
            effort: configMember.effort,
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
        providerId?: 'anthropic' | 'codex' | 'gemini';
        model?: string;
        effort?: 'low' | 'medium' | 'high';
        color?: string;
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
            providerId: member.providerId,
            model: member.model,
            effort: member.effort,
            color: member.color,
            removedAt: member.removedAt,
          });
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

    // Defense: hide CLI auto-suffixed duplicates (alice-2) when base name (alice) exists.
    const keepName = createCliAutoSuffixNameGuard(names);
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
        providerId: configMember?.providerId ?? metaMember?.providerId,
        model: configMember?.model ?? metaMember?.model,
        effort: configMember?.effort ?? metaMember?.effort,
        cwd: configMember?.cwd,
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
