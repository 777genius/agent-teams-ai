import { buildMemberColorMap } from '@renderer/utils/memberHelpers';

import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

export interface MessageContext {
  colorMap: Map<string, string>;
  localMemberNames: Set<string>;
  memberInfo: Map<string, { role?: string; color?: string }>;
}

const EMPTY_CONTEXT: MessageContext = {
  colorMap: new Map(),
  localMemberNames: new Set(),
  memberInfo: new Map(),
};

/**
 * Build derived member context (color map, local names set, member info map)
 * from a list of resolved team members. Shared between ActivityTimeline and
 * MessageExpandDialog to avoid drift.
 */
export function buildMessageContext(members?: ResolvedTeamMember[]): MessageContext {
  if (!members || members.length === 0) return EMPTY_CONTEXT;

  const colorMap = buildMemberColorMap(members);
  const localMemberNames = new Set(members.map((m) => m.name.trim()));

  const memberInfo = new Map<string, { role?: string; color?: string }>();
  for (const member of members) {
    const info = {
      role: member.role ?? (member.agentType !== 'general-purpose' ? member.agentType : undefined),
      color: colorMap.get(member.name),
    };
    memberInfo.set(member.name, info);
    if (member.agentType && member.agentType !== member.name) {
      memberInfo.set(member.agentType, info);
    }
  }

  const leadMember = members.find(
    (m) => m.agentType === 'team-lead' || m.role?.toLowerCase().includes('lead')
  );
  if (leadMember && memberInfo.has(leadMember.name)) {
    memberInfo.set('user', { role: undefined, color: colorMap.get('user') });
  }

  return { colorMap, localMemberNames, memberInfo };
}

export interface MessageRenderProps {
  memberRole?: string;
  memberColor?: string;
  recipientColor?: string;
}

/**
 * Resolve per-message render props (role, colors) from the shared context.
 * Used by both ActivityTimeline render-loop and MessageExpandDialog.
 */
export function resolveMessageRenderProps(
  message: InboxMessage,
  ctx: MessageContext
): MessageRenderProps {
  const info = ctx.memberInfo.get(message.from);
  const recipientInfo = message.to ? ctx.memberInfo.get(message.to) : undefined;
  const recipientColor =
    recipientInfo?.color ?? (message.to ? ctx.colorMap.get(message.to) : undefined);
  return {
    memberRole: info?.role,
    memberColor: info?.color,
    recipientColor,
  };
}
