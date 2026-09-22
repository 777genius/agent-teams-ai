import type { RuntimeTurnSettledProvider } from './RuntimeTurnSettledProvider';

export interface RuntimeTurnSettledEvent {
  schemaVersion: 1;
  provider: RuntimeTurnSettledProvider;
  hookEventName: 'Stop';
  sourceId: string;
  payloadHash: string;
  recordedAt: string;
  sessionId?: string;
  turnId?: string;
  transcriptPath?: string;
  cwd?: string;
  teamName?: string;
  memberName?: string;
  agentId?: string;
  threadId?: string;
  outcome?: string;
  runtimeInstanceId?: string;
  completedGeneration?: number;
}

export function buildRuntimeTurnSettledSourceId(input: {
  provider: RuntimeTurnSettledProvider;
  sessionId?: string;
  turnId?: string;
  transcriptPath?: string;
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
