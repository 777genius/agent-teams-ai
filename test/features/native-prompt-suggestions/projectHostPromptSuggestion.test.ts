import { describe, expect, it } from 'vitest';

import { projectHostPromptSuggestion } from '../../../src/features/native-prompt-suggestions/main/projectHostPromptSuggestion';

const original = Object.freeze({
  provider: 'codex',
  teamId: 'TEST-team-A',
  runId: 'TEST-run-A',
  memberId: 'TEST-member-A',
  memberName: 'Alice',
  generation: 'TEST-gen-A',
  suggestionId: 'TEST-suggestion-A',
  messageId: 'TEST-message-A',
  inputId: 'TEST-input-A',
  operationRef: 'TEST-operation-A',
  completedTurnRef: 'TEST-native-turn-A',
  text: 'Review tests and open a PR',
});

describe('captured Host suggestion projection', () => {
  it('projects only one exact original owner/team and a matching personal conversation', () => {
    const result = projectHostPromptSuggestion(original, 'host-team:TEST-public-handle', 'TEST-team-A');
    expect(result).toEqual({
      ownerHandle: 'host-team:TEST-public-handle',
      provider: original.provider,
      teamId: original.teamId,
      runId: original.runId,
      memberId: original.memberId,
      memberName: original.memberName,
      generation: original.generation,
      suggestionId: original.suggestionId,
      messageId: original.messageId,
      operationRef: original.operationRef,
      completedTurnRef: original.completedTurnRef,
      text: original.text,
      conversationRef: 'direct:alice',
    });
    expect(result).not.toHaveProperty('inputId');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['foreign team', { teamId: 'TEST-other' }],
    ['missing native turn', { completedTurnRef: undefined }],
    ['missing message', { messageId: undefined }],
    ['missing member id', { memberId: undefined }],
    ['foreign provider', { provider: 'opencode' }],
    ['oversized model output', { text: 'x'.repeat(513) }],
    ['control character', { text: 'RUN\u0000TOOL' }],
    ['invalid member name', { memberName: 'A\nb' }],
  ] as const)('suppresses %s before IPC/SSE', (_name, mutation) => {
    expect(projectHostPromptSuggestion({ ...original, ...mutation }, 'host-team:TEST-public-handle', 'TEST-team-A')).toBeNull();
  });
});
