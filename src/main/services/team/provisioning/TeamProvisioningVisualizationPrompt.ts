import { protocols } from 'agent-teams-controller';

export function buildLeadChatVisualizationProtocol(): string {
  return protocols.buildChatVisualizationProtocolText();
}

/** Reserve the protocol as one unit; never truncate a component signature. */
export function buildNativeChatVisualizationBriefing(briefing: string, maxChars: number): string {
  const protocol = protocols.buildChatVisualizationProtocolText();
  const suffix =
    protocol.length + 2 <= maxChars
      ? protocol
      : protocols.buildChatVisualizationRefreshInstruction();
  const budget = Math.max(0, maxChars - suffix.length - 2);
  return `${briefing.slice(0, budget).trimEnd()}\n\n${suffix}`;
}
