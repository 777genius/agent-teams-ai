import type { RuntimeTurnSettledProvider } from './RuntimeTurnSettledProvider.js';

export interface RuntimeTurnSettledEvent {
  schemaVersion: 1;
  provider: RuntimeTurnSettledProvider;
  hookEventName: 'Stop';
  sourceId: string;
  payloadHash: string;
  recordedAt: string;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  transcriptPath?: string | undefined;
  cwd?: string | undefined;
  teamName?: string | undefined;
  memberName?: string | undefined;
  agentId?: string | undefined;
  threadId?: string | undefined;
  outcome?: string | undefined;
  runtimeInstanceId?: string | undefined;
  completedGeneration?: number | undefined;
}

export function buildRuntimeTurnSettledSourceId(input: {
  provider: RuntimeTurnSettledProvider;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  transcriptPath?: string | undefined;
  payloadHash: string;
}): string {
  return [
    'runtime-turn-settled',
    input.provider,
    input.sessionId?.trim() || 'no-session',
    input.turnId?.trim() || 'no-turn',
    input.transcriptPath?.trim() || 'no-transcript',
    input.payloadHash,
  ].join(':');
}
