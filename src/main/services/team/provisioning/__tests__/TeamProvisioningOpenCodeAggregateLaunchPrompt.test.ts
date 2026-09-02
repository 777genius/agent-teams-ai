import { describe, expect, it, vi } from 'vitest';

import {
  FALLBACK_OPEN_CODE_LAUNCH_PROMPT_LEAD_NAME,
  queueLaunchPromptToLeadInbox,
  resolveOpenCodeAggregateLaunchPromptDelivery,
  resolveOpenCodeAggregateLaunchPromptLeadName,
} from '../TeamProvisioningOpenCodeAggregateLaunchPrompt';

describe('TeamProvisioningOpenCodeAggregateLaunchPrompt', () => {
  it('routes a real prompt to the lead inbox and hands the orchestrator nothing', () => {
    expect(resolveOpenCodeAggregateLaunchPromptDelivery('  ship it  ')).toEqual({
      orchestratorPrompt: '',
      leadInboxPrompt: 'ship it',
    });
  });

  it.each(['', '   ', '\n\t'])('leaves a blank prompt %j with the orchestrator', (prompt) => {
    expect(resolveOpenCodeAggregateLaunchPromptDelivery(prompt)).toEqual({
      orchestratorPrompt: prompt,
      leadInboxPrompt: null,
    });
  });

  it('prefers the lead member, by agent type or by the runtime-owned name', () => {
    expect(
      resolveOpenCodeAggregateLaunchPromptLeadName([
        { name: 'alice', role: 'Engineer' },
        { name: ' captain ', agentType: 'orchestrator' },
      ])
    ).toBe('captain');
    expect(
      resolveOpenCodeAggregateLaunchPromptLeadName([{ name: 'team-lead', role: 'Engineer' }])
    ).toBe('team-lead');
  });

  it('falls back to the runtime-owned lead name when no member reads as the lead', () => {
    expect(
      resolveOpenCodeAggregateLaunchPromptLeadName([{ name: 'alice', role: 'Engineer' }])
    ).toBe(FALLBACK_OPEN_CODE_LAUNCH_PROMPT_LEAD_NAME);
    expect(resolveOpenCodeAggregateLaunchPromptLeadName([])).toBe(
      FALLBACK_OPEN_CODE_LAUNCH_PROMPT_LEAD_NAME
    );
  });

  it('queues the prompt as a lead inbox message', async () => {
    const diagnostics: string[] = [];
    const deliverOpenCodeLaunchPromptToLead = vi.fn(async () => undefined);

    await expect(
      queueLaunchPromptToLeadInbox(
        { teamName: 'team-a', leadName: 'captain', prompt: 'ship it', diagnostics },
        { deliverOpenCodeLaunchPromptToLead }
      )
    ).resolves.toBe(true);

    expect(deliverOpenCodeLaunchPromptToLead).toHaveBeenCalledWith({
      teamName: 'team-a',
      leadName: 'captain',
      prompt: 'ship it',
    });
    expect(diagnostics).toEqual([]);
  });

  it('reports a lead inbox that cannot take the message instead of throwing', async () => {
    const diagnostics: string[] = [];

    await expect(
      queueLaunchPromptToLeadInbox(
        { teamName: 'team-a', leadName: 'captain', prompt: 'ship it', diagnostics },
        {
          deliverOpenCodeLaunchPromptToLead: async () => {
            throw new Error('lead inbox is not writable');
          },
        }
      )
    ).resolves.toBe(false);

    expect(diagnostics).toEqual([
      'Launch prompt could not be queued for captain: lead inbox is not writable',
    ]);
  });
});
