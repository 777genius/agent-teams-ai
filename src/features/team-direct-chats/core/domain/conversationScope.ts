export type ConversationScope =
  | { readonly kind: 'team-feed' }
  | { readonly kind: 'direct'; readonly participant: string };

export type ConversationSurface = 'list' | 'thread';

export function normalizeConversationParticipant(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function conversationScopeKey(scope: ConversationScope): string {
  if (scope.kind === 'team-feed') {
    return 'team-feed';
  }
  return `direct:${normalizeConversationParticipant(scope.participant)}`;
}

export function isSameConversationScope(
  left: ConversationScope,
  right: ConversationScope
): boolean {
  return conversationScopeKey(left) === conversationScopeKey(right);
}

export function createDirectScope(participant: string): ConversationScope {
  return { kind: 'direct', participant: normalizeConversationParticipant(participant) };
}

export const TEAM_FEED_SCOPE: ConversationScope = { kind: 'team-feed' };
