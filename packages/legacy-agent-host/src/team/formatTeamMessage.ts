import { crossTeamInboundText, crossTeamTargetCommand } from '../cross-team/crossTeamInbound.js';
import { digest } from './identity.js';
import type { CapturedCrossTeamIntent } from '../cross-team/contracts.js';
import { createRequire } from 'node:module';

import { TeamOwnerError } from './contracts.js';

import type { TeamCommand } from './contracts.js';

const require = createRequire(import.meta.url);
const { agentBlocks, protocols } = require('agent-teams-controller') as {
  agentBlocks: { wrapAgentBlock(text: string): string };
  protocols: {
    buildActionModeProtocolText(delegateDescription: string): string;
    MEMBER_DELEGATE_DESCRIPTION: string;
    buildActionModeProtocol(): string;
    buildActionModeAgentBlock(mode: 'do' | 'ask' | 'delegate'): string;
  };
};

type MessagePayload = Extract<TeamCommand, { operation: 'message.send' }>['payload'];

/** Immutable rich-message content, shared by initial publication and recovery authorization. */
export function formatTeamMessage(
  payload: MessagePayload,
  actor: string,
  messageId: string,
  recipientRole: 'lead' | 'member' = 'member',
  crossTeam?: CapturedCrossTeamIntent
): string {
  if (crossTeam) {
    if (
      messageId !== crossTeam.request.messageId ||
      digest(payload) !== digest(crossTeamTargetCommand(crossTeam).payload)
    )
      throw new TeamOwnerError('hold');
    return crossTeamInboundText(crossTeam);
  }
  if (payload.messageId !== undefined && payload.messageId !== messageId)
    throw new TeamOwnerError('hold');
  // Existing durable plain-text commands must keep their original native input bytes.
  if (
    payload.messageId === undefined &&
    payload.summary === undefined &&
    payload.actionMode === undefined
  )
    return payload.text;
  const metadata = {
    from: actor,
    to: payload.to,
    messageId,
    ...(payload.summary?.trim() ? { summary: payload.summary.trim() } : {}),
    ...(payload.actionMode ? { actionMode: payload.actionMode } : {}),
    ...(payload.taskRefs?.length ? { taskRefs: payload.taskRefs } : {}),
  };
  const protocol = payload.actionMode
    ? recipientRole === 'lead'
      ? protocols.buildActionModeProtocol()
      : protocols.buildActionModeProtocolText(protocols.MEMBER_DELEGATE_DESCRIPTION)
    : '';
  const visibleReply =
    actor === 'user'
      ? [
          'You received a direct message from the human user via the UI.',
          'CRITICAL: Send your human-readable reply with the exposed team MCP message_send tool to="user", including commandId and text.',
          'Use a new stable commandId for each distinct reply; retain that ID when looking up or retrying the same reply.',
          'Do not reuse the incoming messageId as a reply commandId.',
          'Normal assistant text alone does not appear in the UI message thread. If you need to consult a teammate first, send the user a brief acknowledgement, then send the final answer when ready.',
        ].join('\n')
      : '';
  return [
    agentBlocks.wrapAgentBlock(
      [protocol, visibleReply, `Message context: ${JSON.stringify(metadata)}`]
        .filter(Boolean)
        .join('\n')
    ),
    payload.actionMode ? protocols.buildActionModeAgentBlock(payload.actionMode) : '',
    payload.text,
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}
