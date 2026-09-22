import { describe, expect, it } from 'vitest';

import {
  decideOpenCodePromptDeliveryTurnActivity,
  OPENCODE_PROMPT_DELIVERY_TURN_ACTIVITY_CAP_MS,
  type OpenCodePromptDeliveryTurnActivityInput,
} from '../OpenCodePromptDeliveryWatchdog';

const BUSY = 'OpenCode session status busy';
const TREATED_IDLE =
  'OpenCode session status was busy but transcript has a completed assistant response for the latest user message; treating session as idle';

function activityInput(
  overrides: Partial<OpenCodePromptDeliveryTurnActivityInput> = {}
): OpenCodePromptDeliveryTurnActivityInput {
  return {
    previousAssistantMessageId: 'msg_assistant',
    previousToolCallCount: 2,
    previousAssistantPreview: 'Creating the board.',
    observation: {
      assistantMessageId: 'msg_assistant',
      toolCallNames: ['task_create', 'task_create'],
      latestAssistantPreview: 'Creating the board.',
    },
    observedDiagnostics: [TREATED_IDLE],
    pendingAgeMs: 90_000,
    ...overrides,
  };
}

describe('decideOpenCodePromptDeliveryTurnActivity', () => {
  it('treats a growing tool list inside one assistant message as an active turn', () => {
    // The bridged-runtime case: an ACP bridge runs its whole tool loop inside a
    // single OpenCode turn, so the assistant message id never changes.
    expect(
      decideOpenCodePromptDeliveryTurnActivity(
        activityInput({
          observation: {
            assistantMessageId: 'msg_assistant',
            toolCallNames: ['task_create', 'task_create', 'task_create', 'glob', 'read'],
            latestAssistantPreview: 'Creating the board.',
          },
        })
      )
    ).toEqual({ active: true, reason: 'tool_calls_progressed' });
  });

  it('treats growing assistant text inside one assistant message as an active turn', () => {
    expect(
      decideOpenCodePromptDeliveryTurnActivity(
        activityInput({
          observation: {
            assistantMessageId: 'msg_assistant',
            toolCallNames: ['task_create', 'task_create'],
            latestAssistantPreview: 'Creating the board. Assigning the first task.',
          },
        })
      )
    ).toEqual({ active: true, reason: 'assistant_text_progressed' });
  });

  it('reports an idle turn when nothing moved since the previous observation', () => {
    expect(decideOpenCodePromptDeliveryTurnActivity(activityInput())).toEqual({
      active: false,
      reason: 'turn_idle',
    });
  });

  it('keeps the raw busy session status as the strongest activity signal', () => {
    expect(
      decideOpenCodePromptDeliveryTurnActivity(
        activityInput({ observedDiagnostics: [BUSY, TREATED_IDLE] })
      )
    ).toEqual({ active: true, reason: 'session_status_busy' });
  });

  it('reports a new assistant message as an active turn', () => {
    expect(
      decideOpenCodePromptDeliveryTurnActivity(
        activityInput({
          observation: {
            assistantMessageId: 'msg_assistant_2',
            toolCallNames: ['task_create', 'task_create'],
            latestAssistantPreview: 'Creating the board.',
          },
        })
      )
    ).toEqual({ active: true, reason: 'assistant_message_progressed' });
  });

  it('keeps a non-bridged lane active on the message-id signal alone past every other signal', () => {
    // Negative control for the ACP-shaped signals: a runtime that opens a new
    // assistant message per step reports no tool growth and no text growth, and
    // must still be recognised as active rather than falling through to
    // `turn_idle` and being re-prompted mid-turn.
    expect(
      decideOpenCodePromptDeliveryTurnActivity(
        activityInput({
          previousToolCallCount: 5,
          previousAssistantPreview: 'Working.',
          observedDiagnostics: [TREATED_IDLE],
          observation: {
            assistantMessageId: 'msg_assistant_2',
            toolCallNames: ['glob'],
            latestAssistantPreview: 'Working.',
          },
        })
      )
    ).toEqual({ active: true, reason: 'assistant_message_progressed' });
  });

  it('stops deferring the retry once the absolute cap caps the inferred signals', () => {
    expect(
      decideOpenCodePromptDeliveryTurnActivity(
        activityInput({
          pendingAgeMs: OPENCODE_PROMPT_DELIVERY_TURN_ACTIVITY_CAP_MS + 1,
          observedDiagnostics: [TREATED_IDLE],
          observation: {
            assistantMessageId: 'msg_assistant',
            toolCallNames: ['task_create', 'task_create', 'task_create'],
            latestAssistantPreview: 'Still working.',
          },
        })
      )
    ).toEqual({ active: false, reason: 'turn_activity_absolute_cap' });
  });

  it('keeps a busy session active past the absolute cap', () => {
    // Negative control for the cap: a tool-heavy first turn can run past ten
    // minutes, and capping a session the bridge still reports busy re-prompts
    // mid-turn, which is the double answer this guard exists to prevent.
    expect(
      decideOpenCodePromptDeliveryTurnActivity(
        activityInput({
          pendingAgeMs: OPENCODE_PROMPT_DELIVERY_TURN_ACTIVITY_CAP_MS * 3,
          observedDiagnostics: [BUSY],
        })
      )
    ).toEqual({ active: true, reason: 'session_status_busy' });
  });

  it('closes the first-observation hole left by acceptance-mode sends', () => {
    // An `acceptance` settlement records no assistant message id, so the
    // assistant-id signal alone can never fire on the first watchdog pass.
    expect(
      decideOpenCodePromptDeliveryTurnActivity(
        activityInput({
          previousAssistantMessageId: '',
          previousToolCallCount: 0,
          previousAssistantPreview: '',
          observation: {
            assistantMessageId: 'msg_assistant',
            toolCallNames: ['task_create'],
            latestAssistantPreview: null,
          },
        })
      )
    ).toEqual({ active: true, reason: 'tool_calls_progressed' });
  });

  it('never treats an unknown pending age as capped', () => {
    expect(
      decideOpenCodePromptDeliveryTurnActivity(
        activityInput({
          pendingAgeMs: null,
          observation: {
            assistantMessageId: 'msg_assistant',
            toolCallNames: ['task_create', 'task_create', 'task_create'],
            latestAssistantPreview: 'Creating the board.',
          },
        })
      )
    ).toEqual({ active: true, reason: 'tool_calls_progressed' });
  });
});
