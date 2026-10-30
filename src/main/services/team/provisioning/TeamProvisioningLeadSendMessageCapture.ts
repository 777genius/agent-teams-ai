import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { parseCrossTeamPrefix, stripCrossTeamPrefix } from '@shared/constants/crossTeam';

import { isAgentTeamsToolUse } from '../agentTeamsToolNames';

import {
  isCrossTeamToolRecipientName,
  parseCrossTeamRecipient,
  resolveCrossTeamLeadName,
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
  /**
   * Send calls waiting for their tool_result, keyed by tool_use id. The runtime can reject a
   * call (for example an unknown recipient), so nothing is delivered or shown before success.
   */
  pendingLeadSendMessages: Map<string, PendingLeadSendMessage>;
}

export interface CrossTeamSendRequest {
  fromTeam: string;
  fromMember: string;
  toTeam: string;
  toMember?: string;
  text: string;
  summary?: string;
  taskRefs?: TaskRef[];
  messageId?: string;
  timestamp?: string;
  conversationId?: string;
  replyToConversationId?: string;
}

type LeadCrossTeamSendRequest = CrossTeamSendRequest &
  Required<Pick<CrossTeamSendRequest, 'toMember' | 'summary' | 'messageId' | 'timestamp'>>;

/**
 * A captured lead send call. `cross_team` is delivered to another team by the app;
 * `local` is the live copy of a same-team message (the runtime writes the inbox itself).
 */
export type PendingLeadSendMessage =
  | { kind: 'cross_team'; recipient: string; request: LeadCrossTeamSendRequest }
  | { kind: 'local'; recipient: string; summary: string; message: InboxMessage };

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
  logger: TeamProvisioningLeadSendMessageCaptureLogger;
  crossTeamSender: ((request: CrossTeamSendRequest) => Promise<CrossTeamSendResultLike>) | null;
  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null;
  getTrackedRunId(teamName: string): string | null;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
  persistSentMessage(teamName: string, message: InboxMessage): void;
  emitLeadMessageChange(teamName: string, runId: string, detail: string): void;
  emitInboxChange(teamName: string, detail: string): void;
}

/**
 * Handles lead SendMessage calls in the stream. A `tool_use` is kept until its `tool_result`;
 * only a successful result delivers the cross-team message or publishes the live copy.
 * Agent-teams `message_send` is not captured: the board rejects recipients in other teams.
 */
export function captureLeadSendMessages<TRun extends TeamProvisioningLeadSendMessageRun>(
  run: TRun,
  content: Record<string, unknown>[],
  ports: TeamProvisioningLeadSendMessageCapturePorts
): void {
  for (const part of content) {
    if (part.type === 'tool_result') {
      settleLeadSendMessage(run, part, ports);
      continue;
    }
    if (part.type !== 'tool_use' || typeof part.name !== 'string') continue;
    const isNativeSendMessage = part.name === 'SendMessage';
    const input = part.input;
    if (!input || typeof input !== 'object') continue;
    const inp = input as Record<string, unknown>;
    const isDirectCrossTeamSendTool = isAgentTeamsToolUse({
      rawName: part.name,
      canonicalName: 'cross_team_send',
      toolInput: inp,
      currentTeamName: run.teamName,
    });
    if (!isNativeSendMessage && !isDirectCrossTeamSendTool) continue;

    if (isDirectCrossTeamSendTool) {
      const toTeam = typeof inp.toTeam === 'string' ? inp.toTeam.trim() : '';
      const text = typeof inp.text === 'string' ? stripAgentBlocks(inp.text).trim() : '';
      if (toTeam && text) {
        run.pendingDirectCrossTeamSendRefresh = true;
      }
      continue;
    }

    const toolUseId = typeof part.id === 'string' ? part.id : '';
    if (!toolUseId) {
      ports.logger.warn(
        `[${run.teamName}] SendMessage without a tool_use id: its result can't be checked, ignoring it`
      );
      continue;
    }
    if (run.pendingLeadSendMessages.has(toolUseId)) continue;

    const rawRecipient = typeof inp.recipient === 'string' ? inp.recipient : '';
    const trimmedRecipient = rawRecipient.trim();
    if (!trimmedRecipient) continue;
    const recipient = trimmedRecipient.toLowerCase() === 'user' ? 'user' : trimmedRecipient;

    const msgContent = typeof inp.content === 'string' ? inp.content : '';
    if (msgContent.trim().length === 0) continue;

    const summary = typeof inp.summary === 'string' ? inp.summary : '';
    const leadName = resolveCrossTeamLeadName(run.request.members);

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
    // A tool_use id is unique per call, so parallel calls in the same millisecond keep apart.
    const messageId = `lead-sendmsg-${run.runId}-${toolUseId}`;

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
      const taskRefs = teamToolTaskRefs(run.teamName, inp.taskRefs);

      run.pendingLeadSendMessages.set(toolUseId, {
        kind: 'cross_team',
        recipient,
        request: {
          fromTeam: run.teamName,
          fromMember: leadName,
          toTeam: crossTeamRecipient.teamName,
          toMember: crossTeamRecipient.memberName,
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
        },
      });
      continue;
    }

    if (isCrossTeamToolRecipientName(recipient)) {
      continue;
    }

    if (recipient === 'user' && run.silentUserDmForward?.mode === 'member_inbox_relay') {
      ports.logger.debug(
        `[${run.teamName}] Suppressed SendMessage→user during member_inbox_relay to "${run.silentUserDmForward.target}"`
      );
      continue;
    }

    const msg: InboxMessage = {
      from: leadName,
      to: recipient,
      text: strippedCrossTeamContent,
      timestamp: ports.nowIso(),
      read: recipient !== 'user',
      summary: previewSummary(summary, strippedCrossTeamContent),
      messageId,
      source: 'lead_process',
    };

    run.pendingLeadSendMessages.set(toolUseId, {
      kind: 'local',
      recipient,
      summary,
      message: msg,
    });
  }
}

/** Forgets send calls that can no longer get a result (the turn ended). Nothing is sent. */
export function dropUnsettledLeadSendMessages(
  run: { teamName: string; pendingLeadSendMessages: Map<string, unknown> },
  logger: Pick<TeamProvisioningLeadSendMessageCaptureLogger, 'warn'>
): void {
  const count = run.pendingLeadSendMessages.size;
  if (count === 0) return;
  run.pendingLeadSendMessages.clear();
  logger.warn(`[${run.teamName}] Dropped ${count} lead send call(s) that got no tool result`);
}

function settleLeadSendMessage(
  run: TeamProvisioningLeadSendMessageRun,
  part: Record<string, unknown>,
  ports: TeamProvisioningLeadSendMessageCapturePorts
): void {
  const toolUseId = typeof part.tool_use_id === 'string' ? part.tool_use_id : '';
  const call = run.pendingLeadSendMessages.get(toolUseId);
  if (!call) return;
  run.pendingLeadSendMessages.delete(toolUseId);
  if (part.is_error === true) {
    ports.logger.debug(
      `[${run.teamName}] SendMessage→${call.recipient} failed in the runtime; nothing delivered`
    );
    return;
  }
  runLeadSendMessage(run, call, ports);
}

function runLeadSendMessage(
  run: TeamProvisioningLeadSendMessageRun,
  call: PendingLeadSendMessage,
  ports: TeamProvisioningLeadSendMessageCapturePorts
): void {
  if (call.kind === 'cross_team') {
    deliverCrossTeamLeadMessage(run, call.recipient, call.request, ports);
  } else {
    publishLocalLeadMessage(run, call.recipient, call.summary, call.message, ports);
  }
}

function previewSummary(summary: string, text: string): string {
  const value = summary || text;
  return value.length > 60 ? value.slice(0, 57) + '...' : value;
}

function deliverCrossTeamLeadMessage(
  run: TeamProvisioningLeadSendMessageRun,
  recipient: string,
  request: LeadCrossTeamSendRequest,
  ports: TeamProvisioningLeadSendMessageCapturePorts
): void {
  if (!ports.crossTeamSender) {
    ports.logger.warn(
      `[${run.teamName}] qualified SendMessage→${recipient} not delivered: cross-team sender is unavailable`
    );
    return;
  }
  void ports
    .crossTeamSender(request)
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
        from: request.fromMember,
        to: recipient.startsWith('cross-team:')
          ? recipient
          : `${request.toTeam}.${request.toMember}`,
        text: request.text,
        timestamp: request.timestamp,
        read: true,
        summary: previewSummary(request.summary, request.text),
        messageId: result.messageId,
        source: 'cross_team_sent',
        conversationId: request.conversationId,
        replyToConversationId: request.replyToConversationId,
        ...(request.taskRefs ? { taskRefs: request.taskRefs } : {}),
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
}

function publishLocalLeadMessage(
  run: TeamProvisioningLeadSendMessageRun,
  recipient: string,
  summary: string,
  message: InboxMessage,
  ports: TeamProvisioningLeadSendMessageCapturePorts
): void {
  const relayOfMessageId =
    recipient !== 'user'
      ? consumePendingInboxRelayCandidate(run, recipient, message.text, summary)
      : undefined;
  const msg: InboxMessage = relayOfMessageId ? { ...message, relayOfMessageId } : message;

  ports.pushLiveLeadProcessMessage(run.teamName, msg);

  if (recipient === 'user') {
    ports.persistSentMessage(run.teamName, msg);
    ports.emitInboxChange(run.teamName, 'sentMessages.json');
  } else {
    // Runtime SendMessage is the single durable writer of teammate inboxes (verified write);
    // the FileWatcher picks it up for UI refresh and OpenCode relay.
    ports.emitLeadMessageChange(run.teamName, run.runId, 'lead-send-message');
  }

  ports.logger.debug(
    `[${run.teamName}] Captured SendMessage→${recipient} from stdout: ${msg.text.slice(0, 100)}`
  );
}
