function normalizeRuntimeProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'opencode' ? 'opencode' : 'native';
}

function createMemberMessagingProtocol(runtimeProvider) {
  const provider = normalizeRuntimeProvider(runtimeProvider);

  if (provider === 'opencode') {
    return {
      runtimeProvider: 'opencode',
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

module.exports = {
  createMemberMessagingProtocol,
  isOpenCodeMember,
  normalizeRuntimeProvider,
};
