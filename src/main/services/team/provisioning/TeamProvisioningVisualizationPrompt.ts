import { protocols } from 'agent-teams-controller';

export function buildLeadChatVisualizationProtocol(): string {
  return protocols.buildChatVisualizationProtocolText();
}

const STARTUP_BRIEFING_RECOVERY = [
  '[truncated startup briefing]',
  'This startup context is incomplete; omitted task details do not mean there is no assigned work.',
  'During the private bootstrap turn, do not start work or send messages. Reply locally only as instructed by the existing bootstrap flow, then wait for launch readiness.',
  'After launch readiness is confirmed and before acting on real work, call member_briefing once for your configured identity to retrieve the complete current role, workflow and operating rules. Use task_briefing as the current working queue and task_get for the selected task. Do not use these reads to prove launch readiness. If the full context is unavailable, report the blocker through the existing team channel after readiness and wait instead of guessing.',
].join('\n');

/** Keep ordinary briefing context first; include the full display spec only when both fit. */
export function buildChatVisualizationBriefing(briefing: string, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new Error('Invalid startup briefing character budget');
  }
  // Compact native fields and the retained OpenCode boundary can already have omitted data.
  // Preserve the recovery instruction even when their marker falls outside the final preview.
  const alreadyIncomplete =
    briefing.includes('[truncated native bootstrap context]') ||
    briefing.includes('[truncated app-managed briefing]') ||
    briefing.includes('[truncated startup briefing]');
  const protocol = protocols.buildChatVisualizationProtocolText();
  const refresh = protocols.buildChatVisualizationRefreshInstruction();
  const recovery = alreadyIncomplete ? `${STARTUP_BRIEFING_RECOVERY}\n\n` : '';
  for (const display of [protocol, refresh]) {
    const suffix = recovery + display;
    if (briefing.length + suffix.length + 2 <= maxChars) {
      return `${briefing.trimEnd()}\n\n${suffix}`;
    }
  }

  // Bound once, reserving the complete recovery rules and display refresh before slicing.
  const suffix = `${STARTUP_BRIEFING_RECOVERY}\n\n${refresh}`;
  const budget = maxChars - suffix.length - 2;
  if (budget < 0) {
    throw new Error('Startup briefing budget cannot retain complete recovery instructions');
  }
  const preview = briefing
    .slice(0, budget)
    .replace(/[\uD800-\uDBFF]$/u, '')
    .trimEnd();
  return `${preview}\n\n${suffix}`;
}
