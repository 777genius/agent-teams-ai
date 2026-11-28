export interface CrossTeamActiveReplyHint {
  toTeam: string;
  conversationId: string;
}

/** Existing live-reply policy: a single active hint to this exact original Team. */
export function inferCrossTeamReplyMetadata(
  hints: readonly CrossTeamActiveReplyHint[],
  toTeam: string
): { conversationId: string; replyToConversationId: string } | null {
  const matches = hints.filter((hint) => hint.toTeam === toTeam);
  if (matches.length !== 1) return null;
  return {
    conversationId: matches[0]!.conversationId,
    replyToConversationId: matches[0]!.conversationId,
  };
}
