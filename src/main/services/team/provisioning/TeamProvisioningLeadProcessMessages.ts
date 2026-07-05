import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { formatToolSummaryFromCalls } from '@shared/utils/toolSummary';

import {
  boundLiveLeadProcessMessage,
  boundLiveLeadProcessText,
  boundRunProvisioningOutputParts,
} from './TeamProvisioningProgressBuffers';
import { getStableLeadThoughtMessageId } from './TeamProvisioningStreamEvents';

import type { InboxMessage, TeamChangeEvent, ToolCallMeta } from '@shared/types';

export interface TeamProvisioningLeadRelayCaptureLike {
  textParts: string[];
  textJoinMode?: 'block' | 'stream';
}

export interface TeamProvisioningLeadAssistantOutputRun {
  provisioningOutputParts: string[];
  provisioningOutputIndexByMessageId: Map<string, number>;
  stallWarningIndex: number | null;
  apiRetryWarningIndex: number | null;
}

export interface TeamProvisioningLeadTextRun {
  teamName: string;
  runId: string;
  leadMsgSeq: number;
  liveLeadTextBuffer: {
    messageId: string;
    text: string;
    timestamp: string;
    toolCalls?: ToolCallMeta[];
    toolSummary?: string;
  } | null;
  pendingToolCalls: ToolCallMeta[];
  lastLeadTextEmitMs: number;
}

export interface TeamProvisioningLiveLeadMessageRun {
  detectedSessionId?: string | null;
}

export interface TeamProvisioningLiveLeadMessageCleanupRun {
  runId: string;
  teamName: string;
  detectedSessionId?: string | null;
}

export interface PushLiveLeadProcessMessagePorts<TRun extends TeamProvisioningLiveLeadMessageRun> {
  liveLeadProcessMessages: Map<string, InboxMessage[]>;
  getTrackedRunId(teamName: string): string | null;
  getRun(runId: string): TRun | undefined;
  cacheLimit: number;
}

export interface LiveLeadProcessMessageStatePorts<TRun extends TeamProvisioningLiveLeadMessageRun> {
  liveLeadProcessMessages: Map<string, InboxMessage[]>;
  getTrackedRunId(teamName: string): string | null;
  getRun(runId: string): TRun | undefined;
}

export interface PushLiveLeadTextMessagePorts<TRun extends TeamProvisioningLeadTextRun> {
  nowMs(): number;
  nowIso(): string;
  getRunLeadName(run: TRun): string;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
  emitTeamChange(event: TeamChangeEvent): void;
  leadTextEmitThrottleMs: number;
}

export function joinLeadRelayCaptureText(capture: TeamProvisioningLeadRelayCaptureLike): string {
  return capture.textParts.join(capture.textJoinMode === 'stream' ? '' : '\n').trim();
}

export function pushLiveLeadProcessMessage<TRun extends TeamProvisioningLiveLeadMessageRun>(
  teamName: string,
  message: InboxMessage,
  ports: PushLiveLeadProcessMessagePorts<TRun>
): void {
  let cacheMessage = message;
  if (!cacheMessage.leadSessionId) {
    const runId = ports.getTrackedRunId(teamName);
    if (runId) {
      const run = ports.getRun(runId);
      if (run?.detectedSessionId) {
        cacheMessage = { ...cacheMessage, leadSessionId: run.detectedSessionId };
      }
    }
  }

  cacheMessage = boundLiveLeadProcessMessage(cacheMessage);
  const list = ports.liveLeadProcessMessages.get(teamName) ?? [];
  const id = typeof cacheMessage.messageId === 'string' ? cacheMessage.messageId.trim() : '';
  if (id) {
    const existingIdx = list.findIndex((m) => (m.messageId ?? '').trim() === id);
    if (existingIdx >= 0) {
      list[existingIdx] = cacheMessage;
    } else {
      list.push(cacheMessage);
    }
  } else {
    list.push(cacheMessage);
  }
  if (list.length > ports.cacheLimit) {
    list.splice(0, list.length - ports.cacheLimit);
  }
  ports.liveLeadProcessMessages.set(teamName, list);
}

export function getCurrentLeadSessionId<TRun extends TeamProvisioningLiveLeadMessageRun>(
  teamName: string,
  ports: Pick<LiveLeadProcessMessageStatePorts<TRun>, 'getTrackedRunId' | 'getRun'>
): string | null {
  const runId = ports.getTrackedRunId(teamName);
  if (!runId) return null;
  return ports.getRun(runId)?.detectedSessionId ?? null;
}

export function getLiveLeadProcessMessages<TRun extends TeamProvisioningLiveLeadMessageRun>(
  teamName: string,
  ports: LiveLeadProcessMessageStatePorts<TRun>
): InboxMessage[] {
  const detectedSessionId = getCurrentLeadSessionId(teamName, ports);

  return (ports.liveLeadProcessMessages.get(teamName) ?? []).map((message) =>
    !message.leadSessionId && detectedSessionId
      ? { ...message, leadSessionId: detectedSessionId }
      : { ...message }
  );
}

export function pruneLiveLeadMessagesForCleanedRun<
  TRun extends TeamProvisioningLiveLeadMessageCleanupRun,
>(run: TRun, liveLeadProcessMessages: Map<string, InboxMessage[]>): void {
  const list = liveLeadProcessMessages.get(run.teamName);
  if (!list || list.length === 0) {
    return;
  }

  const runMessageIdPrefixes = [
    `lead-turn-${run.runId}-`,
    `lead-sendmsg-${run.runId}-`,
    `lead-process-${run.runId}-`,
    `compact-${run.runId}-`,
  ];

  const filtered = list.filter((message) => {
    const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
    if (messageId && runMessageIdPrefixes.some((prefix) => messageId.startsWith(prefix))) {
      return false;
    }

    if (run.detectedSessionId && message.leadSessionId === run.detectedSessionId) {
      return false;
    }

    return true;
  });

  if (filtered.length === 0) {
    liveLeadProcessMessages.delete(run.teamName);
    return;
  }

  liveLeadProcessMessages.set(run.teamName, filtered);
}

export function resetLiveLeadTextBuffer(run: TeamProvisioningLeadTextRun): void {
  run.liveLeadTextBuffer = null;
}

export function appendProvisioningAssistantText(
  run: TeamProvisioningLeadAssistantOutputRun,
  msg: Record<string, unknown>,
  text: string
): void {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return;
  }

  const stableMessageId = getStableLeadThoughtMessageId(msg);
  if (stableMessageId) {
    const existingIndex = run.provisioningOutputIndexByMessageId.get(stableMessageId);
    if (existingIndex != null) {
      run.provisioningOutputParts[existingIndex] = text;
      boundRunProvisioningOutputParts(run);
      return;
    }
  }

  const lastIndex = run.provisioningOutputParts.length - 1;
  if (lastIndex >= 0 && run.provisioningOutputParts[lastIndex]?.trim() === normalized) {
    return;
  }

  const newIndex = run.provisioningOutputParts.push(text) - 1;
  if (stableMessageId) {
    run.provisioningOutputIndexByMessageId.set(stableMessageId, newIndex);
  }
  boundRunProvisioningOutputParts(run);
}

export function shiftProvisioningOutputIndexesAfterRemoval(
  run: TeamProvisioningLeadAssistantOutputRun,
  removedIndex: number
): void {
  for (const [messageId, index] of run.provisioningOutputIndexByMessageId.entries()) {
    if (index > removedIndex) {
      run.provisioningOutputIndexByMessageId.set(messageId, index - 1);
    }
  }
}

export function pushLiveLeadTextMessage<TRun extends TeamProvisioningLeadTextRun>(
  run: TRun,
  cleanText: string,
  stableMessageId: string | undefined,
  messageTimestamp: string | undefined,
  options: { coalesceStreamChunk?: boolean } | undefined,
  ports: PushLiveLeadTextMessagePorts<TRun>
): void {
  const leadName = ports.getRunLeadName(run);
  const timestamp =
    typeof messageTimestamp === 'string' &&
    messageTimestamp.trim().length > 0 &&
    Number.isFinite(Date.parse(messageTimestamp))
      ? messageTimestamp
      : ports.nowIso();
  const coalesceStreamChunk = options?.coalesceStreamChunk === true;
  let messageId = stableMessageId;
  let text = cleanText;
  let timestampForMessage = timestamp;
  let toolCalls: ToolCallMeta[] | undefined;
  let toolSummary: string | undefined;

  if (coalesceStreamChunk) {
    if (!run.liveLeadTextBuffer) {
      run.leadMsgSeq += 1;
      toolCalls = run.pendingToolCalls.length > 0 ? [...run.pendingToolCalls] : undefined;
      toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
      run.liveLeadTextBuffer = {
        messageId: `lead-turn-${run.runId}-${run.leadMsgSeq}`,
        text: boundLiveLeadProcessText(cleanText),
        timestamp,
        toolCalls,
        toolSummary,
      };
      run.pendingToolCalls = [];
    } else {
      run.liveLeadTextBuffer.text = boundLiveLeadProcessText(
        run.liveLeadTextBuffer.text + cleanText
      );
    }

    messageId = run.liveLeadTextBuffer.messageId;
    text = stripAgentBlocks(run.liveLeadTextBuffer.text).trim();
    timestampForMessage = run.liveLeadTextBuffer.timestamp;
    toolCalls = run.liveLeadTextBuffer.toolCalls;
    toolSummary = run.liveLeadTextBuffer.toolSummary;
  } else {
    resetLiveLeadTextBuffer(run);
    run.leadMsgSeq += 1;
    messageId = messageId || `lead-turn-${run.runId}-${run.leadMsgSeq}`;
    toolCalls = run.pendingToolCalls.length > 0 ? [...run.pendingToolCalls] : undefined;
    toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
    run.pendingToolCalls = [];
  }

  const leadMsg: InboxMessage = {
    from: leadName,
    text,
    timestamp: timestampForMessage,
    read: true,
    summary: text.length > 60 ? text.slice(0, 57) + '...' : text,
    messageId,
    source: 'lead_process',
    toolSummary,
    toolCalls,
  };
  ports.pushLiveLeadProcessMessage(run.teamName, leadMsg);

  const now = ports.nowMs();
  if (now - run.lastLeadTextEmitMs >= ports.leadTextEmitThrottleMs) {
    run.lastLeadTextEmitMs = now;
    ports.emitTeamChange({
      type: 'lead-message',
      teamName: run.teamName,
      runId: run.runId,
      detail: 'lead-text',
    });
  }
}
