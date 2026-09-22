import { describe, expect, it } from 'vitest';

import {
  canonicalizeAgentTeamsToolName,
  isAgentTeamsToolUse,
  lineHasAgentTeamsTaskBoundaryToolName,
} from '../../../../src/main/services/team/agentTeamsToolNames';

describe('agentTeamsToolNames', () => {
  it.each([
    'message_send',
    'agent-teams_message_send',
    'agent_teams_message_send',
    'mcp__agent-teams__message_send',
    'mcp__agent_teams__message_send',
    'proxy_agent-teams_message_send',
  ])('canonicalizes %s to message_send', (toolName) => {
    expect(canonicalizeAgentTeamsToolName(toolName)).toBe('message_send');
  });

  it.each([
    '"name":"agent-teams_task_start"',
    '"name":"agent_teams_task_start"',
    '"name":"mcp__agent-teams__task_start"',
    '"name":"proxy_agent-teams_task_complete"',
  ])('detects task boundary aliases in raw log line %s', (line) => {
    expect(lineHasAgentTeamsTaskBoundaryToolName(line)).toBe(true);
  });

  it('does not classify unrelated plain message_send calls without Agent Teams payload shape', () => {
    expect(
      isAgentTeamsToolUse({
        rawName: 'message_send',
        canonicalName: 'message_send',
        toolInput: { channel: 'general', body: 'hello' },
        currentTeamName: 'atlas-hq',
      })
    ).toBe(false);
  });

  it('does not classify proxy-prefixed plain message_send without Agent Teams payload shape', () => {
    expect(
      isAgentTeamsToolUse({
        rawName: 'proxy_message_send',
        canonicalName: 'message_send',
        toolInput: { channel: 'general', body: 'hello' },
        currentTeamName: 'atlas-hq',
      })
    ).toBe(false);
  });

  it('classifies proxy-prefixed plain message_send only when payload matches Agent Teams shape', () => {
    expect(
      isAgentTeamsToolUse({
        rawName: 'proxy_message_send',
        canonicalName: 'message_send',
        toolInput: { teamName: 'atlas-hq', to: 'user', text: 'hello' },
        currentTeamName: 'atlas-hq',
      })
    ).toBe(true);
  });
});
