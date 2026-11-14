import type { NativeNextPromptCandidate } from '../contracts';

/** Read-only Main boundary: no provider/session objects or renderer-chosen identity. */
export function projectHostPromptSuggestion(
  raw: unknown,
  ownerHandle: string,
  expectedTeamId: string,
  expectedRunId: string
): NativeNextPromptCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const bounded = (key: string, limit = 256): string | null => {
    const text = value[key];
    return typeof text === 'string' && text.length > 0 && text.length <= limit &&
      !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
  };
  const provider = value.provider;
  if (provider !== 'claude' && provider !== 'codex') return null;
  const teamId = bounded('teamId');
  const memberName = bounded('memberName', 128);
  const text = bounded('text', 512);
  if (!teamId || teamId !== expectedTeamId ||
      bounded('runId') !== expectedRunId || !memberName || !text ||
      new TextEncoder().encode(text).length > 512 ||
      !ownerHandle || ownerHandle.length > 256) return null;
  const keys = ['runId','memberId','generation','suggestionId',
    'messageId','operationRef','inputId','completedTurnRef'] as const;
  const all = keys.map(key => bounded(key));
  if (all.some(item => item === null)) return null;
  const [runId, memberId, generation, suggestionId,
    messageId, operationRef, inputId, completedTurnRef] = all as string[];
  return Object.freeze({
    ownerHandle, provider, teamId, memberName, runId: runId!,
    memberId: memberId!, generation: generation!, suggestionId: suggestionId!,
    messageId: messageId!, inputId: inputId!, operationRef: operationRef!,
    completedTurnRef: completedTurnRef!, text,
    conversationRef: `direct:${memberName.trim().toLowerCase()}`,
  });
}
