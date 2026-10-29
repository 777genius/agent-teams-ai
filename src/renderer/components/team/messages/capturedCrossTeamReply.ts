import type {
  AgentActionMode,
  CrossTeamSendRequest,
  CrossTeamSendResult,
  InboxMessage,
  TaskRef,
} from '@shared/types';

export type ComposerCrossTeamSend = (
  toTeam: string,
  text: string,
  summary?: string,
  actionMode?: AgentActionMode,
  taskRefs?: TaskRef[],
  toMember?: string,
  messageId?: string,
  replyMetadata?: Pick<CrossTeamSendRequest, 'conversationId' | 'replyToConversationId'>
) => Promise<CrossTeamSendResult | null>;

export interface CapturedCrossTeamReply {
  toTeam: string;
  toMember?: string;
  conversationId: string;
}

/** Host replies use projected original navigation and conversation, never a displayed Team name. */
export function capturedCrossTeamReply(message: InboxMessage): CapturedCrossTeamReply | undefined {
  const navigation = message.crossTeamNavigation;
  if (!navigation || !message.conversationId) return undefined;
  const sent = message.source === 'cross_team_sent';
  const toTeam = sent ? navigation.toTeamKey : navigation.fromTeamKey;
  const teamName = sent ? navigation.toTeamName : navigation.fromTeamName;
  const participant = sent ? message.to : message.from;
  if (!toTeam || !participant?.startsWith(teamName + '.')) return undefined;
  const member = participant.slice(teamName.length + 1);
  if (!member) return undefined;
  return {
    toTeam,
    conversationId: message.conversationId,
    ...(member === 'user' ? {} : { toMember: member }),
  };
}
