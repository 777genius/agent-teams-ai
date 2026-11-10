import { describe, expect, it } from 'vitest';

import { filterMessagesForAttribution } from '@main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionProjection';

import type { OpenCodeRuntimeTranscriptLogMessage } from '@main/services/runtime/ClaudeMultimodelBridgeService';

const timestamp = '2026-09-08T10:00:00.000Z';

function prompt(uuid: string): OpenCodeRuntimeTranscriptLogMessage {
  return {
    uuid,
    parentUuid: null,
    type: 'user',
    role: 'user',
    timestamp,
    content: [{ type: 'text', text: 'Task assignment' }],
    isMeta: false,
    sessionId: 'session-test',
    toolCalls: [],
    toolResults: [],
  };
}

// An error-only assistant has no projected row. Its synthetic error keeps its
// own UUID and links directly to the prompt, matching the runtime projector.
function runtimeError(
  assistantUuid: string,
  parentUuid: string
): OpenCodeRuntimeTranscriptLogMessage {
  return {
    uuid: `${assistantUuid}::error`,
    parentUuid,
    type: 'system',
    timestamp,
    content: 'OpenCode runtime error - UnknownError: Token refresh failed: 401',
    model: 'openai/gpt-5.4-mini',
    agentName: 'teammate',
    isMeta: true,
    sessionId: 'session-test',
    toolCalls: [],
    toolResults: [],
    subtype: 'informational',
    level: 'error',
  };
}

describe('OpenCode error attribution', () => {
  it.each([false, true])('includes own runtime error with assistant content: %s', (hasContent) => {
    const ownPrompt = prompt('prompt-own');
    const messages: OpenCodeRuntimeTranscriptLogMessage[] = [ownPrompt];
    if (hasContent) {
      messages.push({
        ...ownPrompt,
        uuid: 'assistant-own',
        parentUuid: ownPrompt.uuid,
        type: 'assistant',
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial answer' }],
      });
    }
    messages.push(
      runtimeError('assistant-own', hasContent ? 'assistant-own' : ownPrompt.uuid),
      prompt('prompt-other'),
      runtimeError('assistant-other', 'prompt-other')
    );

    const attributed = filterMessagesForAttribution(messages, {
      taskId: 'task-test',
      memberName: 'teammate',
      scope: 'member_session_window',
      source: 'delivery_ledger',
      sessionId: 'session-test',
      startMessageUuid: ownPrompt.uuid,
      since: timestamp,
      until: timestamp,
    });

    expect(attributed.map((message) => message.uuid)).toEqual([
      ownPrompt.uuid,
      ...(hasContent ? ['assistant-own'] : []),
      'assistant-own::error',
    ]);
    expect(attributed.at(-1)).toMatchObject({ type: 'system', level: 'error' });
  });
});
