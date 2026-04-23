import { describe, expect, it } from 'vitest';

import {
  getBootstrapPromptDisplay,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';

import type { InboxMessage } from '@shared/types';

function makeMessage(text: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'team-lead',
    to: 'alice',
    text,
    timestamp: '2026-04-07T10:00:00.000Z',
    read: false,
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('bootstrapPromptSanitizer', () => {
  it('sanitizes legacy verbose bootstrap prompts', () => {
    const message = makeMessage(`You are alice, a reviewer on team "forge-labs" (forge-labs).
Your FIRST action: call MCP tool member_briefing with:
{ teamName: "forge-labs", memberName: "alice" }
member_briefing is expected to be available in your initial MCP tool list.
Do NOT start work, claim tasks, or improvise workflow/task/process rules before member_briefing succeeds.
If member_briefing fails, send one short natural-language message to your team lead "team-lead".
IMPORTANT: When sending messages to the team lead, always use the exact name "team-lead".`);

    const display = getBootstrapPromptDisplay(message);
    expect(display?.summary).toBe('Starting alice');
    expect(getSanitizedInboxMessageText(message)).toContain('Lead is starting `alice` as a teammate.');
  });

  it('sanitizes new runtime-generated bootstrap prompts', () => {
    const message = makeMessage(`You are alice, a reviewer on team "forge-labs" (forge-labs).
IMPORTANT: Communicate in English. All messages, summaries, and task descriptions MUST be in English.
The team has already been created and you are being attached as a persistent teammate.
Your FIRST action: call MCP tool member_briefing with:
{ teamName: "forge-labs", memberName: "alice" }
Call member_briefing directly yourself. Do NOT use Agent, any subagent, or a delegated helper for this bootstrap step.
If member_briefing fails, send one short natural-language message to "team-lead" with the exact error text.
After member_briefing succeeds, wait for instructions from the lead and use team mailbox/task tools normally.
Do NOT send acknowledgement-only messages such as "ready" or "online".`);

    const display = getBootstrapPromptDisplay(message);
    expect(display?.summary).toBe('Starting alice');
    expect(getSanitizedInboxMessageText(message)).toContain('Startup instructions are hidden in the UI.');
  });

  it('keeps dotted model ids intact and does not show implicit default effort', () => {
    const message = makeMessage(`You are alice, a reviewer on team "forge-labs" (forge-labs). Provider override: codex. Model override: gpt-5.4-mini.
The team has already been created and you are being attached as a persistent teammate.
Your FIRST action: call MCP tool member_briefing with:
{ teamName: "forge-labs", memberName: "alice" }
Call member_briefing directly yourself. Do NOT use Agent, any subagent, or a delegated helper for this bootstrap step.
If member_briefing fails, send one short natural-language message to "team-lead" with the exact error text.
After member_briefing succeeds, wait for instructions from the lead and use team mailbox/task tools normally.
Do NOT send acknowledgement-only messages such as "ready" or "online".`);

    const display = getBootstrapPromptDisplay(message);

    expect(display?.runtime).toBe('GPT-5.4 Mini');
  });
});
