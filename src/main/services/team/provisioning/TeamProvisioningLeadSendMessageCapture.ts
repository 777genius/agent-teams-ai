import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { parseCrossTeamPrefix, stripCrossTeamPrefix } from '@shared/constants/crossTeam';

import { isAgentTeamsToolUse } from '../agentTeamsToolNames';

import {
  isCrossTeamToolRecipientName,
  parseCrossTeamRecipient,
  resolveSingleActiveCrossTeamReplyHint,
} from './TeamProvisioningCrossTeamRelayHelpers';
import {
  consumePendingInboxRelayCandidate,
  type InboxRelayCandidateRunState,
  type SilentTeammateForward,
} from './TeamProvisioningInboxRelayCandidates';
import { teamToolTaskRefs } from './TeamProvisioningRuntimeMetadata';

import type { InboxMessage, TaskRef } from '@shared/types';

export interface TeamProvisioningLeadSendMessageRun extends InboxRelayCandidateRunState {
  teamName: string;
  runId: string;
  request: {
    members: Array<{ name?: string; role?: string }>;
  };
  activeCrossTeamReplyHints: Array<{
    toTeam: string;
    conversationId: string;
  }>;
  pendingDirectCrossTeamSendRefresh: boolean;
  silentUserDmForward?: SilentTeammateForward | null;
}

export interface CrossTeamSendRequest {
  fromTeam: string;
  fromMember: string;
  toTeam: string;
  text: string;
  summary?: string;
  taskRefs?: TaskRef[];
  messageId?: string;
  timestamp?: string;
  conversationId?: string;
  replyToConversationId?: string;
}

export interface CrossTeamSendResultLike {
  deduplicated?: boolean;
  messageId: string;
}

export interface TeamProvisioningLeadSendMessageCaptureLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface TeamProvisioningLeadSendMessageCapturePorts {
  nowIso(): string;
  nowMs(): number;
  logger: TeamProvisioningLeadSendMessageCaptureLogger;
  crossTeamSender: ((request: CrossTeamSendRequest) => Promise<CrossTeamSendResultLike>) | null;
  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null;
  getTrackedRunId(teamName: string): string | null;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
  persistSentMessage(teamName: string, message: InboxMessage): void;
  persistInboxMessage(teamName: string, recipient: string, message: InboxMessage): void;
  emitLeadMessageChange(teamName: string, runId: string, detail: string): void;
  emitInboxChange(teamName: string, detail: string): void;
}

export function captureLeadSendMessages<TRun extends TeamProvisioningLeadSendMessageRun>(
  run: TRun,
  content: Record<string, unknown>[],
  ports: TeamProvisioningLeadSendMessageCapturePorts
): void {
  for (const part of content) {
    if (part.type !== 'tool_use' || typeof part.name !== 'string') continue;
    const isNativeSendMessage = part.name === 'SendMessage';
    const input = part.input;
    if (!input || typeof input !== 'object') continue;
    const inp = input as Record<string, unknown>;
    const isTeamMessageSendTool = isAgentTeamsToolUse({
      rawName: part.name,
      canonicalName: 'message_send',
      toolInput: inp,
      currentTeamName: run.teamName,
    });
    const isDirectCrossTeamSendTool = isAgentTeamsToolUse({
      rawName: part.name,
      canonicalName: 'cross_team_send',
      toolInput: inp,
      currentTeamName: run.teamName,
    });
    if (!isNativeSendMessage && !isTeamMessageSendTool && !isDirectCrossTeamSendTool) continue;

    if (isDirectCrossTeamSendTool) {
      const toTeam = typeof inp.toTeam === 'string' ? inp.toTeam.trim() : '';
      const text = typeof inp.text === 'string' ? stripAgentBlocks(inp.text).trim() : '';
      if (toTeam && text) {
        run.pendingDirectCrossTeamSendRefresh = true;
      }
      continue;
    }

    const rawRecipient = isNativeSendMessage
      ? typeof inp.recipient === 'string'
        ? inp.recipient
        : ''
      : typeof inp.to === 'string'
        ? inp.to
        : '';
    const trimmedRecipient = rawRecipient.trim();
    if (!trimmedRecipient) continue;
    const recipient = trimmedRecipient.toLowerCase() === 'user' ? 'user' : trimmedRecipient;

    const msgContent = isNativeSendMessage
      ? typeof inp.content === 'string'
        ? inp.content
        : ''
      : typeof inp.text === 'string'
        ? inp.text
        : '';
    if (msgContent.trim().length === 0) continue;

    const summary = typeof inp.summary === 'string' ? inp.summary : '';
    const leadName =
      run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
      'team-lead';

    const cleanContent = stripAgentBlocks(msgContent);
    if (cleanContent.trim().length === 0) continue;
    const strippedCrossTeamContent = stripCrossTeamPrefix(cleanContent).trim();
    if (strippedCrossTeamContent.length === 0) continue;
    const localRecipientNames = new Set(
      (run.request.members ?? [])
        .map((member) => (typeof member.name === 'string' ? member.name.trim() : ''))
        .filter((name) => name.length > 0)
    );
    localRecipientNames.add('user');
    localRecipientNames.add('team-lead');

    const mistakenToolHint = isCrossTeamToolRecipientName(recipient)
      ? resolveSingleActiveCrossTeamReplyHint(run.activeCrossTeamReplyHints)
      : null;
    const crossTeamRecipient =
      parseCrossTeamRecipient(run.teamName, recipient, localRecipientNames) ??
      (mistakenToolHint ? { teamName: mistakenToolHint.toTeam, memberName: 'team-lead' } : null);
    if (crossTeamRecipient && ports.crossTeamSender) {
      const inferredReplyMeta =
        mistakenToolHint?.toTeam === crossTeamRecipient.teamName
          ? {
              conversationId: mistakenToolHint.conversationId,
              replyToConversationId: mistakenToolHint.conversationId,
            }
          : ports.resolveCrossTeamReplyMetadata(run.teamName, crossTeamRecipient.teamName);
      const crossTeamMeta = parseCrossTeamPrefix(cleanContent);
      const replyMeta = inferredReplyMeta;
      const timestamp = ports.nowIso();
      const messageId = `lead-sendmsg-${run.runId}-${ports.nowMs()}`;
      const taskRefs = teamToolTaskRefs(run.teamName, inp.taskRefs);

      void ports
        .crossTeamSender({
          fromTeam: run.teamName,
          fromMember: leadName,
          toTeam: crossTeamRecipient.teamName,
          text: strippedCrossTeamContent,
          summary,
          ...(taskRefs ? { taskRefs } : {}),
          messageId,
          timestamp,
          conversationId: crossTeamMeta?.conversationId ?? replyMeta?.conversationId,
          replyToConversationId:
            replyMeta?.replyToConversationId ??
            crossTeamMeta?.conversationId ??
            replyMeta?.conversationId,
        })
        .then((result) => {
          if (result.deduplicated) {
            return;
          }
          if (ports.getTrackedRunId(run.teamName) !== run.runId) {
            ports.logger.debug(
              `[${run.teamName}] Skipping stale cross-team send result for old run ${run.runId}`
            );
            return;
          }
          const msg: InboxMessage = {
            from: leadName,
            to: recipient.startsWith('cross-team:')
              ? recipient
              : isCrossTeamToolRecipientName(recipient)
                ? `${crossTeamRecipient.teamName}.${crossTeamRecipient.memberName}`
                : `${crossTeamRecipient.teamName}.${crossTeamRecipient.memberName}`,
            text: strippedCrossTeamContent,
            timestamp,
            read: true,
            summary:
              (summary || strippedCrossTeamContent).length > 60
                ? (summary || strippedCrossTeamContent).slice(0, 57) + '...'
                : summary || strippedCrossTeamContent,
            messageId: result.messageId,
            source: 'cross_team_sent',
            conversationId: crossTeamMeta?.conversationId ?? replyMeta?.conversationId,
            replyToConversationId:
              replyMeta?.replyToConversationId ??
              crossTeamMeta?.conversationId ??
              replyMeta?.conversationId,
            ...(taskRefs ? { taskRefs } : {}),
          };
          ports.pushLiveLeadProcessMessage(run.teamName, msg);
          ports.emitLeadMessageChange(run.teamName, run.runId, 'cross-team-send');
        })
        .catch((error: unknown) => {
          ports.logger.warn(
            `[${run.teamName}] qualified SendMessage→${recipient} cross-team fallback failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      continue;
    }

    if (isCrossTeamToolRecipientName(recipient)) {
      continue;
    }

    if (!isNativeSendMessage) {
      continue;
    }

    if (recipient === 'user' && run.silentUserDmForward?.mode === 'member_inbox_relay') {
      ports.logger.debug(
        `[${run.teamName}] Suppressed SendMessage→user during member_inbox_relay to "${run.silentUserDmForward.target}"`
      );
      continue;
    }

    const relayOfMessageId =
      recipient !== 'user'
        ? consumePendingInboxRelayCandidate(run, recipient, strippedCrossTeamContent, summary)
        : undefined;

    const msg: InboxMessage = {
      from: leadName,
      to: recipient,
      text: strippedCrossTeamContent,
      timestamp: ports.nowIso(),
      read: recipient !== 'user',
      summary:
        (summary || strippedCrossTeamContent).length > 60
          ? (summary || strippedCrossTeamContent).slice(0, 57) + '...'
          : summary || strippedCrossTeamContent,
      messageId: `lead-sendmsg-${run.runId}-${ports.nowMs()}`,
      ...(relayOfMessageId ? { relayOfMessageId } : {}),
      source: 'lead_process',
    };

    ports.pushLiveLeadProcessMessage(run.teamName, msg);

    if (recipient === 'user') {
      ports.persistSentMessage(run.teamName, msg);
      ports.emitInboxChange(run.teamName, 'sentMessages.json');
    } else {
      ports.persistInboxMessage(run.teamName, recipient, msg);
      ports.emitInboxChange(run.teamName, `inboxes/${recipient}.json`);
    }

    ports.logger.debug(
      `[${run.teamName}] Captured SendMessage→${recipient} from stdout: ${cleanContent.slice(0, 100)}`
    );
  }
}
