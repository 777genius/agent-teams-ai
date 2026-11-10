import { buildMessageDeliveryText } from '@main/services/team/messageDeliveryText';
import { buildCreateBootstrapUserPrompt } from '@main/services/team/provisioning/TeamProvisioningRosterPrompt';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { protocols } from 'agent-teams-controller';
import { describe, expect, it } from 'vitest';

describe('OpenUI discovery through actual create and message delivery paths', () => {
  const request = 'Покажи эти данные диаграммой OpenUI прямо здесь: A — 10, B — 20.';

  it.each([{ members: [] }, { members: [{ name: 'reviewer', role: 'reviewer' }] }])(
    'delivers the full display contract with a fresh native create request ($members)',
    ({ members }) => {
      const prompt = buildCreateBootstrapUserPrompt('alpha', request, members);
      expect(prompt).toContain(protocols.buildChatVisualizationProtocolText());
      expect(prompt.match(/CHAT VISUALIZATION PROTOCOL v1/g)).toHaveLength(1);
      expect(prompt).toContain('Stack(children: Card[])');
      expect(prompt.endsWith(`User instructions:\n${request}`)).toBe(true);
      expect(stripAgentBlocks(prompt)).not.toContain('AVAILABLE DISPLAY LIBRARY SPEC');
    }
  );

  it('keeps empty creation silent and supplies discovery with the first real lead message', () => {
    expect(buildCreateBootstrapUserPrompt('alpha', '   ', [])).toBe('');
    const prompt = buildMessageDeliveryText(request, {
      isLeadRecipient: true,
      actionMode: 'ask',
    });
    expect(prompt).toContain(protocols.buildChatVisualizationRefreshInstruction());
    expect(prompt).toContain('if the complete display library specification is missing');
    expect(prompt).toContain('Reuse the specification when it is already present');
    expect(prompt).toContain('call lead_briefing once if you are the team lead');
    expect(prompt).toContain('TURN ACTION MODE: ASK');
    expect(stripAgentBlocks(prompt).trim()).toBe(request);
  });

  it.each(['send_message', 'agent_teams_message_send'] as const)(
    'keeps the native teammate reply route while advertising OpenUI (%s)',
    (protocol) => {
      const prompt = buildMessageDeliveryText(request, {
        isLeadRecipient: false,
        memberName: 'reviewer',
        teamName: 'sandbox',
        messageId: 'human-message',
        replyRecipient: 'user',
        protocol,
      });
      expect(prompt).toContain(protocols.buildChatVisualizationRefreshInstruction());
      expect(prompt).toContain(
        protocol === 'send_message'
          ? 'destination must be exactly to="user"'
          : 'Reply using the Agent Teams MCP message_send tool'
      );
      expect(stripAgentBlocks(prompt).trim()).toBe(request);
    }
  );

  it('does not add a human capability reminder to a peer delivery', () => {
    const prompt = buildMessageDeliveryText('Please review task 7.', {
      isLeadRecipient: false,
      replyRecipient: 'reviewer',
    });
    expect(prompt).not.toContain('CHAT VISUALIZATION');
    expect(prompt).toContain('destination must be exactly to="reviewer"');
  });
});
