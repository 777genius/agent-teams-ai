import {
  createCliAutoSuffixNameGuard,
  createCliProvisionerNameGuard,
} from '@shared/utils/teamMemberName';

import type {
  InboxMessage,
  MemberStatus,
  ResolvedTeamMember,
  TeamConfig,
  TeamTaskWithKanban,
} from '@shared/types';

const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const CROSS_TEAM_TOOL_RECIPIENT_NAMES = new Set([
  'cross_team_send',
  'cross_team_list_targets',
  'cross_team_get_outbox',
]);

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

export class TeamMemberResolver {
  resolveMembers(
    config: TeamConfig,
    metaMembers: TeamConfig['members'],
    inboxNames: string[],
    tasks: TeamTaskWithKanban[],
    messages: InboxMessage[]
  ): ResolvedTeamMember[] {
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
        addName(trimmed);
      }
    }

    const configMemberMap = new Map<
      string,
      { agentType?: string; role?: string; workflow?: string; color?: string; cwd?: string }
    >();
    if (Array.isArray(config.members)) {
      for (const m of config.members) {
        if (typeof m?.name === 'string' && m.name.trim() !== '') {
          configMemberMap.set(m.name.trim(), {
            agentType: m.agentType,
            role: m.role,
            workflow: m.workflow,
            color: m.color,
            cwd: m.cwd,
          });
        }
      }
    }

    const metaMemberMap = new Map<
      string,
      { agentType?: string; role?: string; workflow?: string; color?: string; removedAt?: number }
    >();
    if (Array.isArray(metaMembers)) {
      for (const member of metaMembers) {
        if (typeof member?.name === 'string' && member.name.trim() !== '') {
          metaMemberMap.set(member.name.trim(), {
            agentType: member.agentType,
            role: member.role,
            workflow: member.workflow,
            color: member.color,
            removedAt: member.removedAt,
          });
        }
      }
    }

    // "user" is a built-in pseudo-member in Claude Code's team framework
    // (recipient of SendMessage to "user"). It's not a real AI teammate.
    names.delete('user');

    // Defense: hide CLI auto-suffixed duplicates (alice-2) when base name (alice) exists.
    const keepName = createCliAutoSuffixNameGuard(names);
    // Defense: hide CLI provisioner artifacts (alice-provisioner) when base name (alice) exists.
    const keepProvisioner = createCliProvisionerNameGuard(names);
    for (const name of Array.from(names)) {
      if (!keepName(name) || !keepProvisioner(name)) {
        names.delete(name);
      }
    }

    const members: ResolvedTeamMember[] = [];
    for (const name of names) {
      const ownedTasks = tasks.filter((task) => task.owner === name);
      const currentTask =
        ownedTasks.find(
          (task) =>
            task.status === 'in_progress' &&
            task.reviewState !== 'approved' &&
            task.kanbanColumn !== 'approved'
        ) ?? null;
      const memberMessages = messages.filter((message) => message.from === name);
      const latestMessage = memberMessages[0] ?? null;
      const status = this.resolveStatus(latestMessage, currentTask !== null);
      const configMember = configMemberMap.get(name);
      const metaMember = metaMemberMap.get(name);
      members.push({
        name,
        status,
        currentTaskId: currentTask?.id ?? null,
        taskCount: ownedTasks.length,
        messageCount: memberMessages.length,
        lastActiveAt: latestMessage?.timestamp ?? null,
        color: latestMessage?.color ?? configMember?.color ?? metaMember?.color,
        agentType: configMember?.agentType ?? metaMember?.agentType,
        role: configMember?.role ?? metaMember?.role,
        workflow: configMember?.workflow ?? metaMember?.workflow,
        cwd: configMember?.cwd,
        removedAt: metaMember?.removedAt,
      });
    }

    members.sort((a, b) => a.name.localeCompare(b.name));
    return members;
  }

  private resolveStatus(message: InboxMessage | null, hasActiveTask: boolean): MemberStatus {
    if (!message) {
      // Member exists in config but has no messages yet —
      // if they own an in_progress task they're clearly active, otherwise idle
      return hasActiveTask ? 'active' : 'idle';
    }

    const structured = this.parseStructuredMessage(message.text);
    if (structured) {
      const typed = structured as { type?: string; approve?: boolean; approved?: boolean };
      if (
        (typed.type === 'shutdown_response' &&
          (typed.approve === true || typed.approved === true)) ||
        typed.type === 'shutdown_approved'
      ) {
        return 'terminated';
      }
    }

    const ageMs = Date.now() - Date.parse(message.timestamp);
    if (Number.isNaN(ageMs)) {
      return 'unknown';
    }
    if (ageMs < 5 * 60 * 1000) {
      return 'active';
    }
    return 'idle';
  }

  private parseStructuredMessage(text: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore plain text.
    }
    return null;
  }
}
