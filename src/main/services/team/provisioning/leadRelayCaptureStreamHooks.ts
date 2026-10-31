import { classifyCapturedSend } from './leadRelayCapturedMessageTools';

/**
 * Stream-side state of an in-flight lead inbox relay capture.
 *
 * The relay flow owns the richer capture record; this is the subset the
 * stream-json handler is allowed to see and mutate while a lead turn runs.
 */
export interface LeadRelayCaptureStreamState {
  textParts: string[];
  textJoinMode?: 'block' | 'stream';
  recoveryMessageId?: string;
  requireTerminalResult?: boolean;
  terminalResultSucceeded?: boolean;
  hasVisibleSendMessage?: boolean;
  hasUserVisibleSendMessage?: boolean;
  /** Send calls of this capture waiting for their tool_result, keyed by tool_use id. */
  pendingSendVisibility?: Map<string, { visible: boolean; userVisible: boolean }>;
  settled: boolean;
  idleHandle: NodeJS.Timeout | null;
  idleMs: number;
  /** Extends the capture's reply deadline; set by the relay flow that owns the capture. */
  touch?: () => void;
  resolveOnce: (text: string) => void;
  rejectOnce: (error: string) => void;
}

export function isSyntheticLeadTextChunk(msg: Record<string, unknown>): boolean {
  const message = (msg.message ?? msg) as Record<string, unknown>;
  return message.model === '<synthetic>' && message.type === 'message';
}

export function joinLeadRelayCaptureText(capture: LeadRelayCaptureStreamState): string {
  return capture.textParts.join(capture.textJoinMode === 'stream' ? '' : '\n').trim();
}

export function appendLeadRelayCaptureAssistantText(
  capture: LeadRelayCaptureStreamState,
  input: {
    text: string;
    isSyntheticChunk: boolean;
    boundTextParts: (parts: string[]) => string[];
  }
): void {
  const { text, isSyntheticChunk, boundTextParts } = input;
  if (isSyntheticChunk) {
    capture.textJoinMode = 'stream';
  } else if (!capture.textJoinMode) {
    capture.textJoinMode = 'block';
  }
  capture.textParts.push(text);
  capture.textParts = boundTextParts(capture.textParts);
  if (capture.idleHandle) {
    clearTimeout(capture.idleHandle);
  }
  if (!capture.requireTerminalResult) {
    capture.idleHandle = setTimeout(() => {
      const combined = joinLeadRelayCaptureText(capture);
      capture.resolveOnce(combined);
    }, capture.idleMs);
  }
}

export function resolveLeadRelayCaptureOnTerminalResult(
  capture: LeadRelayCaptureStreamState | null
): void {
  if (!capture) return;
  capture.terminalResultSucceeded = true;
  const combined = joinLeadRelayCaptureText(capture);
  capture.resolveOnce(combined);
}

/**
 * Records lead send calls for relay text suppression. A group send counts right away (a rejected
 * group attempt must never become a private/plaintext fallback); any other send counts only once
 * its tool_result succeeds, so a rejected call never hides the lead's plain reply.
 */
export function noteLeadRelayCaptureSendCalls(
  capture: LeadRelayCaptureStreamState,
  content: Record<string, unknown>[],
  teamName: string
): void {
  for (const part of content) {
    const send = classifyCapturedSend(part, teamName);
    if (!send) continue;
    if (send.group) {
      capture.hasVisibleSendMessage = true;
      capture.hasUserVisibleSendMessage = true;
      continue;
    }
    // Without an id the result can't be matched; a duplicate reply is better than a lost one.
    if (typeof part.id !== 'string' || part.id.length === 0) continue;
    capture.pendingSendVisibility ??= new Map();
    capture.pendingSendVisibility.set(part.id, {
      visible: send.visible,
      userVisible: send.userVisible,
    });
  }
}

export function settleLeadRelayCaptureSendCalls(
  capture: LeadRelayCaptureStreamState,
  content: Record<string, unknown>[]
): void {
  const pending = capture.pendingSendVisibility;
  if (!pending) return;
  for (const part of content) {
    if (part.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
    const send = pending.get(part.tool_use_id);
    if (!send) continue;
    pending.delete(part.tool_use_id);
    if (part.is_error === true) continue;
    if (send.visible) capture.hasVisibleSendMessage = true;
    if (send.userVisible) capture.hasUserVisibleSendMessage = true;
  }
}
