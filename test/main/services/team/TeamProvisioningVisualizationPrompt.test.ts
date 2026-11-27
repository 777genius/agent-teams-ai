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

  it('marks omitted operating rules and task tails and requires their post-readiness retrieval', () => {
    const text = buildChatVisualizationBriefing(
      'Workflow: '.repeat(4000) + '\nTask briefing: REQUIRED_TASK_TAIL',
      6000
    );

    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).not.toContain('REQUIRED_TASK_TAIL');
    expect(text).toContain('[truncated startup briefing]');
    expect(text).toContain('before acting on real work, call member_briefing once');
    expect(text).toContain('task_briefing as the current working queue');
    expect(text).toContain('do not start work or send messages');
    expect(text).toContain('Do not use these reads to prove launch readiness');
    expect(text.endsWith(protocols.buildChatVisualizationRefreshInstruction())).toBe(true);
  });

  it('preserves retrieval requirements when a compact field was already truncated', () => {
    const text = buildChatVisualizationBriefing(
      'Role: partial role\n[truncated native bootstrap context]\nStartup rules: wait.',
      18000
    );

    expect(text).toContain('[truncated startup briefing]');
    expect(text).toContain('complete current role, workflow and operating rules');
    expect(text).toContain('Startup rules: wait.');
  });

  it('does not mark the briefing incomplete when the complete refresh form fits exactly', () => {
    const briefing = 'Complete task context';
    const refresh = protocols.buildChatVisualizationRefreshInstruction();
    const text = buildChatVisualizationBriefing(briefing, briefing.length + refresh.length + 2);

    expect(text).toBe(`${briefing}\n\n${refresh}`);
    expect(text).not.toContain('[truncated startup briefing]');
  });

  it('never cuts a UTF-16 surrogate pair at the available briefing boundary', () => {
    for (const budget of [6000, 6001, 6002]) {
      const text = buildChatVisualizationBriefing('Workflow: ' + '🧩'.repeat(10000), budget);
      expect(text.length).toBeLessThanOrEqual(budget);
      expect(text.isWellFormed()).toBe(true);
      expect(text).toContain('[truncated startup briefing]');
    }
  });

  it('rejects a budget that cannot retain complete recovery instructions', () => {
    expect(() => buildChatVisualizationBriefing('Required context', 16)).toThrow(/budget/i);
  });
});
