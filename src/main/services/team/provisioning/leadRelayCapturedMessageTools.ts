import { isAgentTeamsToolName, isAgentTeamsToolUse } from '../agentTeamsToolNames';

function isCapturedGroupSend(
  name: string,
  input: Record<string, unknown>,
  teamName: string
): boolean {
  return (
    isAgentTeamsToolName(name, 'group_chat_send') &&
    input.teamName === teamName &&
    typeof input.groupChatId === 'string' &&
    input.groupChatId.trim().length > 0 &&
    typeof input.text === 'string' &&
    input.text.trim().length > 0
  );
}

/** A lead send tool_use that makes relay text visible elsewhere: to the user or not, group or not. */
export interface CapturedSendVisibility {
  userVisible: boolean;
  group: boolean;
}

export function classifyCapturedSend(
  part: Record<string, unknown>,
  teamName: string
): CapturedSendVisibility | null {
  if (!part || typeof part !== 'object') return null;
  if (part.type !== 'tool_use' || typeof part.name !== 'string') return null;

  const input = part.input;
  if (!input || typeof input !== 'object') return null;
  const inp = input as Record<string, unknown>;
  // A rejected group attempt must never become a private/plaintext fallback.
  if (isCapturedGroupSend(part.name, inp, teamName)) {
    return { userVisible: true, group: true };
  }

  if (part.name === 'SendMessage') {
    const target = (typeof inp.recipient === 'string' ? inp.recipient : '').trim();
    const text = (typeof inp.content === 'string' ? inp.content : '').trim();
    if (target.length === 0 || text.length === 0) return null;
    return { userVisible: target.toLowerCase() === 'user', group: false };
  }

  const isTeamMessageSendTool = isAgentTeamsToolUse({
    rawName: part.name,
    canonicalName: 'message_send',
    toolInput: inp,
    currentTeamName: teamName,
  });
  const isDirectCrossTeamSendTool = isAgentTeamsToolUse({
    rawName: part.name,
    canonicalName: 'cross_team_send',
    toolInput: inp,
    currentTeamName: teamName,
  });
  if (!isTeamMessageSendTool && !isDirectCrossTeamSendTool) return null;

  const target = (
    isTeamMessageSendTool
      ? typeof inp.to === 'string'
        ? inp.to
        : ''
      : typeof inp.toTeam === 'string'
        ? inp.toTeam
        : ''
  ).trim();
  const text = typeof inp.text === 'string' ? inp.text.trim() : '';
  if (target.length === 0 || text.length === 0) return null;
  return { userVisible: isTeamMessageSendTool && target.toLowerCase() === 'user', group: false };
}

export function hasCapturedVisibleSendMessage(
  content: Record<string, unknown>[],
  teamName: string
): boolean {
  return content.some((part) => classifyCapturedSend(part, teamName) !== null);
}
