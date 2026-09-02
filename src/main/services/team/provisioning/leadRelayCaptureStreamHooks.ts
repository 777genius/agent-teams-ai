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
  settled: boolean;
  idleHandle: NodeJS.Timeout | null;
  idleMs: number;
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
