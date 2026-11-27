const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

/** The former OpenCode-specific name remains supported for existing installations. */
export function isAgentTeamsMcpHttpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AGENT_TEAMS_MCP_HTTP?.trim() || env.CLAUDE_TEAM_OPENCODE_MCP_HTTP?.trim();
  return value ? !DISABLED_VALUES.has(value.toLowerCase()) : true;
}
