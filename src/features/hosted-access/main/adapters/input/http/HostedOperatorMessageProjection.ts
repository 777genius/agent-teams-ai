const HOSTED_TEAM_MESSAGE_PAGE_PATH = '/api/hosted/v1/team-messages/page';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message authority established operator authorship before the generic host-path projection. */
export function preserveAuthorizedOperatorMessageText(
  method: string,
  path: string,
  source: unknown,
  projected: unknown
): unknown {
  if (method !== 'POST' || path !== HOSTED_TEAM_MESSAGE_PAGE_PATH) return projected;
  if (
    !isRecord(source) ||
    !isRecord(projected) ||
    source.schemaVersion !== 1 ||
    source.kind !== 'message_page' ||
    projected.schemaVersion !== 1 ||
    projected.kind !== 'message_page' ||
    typeof source.teamId !== 'string' ||
    source.teamId !== projected.teamId ||
    !Array.isArray(source.messages) ||
    !Array.isArray(projected.messages)
  ) {
    return projected;
  }
  const operatorTextById = new Map<string, string>();
  for (const message of source.messages) {
    if (
      isRecord(message) &&
      message.teamId === source.teamId &&
      message.direction === 'operator' &&
      typeof message.messageId === 'string' &&
      /^message_[0-9a-f]{32}$/u.test(message.messageId) &&
      typeof message.text === 'string'
    ) {
      operatorTextById.set(message.messageId, message.text);
    }
  }
  return {
    ...projected,
    messages: projected.messages.map((message) => {
      if (
        !isRecord(message) ||
        message.teamId !== projected.teamId ||
        message.direction !== 'operator' ||
        typeof message.messageId !== 'string'
      ) {
        return message;
      }
      const text = operatorTextById.get(message.messageId);
      return text === undefined ? message : { ...message, text };
    }),
  };
}
