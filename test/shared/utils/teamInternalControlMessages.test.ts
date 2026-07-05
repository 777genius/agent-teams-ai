import {
  isLeadInboxRelayControlPromptText,
  isNativeBootstrapControlText,
  isTeamInternalControlMessageEnvelope,
  isTeamInternalControlMessageText,
  isTeammateProtocolControlText,
  stripExactInternalControlEchoPrefix,
} from '@shared/utils/teamInternalControlMessages';
import { describe, expect, it } from 'vitest';

const leadRelayPrompt = `You have new inbox messages addressed to you (team lead "team-lead").
Process them in order (oldest first).
If action is required, delegate via task creation or SendMessage, and keep responses minimal.
IMPORTANT: Your text response here is shown to the user.

Messages:
1) From: tom
   Timestamp: 2026-05-06T15:02:54.853Z
   Text:
   #f8d7235a done.`;
const nativeBootstrapPrompt = `<agent_teams_native_app_managed_bootstrap_check>
Your Agent Teams startup context was already loaded by the app.
</agent_teams_native_app_managed_bootstrap_check>`;
const nativeBootstrapControlPrompt = `<agent_teams_native_bootstrap_control>
System-level bootstrap rules:
- This is a private startup context handoff.
</agent_teams_native_bootstrap_control>`;

describe('teamInternalControlMessages', () => {
  it('detects lead inbox relay prompts and Human-prefixed echoes', () => {
    expect(isLeadInboxRelayControlPromptText(leadRelayPrompt)).toBe(true);
    expect(isLeadInboxRelayControlPromptText(`Human: ${leadRelayPrompt}`)).toBe(true);
    expect(isTeamInternalControlMessageText(`Human: ${leadRelayPrompt}`)).toBe(true);
  });

  it('does not hide ordinary visible lead replies', () => {
    expect(
      isLeadInboxRelayControlPromptText(
        'I delegated #f8d7235a to tom and asked alice to review when blockers clear.'
      )
    ).toBe(false);
  });

  it('detects Human-prefixed teammate protocol blocks', () => {
    const text =
      'Human: <teammate-message teammate_id="alice">\n{"type":"idle_notification"}\n</teammate-message>';

    expect(isTeammateProtocolControlText(text)).toBe(true);
    expect(isTeamInternalControlMessageText(text)).toBe(true);
  });

  it('only treats internal-looking text as hidden for internal message sources', () => {
    expect(
      isTeamInternalControlMessageEnvelope({
        source: 'lead_process',
        text: `Human: ${leadRelayPrompt}`,
      })
    ).toBe(true);
    expect(
      isTeamInternalControlMessageEnvelope({
        source: 'user_sent',
        text: `Human: ${leadRelayPrompt}`,
      })
    ).toBe(false);
    expect(
      isTeamInternalControlMessageEnvelope({
        text: `Human: ${leadRelayPrompt}`,
      })
    ).toBe(false);
    expect(
      isTeamInternalControlMessageEnvelope({
        text: nativeBootstrapPrompt,
        from: 'team-lead',
      })
    ).toBe(true);
    expect(
      isTeamInternalControlMessageEnvelope({
        text: nativeBootstrapPrompt,
        from: 'orchestrator',
      })
    ).toBe(true);
    expect(isTeamInternalControlMessageText(`Human: ${nativeBootstrapPrompt}`)).toBe(true);
    expect(isNativeBootstrapControlText(`Human: ${nativeBootstrapControlPrompt}`)).toBe(true);
    expect(isTeamInternalControlMessageText(`Human: ${nativeBootstrapControlPrompt}`)).toBe(true);
    expect(
      isTeamInternalControlMessageEnvelope({
        text: nativeBootstrapControlPrompt,
        from: 'orchestrator',
      })
    ).toBe(true);
    for (const source of ['lead_process', 'lead_session', 'runtime_delivery', 'system_notification']) {
      expect(
        isTeamInternalControlMessageEnvelope({
          source,
          text: `User: ${nativeBootstrapControlPrompt}`,
          from: 'alice',
        })
      ).toBe(true);
    }
    expect(
      isTeamInternalControlMessageEnvelope({
        text: nativeBootstrapControlPrompt,
        from: 'alice',
      })
    ).toBe(false);
    expect(
      isTeamInternalControlMessageEnvelope({
        source: 'lead_process',
        text: `Visible note quoting ${nativeBootstrapPrompt}`,
      })
    ).toBe(false);
    expect(
      isTeamInternalControlMessageEnvelope({
        source: 'lead_process',
        text: `Visible note quoting ${nativeBootstrapControlPrompt}`,
      })
    ).toBe(false);
    expect(
      isTeamInternalControlMessageEnvelope({
        source: 'user_sent',
        text: nativeBootstrapPrompt,
        from: 'user',
      })
    ).toBe(false);
    expect(
      isTeamInternalControlMessageEnvelope({
        text: nativeBootstrapPrompt,
        from: 'user',
      })
    ).toBe(false);
    expect(
      isTeamInternalControlMessageEnvelope({
        source: 'user_sent',
        text: nativeBootstrapControlPrompt,
        from: 'user',
      })
    ).toBe(false);
  });

  it('strips an exact echoed control prefix while preserving visible trailing text', () => {
    expect(stripExactInternalControlEchoPrefix(`Human: ${leadRelayPrompt}`, leadRelayPrompt)).toBe(
      ''
    );
    expect(
      stripExactInternalControlEchoPrefix(
        `Human: ${leadRelayPrompt}\n\nDelegated to bob.`,
        leadRelayPrompt
      )
    ).toBe('Delegated to bob.');
  });
});
