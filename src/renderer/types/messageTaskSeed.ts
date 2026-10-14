/** Renderer intent captured from the original message, before opening a task dialog. */
export interface MessageTaskSeed {
  subject: string;
  description: string;
  source: { teamName: string; groupChatId?: string };
}

export interface MessageActionOwner {
  contextId: string;
  teamName: string;
  scopeKey: string;
}

export function sameMessageActionOwner(
  left: MessageActionOwner | null,
  right: MessageActionOwner
): boolean {
  return (
    left?.contextId === right.contextId &&
    left.teamName === right.teamName &&
    left.scopeKey === right.scopeKey
  );
}
