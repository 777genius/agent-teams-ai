import type {
  InboxMessage,
  MemberStatus,
  ResolvedTeamMember,
  TeamConfig,
  TeamTaskWithKanban,
} from '@shared/types';

export class TeamMemberResolver {
  resolveMembers(
    config: TeamConfig,
    metaMembers: TeamConfig['members'],
    inboxNames: string[],
    tasks: TeamTaskWithKanban[],
    messages: InboxMessage[]
  ): ResolvedTeamMember[] {
    const names = new Set<string>();

    if (Array.isArray(config.members)) {
      for (const member of config.members) {
        if (typeof member?.name === 'string' && member.name.trim() !== '') {
          names.add(member.name.trim());
        }
      }
    }

    if (Array.isArray(metaMembers)) {
      for (const member of metaMembers) {
        if (typeof member?.name === 'string' && member.name.trim() !== '') {
          names.add(member.name.trim());
        }
      }
    }

    for (const inboxName of inboxNames) {
      if (typeof inboxName === 'string' && inboxName.trim() !== '') {
        names.add(inboxName.trim());
      }
    }

    const configMemberMap = new Map<
      string,
      { agentType?: string; role?: string; color?: string }
    >();
    if (Array.isArray(config.members)) {
      for (const m of config.members) {
        if (typeof m?.name === 'string' && m.name.trim() !== '') {
          configMemberMap.set(m.name.trim(), {
            agentType: m.agentType,
            role: m.role,
            color: m.color,
          });
        }
      }
    }

    const metaMemberMap = new Map<string, { agentType?: string; role?: string; color?: string }>();
    if (Array.isArray(metaMembers)) {
      for (const member of metaMembers) {
        if (typeof member?.name === 'string' && member.name.trim() !== '') {
          metaMemberMap.set(member.name.trim(), {
            agentType: member.agentType,
            role: member.role,
            color: member.color,
          });
        }
      }
    }

    const members: ResolvedTeamMember[] = [];
    for (const name of names) {
      const ownedTasks = tasks.filter((task) => task.owner === name);
      const currentTask =
        ownedTasks.find(
          (task) => task.status === 'in_progress' && task.kanbanColumn !== 'approved'
        ) ?? null;
      const memberMessages = messages.filter((message) => message.from === name);
      const latestMessage = memberMessages[0] ?? null;
      const status = this.resolveStatus(latestMessage);
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
      });
    }

    members.sort((a, b) => a.name.localeCompare(b.name));
    return members;
  }

  private resolveStatus(message: InboxMessage | null): MemberStatus {
    if (!message) {
      return 'unknown';
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
