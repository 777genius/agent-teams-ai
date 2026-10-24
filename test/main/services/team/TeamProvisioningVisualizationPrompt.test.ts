import { buildPersistentLeadContext } from '@main/services/team/provisioning/TeamProvisioningPromptBuilders';
import { buildChatVisualizationBriefing } from '@main/services/team/provisioning/TeamProvisioningVisualizationPrompt';
import { protocols } from 'agent-teams-controller';
import { describe, expect, it } from 'vitest';

describe('chat visualization startup contract', () => {
  const protocol = protocols.buildChatVisualizationProtocolText();
  it('ships the same complete generated protocol to the initial lead', () => {
    const prompt = buildPersistentLeadContext({
      teamName: 'sandbox',
      leadName: 'lead',
      isSolo: true,
      members: [],
    });
    expect(prompt).toContain(protocol);
    expect(prompt.match(/CHAT VISUALIZATION PROTOCOL v1/g)).toHaveLength(1);
  });
  it('reserves the whole contract while bounding ordinary briefing data', () => {
    const text = buildChatVisualizationBriefing('Task context '.repeat(4000), 18000);
    expect(text.length).toBeLessThanOrEqual(18000);
    expect(text.endsWith(protocol)).toBe(true);
    expect(text).not.toContain('CHAT VISUALIZATION REFRESH REQUIRED');
  });
  it('uses a complete post-readiness refresh rule when the compact budget cannot fit the schema', () => {
    const text = buildChatVisualizationBriefing('Task context '.repeat(4000), 6000);
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain('After launch readiness is confirmed');
    expect(text).toContain('call member_briefing once');
    expect(text).not.toContain('AVAILABLE DISPLAY LIBRARY SPEC');
    expect(text).not.toContain('"signature"');
  });
});
