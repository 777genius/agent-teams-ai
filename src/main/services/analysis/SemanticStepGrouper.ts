/**
 * SemanticStepGrouper - Groups semantic steps for UI presentation.
 *
 * Groups steps by their source assistant message for collapsible UI.
 * Steps from the same assistant message share the message UUID.
 */

import type { SemanticStep, SemanticStepGroup } from '@main/types';

/**
 * Build semantic step groups from steps.
 * Groups steps by their source assistant message for collapsible UI.
 */
export function buildSemanticStepGroups(steps: SemanticStep[]): SemanticStepGroup[] {
  const groups: SemanticStepGroup[] = [];
  let groupIdCounter = 0;

  // Group steps by assistant message or standalone type
  const stepsByGroup = new Map<string | null, SemanticStep[]>();

  for (const step of steps) {
    const messageId = extractMessageIdFromStep(step);
    const existingSteps = stepsByGroup.get(messageId) ?? [];
    existingSteps.push(step);
    stepsByGroup.set(messageId, existingSteps);
  }

  // Build groups
  for (const [messageId, groupSteps] of stepsByGroup) {
    const startTime = groupSteps[0].startTime;
    const endTimes = groupSteps
      .map((s) => s.endTime ?? new Date(s.startTime.getTime() + s.durationMs))
      .map((d) => d.getTime());
    const endTime = new Date(Math.max(...endTimes));
    const totalDuration = groupSteps.reduce((sum, s) => sum + s.durationMs, 0);

    groups.push({
      id: `group-${++groupIdCounter}`,
      label: buildGroupLabel(groupSteps),
      steps: groupSteps,
      isGrouped: messageId !== null && groupSteps.length > 1,
      sourceMessageId: messageId ?? undefined,
      startTime,
      endTime,
      totalDuration,
    });
  }

  // Sort by startTime
  return groups.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

/**
 * Extract the assistant message ID from a step, or null if standalone.
 * Steps from the same assistant message share the message UUID.
 * Subagents, tool results, and interruptions are standalone (null).
 */
function extractMessageIdFromStep(step: SemanticStep): string | null {
  // Use sourceMessageId if available
  if (step.sourceMessageId) {
    return step.sourceMessageId;
  }

  // Standalone steps (not grouped)
  if (step.type === 'subagent') return null;
  if (step.type === 'tool_result') return null;
  if (step.type === 'interruption') return null;
  if (step.type === 'tool_call') return null; // Tool calls are standalone

  return null;
}

/**
 * Build a descriptive label for a group.
 */
function buildGroupLabel(steps: SemanticStep[]): string {
  if (steps.length === 1) {
    const step = steps[0];
    switch (step.type) {
      case 'thinking':
        return 'Thinking';
      case 'tool_call':
        return `Tool: ${step.content.toolName ?? 'Unknown'}`;
      case 'tool_result':
        return `Result: ${step.content.isError ? 'Error' : 'Success'}`;
      case 'subagent':
        return step.content.subagentDescription ?? 'Subagent';
      case 'output':
        return 'Output';
      case 'interruption':
        return 'Interruption';
    }
  }

  // Multiple steps grouped together
  const hasThinking = steps.some((s) => s.type === 'thinking');
  const hasOutput = steps.some((s) => s.type === 'output');
  const toolCalls = steps.filter((s) => s.type === 'tool_call');

  if (toolCalls.length > 0) {
    return `Tools (${toolCalls.length})`;
  }
  if (hasThinking && hasOutput) {
    return 'Assistant Response';
  }
  if (hasThinking) {
    return 'Thinking';
  }
  if (hasOutput) {
    return 'Output';
  }

  return `Response (${steps.length} steps)`;
}
