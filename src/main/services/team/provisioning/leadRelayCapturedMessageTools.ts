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

export function hasCapturedVisibleSendMessage(
  content: Record<string, unknown>[],
  teamName: string
): boolean {
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    if (part.type !== 'tool_use' || typeof part.name !== 'string') return false;

    const input = part.input;
    if (!input || typeof input !== 'object') return false;
    const inp = input as Record<string, unknown>;
    // A rejected group attempt must never become a private/plaintext fallback.
    if (isCapturedGroupSend(part.name, inp, teamName)) return true;

    if (part.name === 'SendMessage') {
      const target = (typeof inp.recipient === 'string' ? inp.recipient : '').trim();
      const text = (typeof inp.content === 'string' ? inp.content : '').trim();
      return target.length > 0 && text.length > 0;
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
    if (!isTeamMessageSendTool && !isDirectCrossTeamSendTool) return false;

    const target = isTeamMessageSendTool
      ? typeof inp.to === 'string'
        ? inp.to
        : ''
      : typeof inp.toTeam === 'string'
        ? inp.toTeam
        : '';
    const text = typeof inp.text === 'string' ? inp.text : '';

    return target.trim().length > 0 && text.trim().length > 0;
  });
}

export function hasCapturedUserVisibleSendMessage(
  content: Record<string, unknown>[],
  teamName: string
): boolean {
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    if (part.type !== 'tool_use' || typeof part.name !== 'string') return false;

    const input = part.input;
    if (!input || typeof input !== 'object') return false;
    const inp = input as Record<string, unknown>;
    // A rejected group attempt must never become a private/plaintext fallback.
    if (isCapturedGroupSend(part.name, inp, teamName)) return true;

    if (part.name === 'SendMessage') {
      const target = (typeof inp.recipient === 'string' ? inp.recipient : '').trim().toLowerCase();
      const text = (typeof inp.content === 'string' ? inp.content : '').trim();
      return target === 'user' && text.length > 0;
    }

    const isTeamMessageSendTool = isAgentTeamsToolUse({
      rawName: part.name,
      canonicalName: 'message_send',
      toolInput: inp,
      currentTeamName: teamName,
    });
    if (!isTeamMessageSendTool) return false;

    const target = typeof inp.to === 'string' ? inp.to.trim().toLowerCase() : '';
    const text = typeof inp.text === 'string' ? inp.text.trim() : '';
    return target === 'user' && text.length > 0;
  });
}
