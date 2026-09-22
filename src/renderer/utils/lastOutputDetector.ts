/**
 * Last Output Detector - Find the last visible output in an AI Group
 *
 * Uses a state machine approach to find the last meaningful output
 * for display in the chat UI.
 */

import { toDate } from './aiGroupHelpers';

import type { SemanticStep } from '../types/data';
import type { AIGroupLastOutput } from '../types/groups';

/**
 * Find the last visible output in the AI Group.
 *
 * Strategy:
 * 1. If isOngoing is true, return 'ongoing' type (session still in progress)
 * 2. Check for ExitPlanMode tool_call as special 'plan_exit' type
 * 3. Iterate through steps in reverse order
 * 4. Find the last 'output' step with outputText
 * 5. If no output found, find the last 'tool_result' step
 * 6. If no tool_result found, find the last 'interruption' step
 * 7. Return null if none exists
 *
 * Special case: ExitPlanMode
 * When the last tool_call is ExitPlanMode, return 'plan_exit' type with the plan content.
 * The preamble text (if any) is captured from the preceding output step.
 *
 * @param steps - Semantic steps from the AI Group
 * @param isOngoing - Whether this AI group is still in progress
 * @returns The last output or null
 */
export function findLastOutput(
  steps: SemanticStep[],
  isOngoing: boolean = false
): AIGroupLastOutput | null {
  // Check for interruption first - interruption takes precedence over ongoing status
  // This ensures user interruptions are always visible even if session appears ongoing
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === 'interruption') {
      return {
        type: 'interruption',
        timestamp: step.startTime,
      };
    }
  }

  // If session is ongoing (and no interruption), return 'ongoing' type
  if (isOngoing) {
    return {
      type: 'ongoing',
      timestamp: steps.length > 0 ? toDate(steps[steps.length - 1].startTime) : new Date(),
    };
  }

  // Check for ExitPlanMode as the last significant activity
  // ExitPlanMode is a special ending tool that signals plan completion
  let lastExitPlanModeStep: SemanticStep | null = null;
  let lastOutputBeforeExitPlanMode: SemanticStep | null = null;

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === 'tool_call' && step.content.toolName === 'ExitPlanMode') {
      lastExitPlanModeStep = step;
      // Look for the preceding output step (preamble text)
      for (let j = i - 1; j >= 0; j--) {
        if (steps[j].type === 'output' && steps[j].content.outputText) {
          lastOutputBeforeExitPlanMode = steps[j];
          break;
        }
      }
      break;
    }
  }

  // If ExitPlanMode is found, check if it's the "last" activity
  // (no other output or tool_result comes after it)
  if (lastExitPlanModeStep) {
    const exitPlanModeIndex = steps.indexOf(lastExitPlanModeStep);
    let hasLaterEnding = false;

    for (let i = exitPlanModeIndex + 1; i < steps.length; i++) {
      const step = steps[i];
      if (step.type === 'output' && step.content.outputText) {
        hasLaterEnding = true;
        break;
      }
      if (step.type === 'tool_result' && step.content.toolResultContent) {
        hasLaterEnding = true;
        break;
      }
    }

    if (!hasLaterEnding) {
      // ExitPlanMode is the last significant activity - return plan_exit
      const toolInput = lastExitPlanModeStep.content.toolInput as
        | Record<string, unknown>
        | undefined;
      const planContent = toolInput?.plan as string | undefined;

      return {
        type: 'plan_exit',
        planContent: planContent ?? '',
        planPreamble: lastOutputBeforeExitPlanMode?.content.outputText,
        timestamp: lastExitPlanModeStep.startTime,
      };
    }
  }

  // First pass: look for last 'output' step with outputText
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === 'output' && step.content.outputText) {
      return {
        type: 'text',
        text: step.content.outputText,
        timestamp: step.startTime,
      };
    }
  }

  // Second pass: look for last 'tool_result' step
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === 'tool_result' && step.content.toolResultContent) {
      return {
        type: 'tool_result',
        toolName: step.content.toolName,
        toolResult: step.content.toolResultContent,
        isError: step.content.isError ?? false,
        timestamp: step.startTime,
      };
    }
  }

  // Third pass: look for last 'interruption' step
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === 'interruption' && step.content.interruptionText) {
      return {
        type: 'interruption',
        interruptionMessage: step.content.interruptionText,
        timestamp: step.startTime,
      };
    }
  }

  return null;
}
