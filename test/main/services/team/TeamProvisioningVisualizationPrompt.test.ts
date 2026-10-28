import { buildPersistentLeadContext } from '@main/services/team/provisioning/TeamProvisioningPromptBuilders';
import { buildChatVisualizationBriefing } from '@main/services/team/provisioning/TeamProvisioningVisualizationPrompt';
import { protocols } from 'agent-teams-controller';
import { describe, expect, it } from 'vitest';

describe('chat visualization startup contract', () => {
  const protocol = protocols.buildChatVisualizationProtocolText();
  it('ships the same complete generated protocol to persistent lead context', () => {
    const prompt = buildPersistentLeadContext({
      teamName: 'sandbox',
      leadName: 'lead',
      isSolo: true,
      members: [],
    });
    expect(prompt).toContain(protocol);
    expect(prompt.match(/CHAT VISUALIZATION PROTOCOL v1/g)).toHaveLength(1);
    expect(prompt).toContain('built-in OpenUI rendering');
    expect(prompt).toContain('No separate OpenUI tool, connector, or service is required');
  });
  it('keeps the whole briefing and full protocol when both fit', () => {
    const briefing = 'Task context '.repeat(200);
    const text = buildChatVisualizationBriefing(briefing, 18000);
    expect(text.length).toBeLessThanOrEqual(18000);
    expect(text.startsWith(briefing.trimEnd())).toBe(true);
    expect(text.endsWith(protocol)).toBe(true);
    expect(text).not.toContain('CHAT VISUALIZATION REFRESH REQUIRED');
  });
  it('retains ordinary context beyond the full-spec allowance by using the atomic refresh instead', () => {
    const maxChars = 18000;
    const briefing =
      'x'.repeat(maxChars - protocol.length - 2) +
      'ORDINARY_WORKFLOW_CONTEXT' +
      'Task context '.repeat(4000);
    const text = buildChatVisualizationBriefing(briefing, maxChars);
    expect(text.length).toBeLessThanOrEqual(maxChars);
    expect(text).toContain('ORDINARY_WORKFLOW_CONTEXT');
    expect(text.endsWith(protocols.buildChatVisualizationRefreshInstruction())).toBe(true);
    expect(text).not.toContain('AVAILABLE DISPLAY LIBRARY SPEC');
  });
  it('uses a complete post-readiness refresh rule when the compact budget cannot fit the schema', () => {
    const text = buildChatVisualizationBriefing('Task context '.repeat(4000), 6000);
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain('built-in OpenUI without a separate tool or connector');
    expect(text).toContain('existing reply delivery and visibility rules');
    expect(text).toContain('After launch readiness is confirmed');
    expect(text).toContain('before fulfilling a request for OpenUI here');
    expect(text).toContain('call member_briefing once');
    expect(text).not.toContain('AVAILABLE DISPLAY LIBRARY SPEC');
    expect(text).not.toContain('"signature"');
  });
  it('keeps the expanded protocol atomic at the available budget boundary', () => {
    const briefing = 'Task context';
    const fullBudget = briefing.length + protocol.length + 2;
    const full = buildChatVisualizationBriefing(briefing, fullBudget);
    expect(full.length).toBeLessThanOrEqual(fullBudget);
    expect(full.endsWith(protocol)).toBe(true);

    const compactBudget = fullBudget - 1;
    const compact = buildChatVisualizationBriefing(briefing, compactBudget);
    expect(compact.length).toBeLessThanOrEqual(compactBudget);
    expect(compact.startsWith(briefing)).toBe(true);
    expect(compact.endsWith(protocols.buildChatVisualizationRefreshInstruction())).toBe(true);
    expect(compact).not.toContain('AVAILABLE DISPLAY LIBRARY SPEC');
  });
});
