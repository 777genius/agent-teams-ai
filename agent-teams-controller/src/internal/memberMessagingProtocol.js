function normalizeRuntimeProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'opencode') return 'opencode';
  if (normalized === 'codex') return 'codex';
  return 'native';
}

function createMemberMessagingProtocol(runtimeProvider) {
  const provider = normalizeRuntimeProvider(runtimeProvider);

  if (provider === 'opencode' || provider === 'codex') {
    const runtimeLabel = provider === 'opencode' ? 'OpenCode' : 'Codex Native';
    return {
      runtimeProvider: provider,
      sendToolName: 'agent-teams_message_send',
      sendToolAliases: [
        'agent-teams_message_send',
        'agent_teams_message_send',
        'mcp__agent-teams__message_send',
        'mcp__agent_teams__message_send',
        'message_send',
      ],
      sendLeadPhrase: 'MCP tool agent-teams_message_send',
      crossTeamPhrase: 'call MCP tool agent-teams_cross_team_send',
      buildLeadMessageExample({ teamName, leadName, fromName, text, summary }) {
        return `agent-teams_message_send { teamName: "${teamName}", to: "${leadName}", from: "${fromName}", text: "${text}", summary: "${summary}" }`;
      },
      buildCrossTeamMessageExample({ teamName, toTeam, fromName, text, summary }) {
        return `agent-teams_cross_team_send { teamName: "${teamName}", toTeam: "${toTeam}", fromMember: "${fromName}", text: "${text}", summary: "${summary}" }`;
      },
      visibleMessageRule:
        `${runtimeLabel} visible messaging rule: call agent-teams_message_send for normal replies to the human user, lead, or same-team teammates. Always include teamName, to, from, text, and summary. Do not use SendMessage or runtime_deliver_message for ordinary replies.`,
      taskToolHint:
        `${runtimeLabel} task tool rule: call Agent Teams task tools directly; if prefixed MCP names are exposed, use mcp__agent-teams__task_get, mcp__agent-teams__task_start, mcp__agent-teams__task_add_comment, and mcp__agent-teams__task_complete.`,
    };
  }

  return {
    runtimeProvider: 'native',
    sendToolName: 'SendMessage',
    sendToolAliases: ['SendMessage'],
    sendLeadPhrase: 'SendMessage',
    crossTeamPhrase: 'use the cross-team MCP tool cross_team_send',
    buildLeadMessageExample({ leadName, text, summary }) {
      return `SendMessage { to: "${leadName}", summary: "${summary}", message: "${text}" }`;
    },
    buildCrossTeamMessageExample({ teamName, toTeam, fromName, text, summary }) {
      return `cross_team_send { teamName: "${teamName}", toTeam: "${toTeam}", fromMember: "${fromName}", text: "${text}", summary: "${summary}" }`;
    },
    visibleMessageRule: '',
    taskToolHint: '',
  };
}

function isOpenCodeMember(member) {
  const provider = String((member && (member.providerId || member.provider)) || '')
    .trim()
    .toLowerCase();
  if (provider) return provider === 'opencode';
  const model = String((member && member.model) || '').trim().toLowerCase();
  return model.startsWith('opencode/');
}

function isCodexMember(member) {
  const provider = String((member && (member.providerId || member.provider)) || '')
    .trim()
    .toLowerCase();
  if (provider) return provider === 'codex';
  const model = String((member && member.model) || '').trim().toLowerCase();
  return model.startsWith('gpt-') || model.startsWith('openai/gpt-');
}

module.exports = {
  createMemberMessagingProtocol,
  isCodexMember,
  isOpenCodeMember,
  normalizeRuntimeProvider,
};
