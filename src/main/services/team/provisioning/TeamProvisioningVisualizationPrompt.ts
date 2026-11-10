import { protocols } from 'agent-teams-controller';

export function buildLeadChatVisualizationProtocol(): string {
  return protocols.buildChatVisualizationProtocolText();
}

/** Keep ordinary briefing context first; include the full display spec only when both fit. */
export function buildChatVisualizationBriefing(briefing: string, maxChars: number): string {
  const protocol = protocols.buildChatVisualizationProtocolText();
  const suffix =
    briefing.length + protocol.length + 2 <= maxChars
      ? protocol
      : protocols.buildChatVisualizationRefreshInstruction();
  const budget = Math.max(0, maxChars - suffix.length - 2);
  return `${briefing.slice(0, budget).trimEnd()}\n\n${suffix}`;
}
