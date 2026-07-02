import {
  boundProgressAssistantParts,
  boundProgressLogLines,
  buildProgressLiveOutput,
  buildProgressTraceLine,
  PROGRESS_RETAINED_LOG_CHARS,
  PROGRESS_RETAINED_LOG_LINE_CHARS,
} from '../progressPayload';

import type { InboxMessage, TeamProvisioningProgress, TeamProvisioningState } from '@shared/types';

const CLI_LOG_LINE_CARRY_LIMIT = PROGRESS_RETAINED_LOG_LINE_CHARS;
// Bounds the incomplete stream-json line still waiting for its terminating
// newline. Must stay large enough to hold a full single NDJSON event (large
// assistant messages, tool_result payloads, bootstrap-transcript events) so we
// never truncate mid-JSON and silently drop the event when JSON.parse fails.
const STDOUT_PARSER_CARRY_LIMIT = PROGRESS_RETAINED_LOG_CHARS;
const PROBE_OUTPUT_BUFFER_LIMIT = 128 * 1024;
const LIVE_LEAD_PROCESS_MESSAGE_TEXT_LIMIT = 32 * 1024;
const PROVISIONING_TRACE_STORAGE_LIMIT = 500;

export interface TeamProvisioningTraceRun {
  progress: TeamProvisioningProgress;
  provisioningTraceLines: string[];
  lastProvisioningTraceKey?: string | null;
  provisioningOutputParts: string[];
  provisioningOutputIndexByMessageId: Map<string, number>;
  stallWarningIndex: number | null;
  apiRetryWarningIndex: number | null;
}

export interface TeamProvisioningLogLinesRun {
  claudeLogLines: string[];
}

export interface TeamProvisioningCheckpointRun extends TeamProvisioningTraceRun {
  onProgress(progress: TeamProvisioningProgress): void;
}

export function appendProvisioningTrace(
  run: TeamProvisioningTraceRun,
  state: Exclude<TeamProvisioningState, 'idle'>,
  message: string,
  detail?: string
): void {
  run.provisioningTraceLines ??= [];
  run.lastProvisioningTraceKey ??= null;
  const key = `${state}\u0000${message}\u0000${detail ?? ''}`;
  if (run.lastProvisioningTraceKey === key) {
    return;
  }
  run.lastProvisioningTraceKey = key;
  run.provisioningTraceLines.push(
    buildProgressTraceLine({
      timestamp: new Date().toISOString(),
      state,
      message,
      detail,
    })
  );
  if (run.provisioningTraceLines.length > PROVISIONING_TRACE_STORAGE_LIMIT) {
    run.provisioningTraceLines.splice(
      0,
      run.provisioningTraceLines.length - PROVISIONING_TRACE_STORAGE_LIMIT
    );
  }
}

export function buildProvisioningLiveOutput(
  run: Pick<
    TeamProvisioningTraceRun,
    | 'provisioningTraceLines'
    | 'provisioningOutputParts'
    | 'provisioningOutputIndexByMessageId'
    | 'stallWarningIndex'
    | 'apiRetryWarningIndex'
  >
): string | undefined {
  boundRunProvisioningOutputParts(run);
  return buildProgressLiveOutput(run.provisioningTraceLines, run.provisioningOutputParts);
}

export function boundRunClaudeLogLines(run: TeamProvisioningLogLinesRun): void {
  const bounded = boundProgressLogLines(run.claudeLogLines);
  if (
    bounded.length === run.claudeLogLines.length &&
    bounded.every((line, index) => line === run.claudeLogLines[index])
  ) {
    return;
  }
  run.claudeLogLines.splice(0, run.claudeLogLines.length, ...bounded);
}

export function boundSingleRetainedLogLine(line: string): string {
  return boundProgressLogLines([line], { maxLines: 1 })[0] ?? '';
}

export function boundPendingLogLineCarry(carry: string): string {
  if (carry.length <= CLI_LOG_LINE_CARRY_LIMIT) {
    return carry;
  }
  const marker = '...[truncated pending line]\n';
  if (CLI_LOG_LINE_CARRY_LIMIT <= marker.length) {
    return carry.slice(-CLI_LOG_LINE_CARRY_LIMIT);
  }
  return `${marker}${carry.slice(-(CLI_LOG_LINE_CARRY_LIMIT - marker.length))}`;
}

export function boundStdoutParserCarry(carry: string): string {
  if (carry.length <= STDOUT_PARSER_CARRY_LIMIT) {
    return carry;
  }
  return carry.slice(-STDOUT_PARSER_CARRY_LIMIT);
}

export function boundProbeOutputBuffer(text: string): string {
  if (text.length <= PROBE_OUTPUT_BUFFER_LIMIT) {
    return text;
  }
  const marker = '...[truncated probe output]';
  if (PROBE_OUTPUT_BUFFER_LIMIT <= marker.length) {
    return text.slice(-PROBE_OUTPUT_BUFFER_LIMIT);
  }
  const retainedChars = PROBE_OUTPUT_BUFFER_LIMIT - marker.length;
  const headChars = Math.floor(retainedChars / 2);
  const tailChars = retainedChars - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

export function boundLiveLeadProcessText(text: string): string {
  if (text.length <= LIVE_LEAD_PROCESS_MESSAGE_TEXT_LIMIT) {
    return text;
  }
  const marker = '\n...[truncated live message]\n';
  if (LIVE_LEAD_PROCESS_MESSAGE_TEXT_LIMIT <= marker.length) {
    return text.slice(0, LIVE_LEAD_PROCESS_MESSAGE_TEXT_LIMIT);
  }
  const retainedChars = LIVE_LEAD_PROCESS_MESSAGE_TEXT_LIMIT - marker.length;
  const headChars = Math.floor(retainedChars / 2);
  const tailChars = retainedChars - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

export function boundLiveLeadProcessMessage(message: InboxMessage): InboxMessage {
  const text = boundLiveLeadProcessText(message.text);
  if (text === message.text) {
    return message;
  }
  return {
    ...message,
    text,
    summary: text.length > 60 ? `${text.slice(0, 57)}...` : text,
  };
}

export function boundRunProvisioningOutputParts(
  run: Pick<
    TeamProvisioningTraceRun,
    | 'provisioningOutputParts'
    | 'provisioningOutputIndexByMessageId'
    | 'stallWarningIndex'
    | 'apiRetryWarningIndex'
  >
): void {
  const originalLength = run.provisioningOutputParts.length;
  const bounded = boundProgressAssistantParts(run.provisioningOutputParts);
  if (
    bounded.length === originalLength &&
    bounded.every((part, index) => part === run.provisioningOutputParts[index])
  ) {
    return;
  }

  const removedFromStart = Math.max(0, originalLength - bounded.length);
  run.provisioningOutputParts.splice(0, originalLength, ...bounded);
  if (removedFromStart <= 0) {
    return;
  }

  for (const [messageId, index] of Array.from(run.provisioningOutputIndexByMessageId.entries())) {
    if (index < removedFromStart) {
      run.provisioningOutputIndexByMessageId.delete(messageId);
    } else {
      run.provisioningOutputIndexByMessageId.set(messageId, index - removedFromStart);
    }
  }

  run.stallWarningIndex =
    run.stallWarningIndex == null
      ? null
      : run.stallWarningIndex < removedFromStart
        ? null
        : run.stallWarningIndex - removedFromStart;
  run.apiRetryWarningIndex =
    run.apiRetryWarningIndex == null
      ? null
      : run.apiRetryWarningIndex < removedFromStart
        ? null
        : run.apiRetryWarningIndex - removedFromStart;
}

export function initializeProvisioningTrace(run: TeamProvisioningTraceRun): void {
  appendProvisioningTrace(run, run.progress.state, run.progress.message);
  run.progress = {
    ...run.progress,
    assistantOutput: buildProvisioningLiveOutput(run) ?? run.progress.assistantOutput,
  };
}

export function emitProvisioningCheckpoint(
  run: TeamProvisioningCheckpointRun,
  message: string,
  detail?: string
): void {
  appendProvisioningTrace(run, run.progress.state, message, detail);
  run.progress = {
    ...run.progress,
    updatedAt: new Date().toISOString(),
    assistantOutput: buildProvisioningLiveOutput(run) ?? run.progress.assistantOutput,
  };
  run.onProgress(run.progress);
}
