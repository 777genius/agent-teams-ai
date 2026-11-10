import { createRequire } from 'node:module';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { validateCrossTeamIntent } from './validateCrossTeamIntent.js';
import type { CapturedCrossTeamIntent } from './contracts.js';
import type { TeamBinding, TeamCommand, CommandReceipt } from '../team/contracts.js';

const require = createRequire(import.meta.url);
const protocol = require('agent-teams-controller/src/internal/crossTeamProtocol.js') as {
  formatCrossTeamText(
    from: string,
    depth: number,
    text: string,
    meta: { conversationId: string; replyToConversationId?: string }
  ): string;
};
const { protocols } = require('agent-teams-controller') as {
  protocols: {
    buildActionModeAgentBlock(mode: 'do' | 'ask' | 'delegate'): string;
  };
};

/** Trusted composition creates this ordinary command; client/MCP payload validation is unchanged. */
export function crossTeamTargetCommand(
  intent: CapturedCrossTeamIntent
): Extract<TeamCommand, { operation: 'message.send' }> {
  const request = intent.request;
  return {
    commandId: intent.targetCommandId,
    operation: 'message.send',
    payload: {
      to: intent.pair.target.recipient.name,
      text: request.text,
      // The private receipt context supplies visible identity; ordinary command identity stays exact.
      messageId: intent.targetCommandId,
      ...(request.summary === undefined ? {} : { summary: request.summary }),
      ...(request.actionMode === undefined ? {} : { actionMode: request.actionMode }),
      ...(request.taskRefs === undefined
        ? {}
        : {
            taskRefs: request.taskRefs.map((ref) => ({
              taskId: ref.taskId,
              displayId: ref.displayId,
              teamName:
                ref.team === 'source' ? intent.pair.source.teamName : intent.pair.target.teamName,
            })),
          }),
    },
  };
}

export function validateCrossTeamTargetContext(
  binding: TeamBinding,
  principalId: string,
  command: TeamCommand,
  intent: CapturedCrossTeamIntent,
  authorityRevision: number
): void {
  validateCrossTeamIntent(intent);
  if (
    intent.pair.ownerId !== binding.backendId ||
    intent.pair.target.teamId !== binding.teamId ||
    intent.pair.target.teamName !== binding.teamName ||
    intent.pair.target.principalId !== principalId ||
    intent.pair.target.grantRevision !== authorityRevision ||
    intent.pair.source.teamId === intent.pair.target.teamId ||
    digest(command) !== digest(crossTeamTargetCommand(intent))
  )
    throw new TeamOwnerError('forbidden');
}

export function crossTeamInboundText(intent: CapturedCrossTeamIntent): string {
  const request = intent.request;
  const block = request.actionMode ? protocols.buildActionModeAgentBlock(request.actionMode) : '';
  return protocol.formatCrossTeamText(
    `${intent.pair.source.teamName}.${intent.pair.source.actor}`,
    request.chainDepth ?? 0,
    block ? `${block}\n\n${request.text}` : request.text,
    {
      conversationId: request.conversationId,
      ...(request.replyToConversationId === undefined
        ? {}
        : { replyToConversationId: request.replyToConversationId }),
    }
  );
}

/** Receipt-only context is never accepted in the ordinary command or tool argument schema. */
export function crossTeamInboundRow(receipt: CommandReceipt, intent: CapturedCrossTeamIntent) {
  validateCrossTeamTargetContext(
    receipt.binding,
    receipt.principalId,
    receipt.command,
    intent,
    receipt.authorityRevision ?? 0
  );
  const target = intent.pair.target.recipient;
  if (
    !receipt.deliveryBinding ||
    receipt.deliveryBinding.memberId !== target.memberId ||
    receipt.deliveryBinding.runId !== target.runId ||
    receipt.deliveryBinding.generation !== target.generation ||
    receipt.effects.messageId !== intent.request.messageId
  )
    throw new TeamOwnerError('hold');
  return {
    from: `${intent.pair.source.teamName}.${intent.pair.source.actor}`,
    to: target.name,
    text: crossTeamInboundText(intent),
    timestamp: intent.timestamp,
    messageId: intent.request.messageId,
    read: false,
    summary:
      intent.request.summary?.trim() || `Cross-team message from ${intent.pair.source.teamName}`,
    source: 'cross_team',
    conversationId: intent.request.conversationId,
    ...(intent.request.replyToConversationId === undefined
      ? {}
      : { replyToConversationId: intent.request.replyToConversationId }),
    ...(receipt.command.operation === 'message.send' && receipt.command.payload.taskRefs?.length
      ? { taskRefs: receipt.command.payload.taskRefs }
      : {}),
  };
}
