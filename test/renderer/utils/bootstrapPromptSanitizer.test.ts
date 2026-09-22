import {
  getBootstrapPromptDisplay,
  getInternalControlMessageDisplay,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';
import { describe, expect, it } from 'vitest';

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

  it('sanitizes native app-managed bootstrap private control prompts defensively', () => {
    const message = makeMessage(
      `<agent_teams_native_app_managed_bootstrap_check>
Your Agent Teams startup context was already loaded by the app.
</agent_teams_native_app_managed_bootstrap_check>`,
      { source: undefined }
    );

    expect(getInternalControlMessageDisplay(message)?.summary).toBe('Internal bootstrap check');
    expect(getSanitizedInboxMessageText(message)).toBe('Internal bootstrap check hidden in the UI.');
  });

  it('sanitizes native bootstrap-control private prompts defensively', () => {
    const message = makeMessage(
      `<agent_teams_native_bootstrap_control>
System-level bootstrap rules:
- This is a private startup context handoff.
</agent_teams_native_bootstrap_control>`,
      { source: undefined }
    );

    expect(getInternalControlMessageDisplay(message)?.summary).toBe('Internal bootstrap check');
    expect(getSanitizedInboxMessageText(message)).toBe('Internal bootstrap check hidden in the UI.');
  });

  it('does not sanitize user-authored native bootstrap marker quotes', () => {
    const text = `<agent_teams_native_app_managed_bootstrap_check>
Your Agent Teams startup context was already loaded by the app.
</agent_teams_native_app_managed_bootstrap_check>`;
    const message = makeMessage(text, { from: 'user', source: 'user_sent' });
    const controlText = `<agent_teams_native_bootstrap_control>
System-level bootstrap rules:
- This is a private startup context handoff.
</agent_teams_native_bootstrap_control>`;
    const controlMessage = makeMessage(controlText, { from: 'user', source: 'user_sent' });

    expect(getInternalControlMessageDisplay(message)).toBeNull();
    expect(getSanitizedInboxMessageText(message)).toBe(text);
    expect(getInternalControlMessageDisplay(controlMessage)).toBeNull();
    expect(getSanitizedInboxMessageText(controlMessage)).toBe(controlText);
  });

  it('does not sanitize visible lead text that only mentions the native bootstrap marker', () => {
    const appManagedText =
      'Visible note quoting <agent_teams_native_app_managed_bootstrap_check> for diagnostics.';
    const bootstrapControlText =
      'Visible note quoting <agent_teams_native_bootstrap_control> for diagnostics.';
    const message = makeMessage(appManagedText, { from: 'team-lead', source: 'lead_process' });
    const controlMessage = makeMessage(bootstrapControlText, {
      from: 'team-lead',
      source: 'lead_process',
    });

    expect(getInternalControlMessageDisplay(message)).toBeNull();
    expect(getSanitizedInboxMessageText(message)).toBe(appManagedText);
    expect(getInternalControlMessageDisplay(controlMessage)).toBeNull();
    expect(getSanitizedInboxMessageText(controlMessage)).toBe(bootstrapControlText);
  });

  it('sanitizes leaked lead inbox relay prompts defensively', () => {
    const message = makeMessage(
      `Human: You have new inbox messages addressed to you (team lead "team-lead").
Process them in order (oldest first).
If action is required, delegate via task creation or SendMessage, and keep responses minimal.

Messages:
1) From: tom
   Timestamp: 2026-05-06T15:02:54.853Z
   Text:
   #f8d7235a done.`,
      { source: 'lead_process' }
    );

    expect(getInternalControlMessageDisplay(message)?.summary).toBe('Internal control message');
    expect(getSanitizedInboxMessageText(message)).toBe('Internal control message hidden in the UI.');
  });

  it('does not sanitize user-authored text that quotes an internal prompt', () => {
    const text = `Human: You have new inbox messages addressed to you (team lead "team-lead").
Process them in order (oldest first).

Messages:
1) From: tom
   Timestamp: 2026-05-06T15:02:54.853Z
   Text:
   #f8d7235a done.`;
    const message = makeMessage(text, { source: 'user_sent' });

    expect(getInternalControlMessageDisplay(message)).toBeNull();
    expect(getSanitizedInboxMessageText(message)).toBe(text);
  });
});
