import { type SemanticStep } from '../types';

interface GapFillingInput {
  steps: SemanticStep[];
  chunkStartTime: Date;
  chunkEndTime: Date;
}

/**
 * Fill timeline gaps so steps extend to next step's start.
 * Handles parallel steps (don't extend past each other).
 * Preserves real timing for subagents.
 */
export function fillTimelineGaps(input: GapFillingInput): SemanticStep[] {
  const { steps, chunkEndTime } = input;

  if (steps.length === 0) return [];

  // Sort by startTime
  const sorted = [...steps].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  for (let i = 0; i < sorted.length; i++) {
    const step = sorted[i];

    // Keep original timing for subagents and steps with meaningful duration
    if (step.type === 'subagent' && step.endTime && step.durationMs > 100) {
      step.effectiveEndTime = step.endTime;
      step.effectiveDurationMs = step.durationMs;
      step.isGapFilled = false;
      continue;
    }

    // Find next non-parallel step
    let nextStepStart: Date | null = null;
    for (let j = i + 1; j < sorted.length; j++) {
      const candidate = sorted[j];

      // Skip parallel siblings (within 100ms window)
      const timeDiff = candidate.startTime.getTime() - step.startTime.getTime();
      if (timeDiff < 100) continue;

      nextStepStart = candidate.startTime;
      break;
    }

    // Set effective end time
    step.effectiveEndTime = nextStepStart ?? chunkEndTime;
    step.effectiveDurationMs = step.effectiveEndTime.getTime() - step.startTime.getTime();
    step.isGapFilled = true;
  }

  return sorted;
}
