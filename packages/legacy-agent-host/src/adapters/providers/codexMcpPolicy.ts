import { captureCodexMcpPolicy } from '@agent-teams/provider-implementations/codex';
import { capturedMcpServersSchema } from '../../mcp-catalog/capturedServer.js';
import type {
  CodexMcpPolicy,
  CodexSelectedMcpServers,
} from '@agent-teams/provider-implementations/codex';
import type { CodexMemberProfile } from '../../composition/runtimeProfile.js';
import type { MemberProviderContext } from './MemberProvider.js';

/** Private conversion only; D owns config encoding/census/status protocol. */
export function codexMcpPolicy(
  profile: CodexMemberProfile,
  endpoint: MemberProviderContext['endpoint'],
  required: readonly string[]
): CodexMcpPolicy | undefined {
  if (profile.capturedMcpServers === undefined) return undefined;
  if (!profile.capturedMcpCatalog) throw new Error('Captured Codex MCP census unavailable');
  const selected: CodexSelectedMcpServers = Object.create(null);
  for (const [name, server] of Object.entries(
    capturedMcpServersSchema.parse(profile.capturedMcpServers)
  )) {
    selected[name] =
      server.type === 'stdio'
        ? {
            command: server.command,
            ...(server.args ? { args: [...server.args] } : {}),
            ...(server.env ? { env: { ...server.env } } : {}),
          }
        : { url: server.url, ...(server.headers ? { http_headers: { ...server.headers } } : {}) };
  }
  selected.team = {
    url: endpoint.url,
    bearer_token_env_var: 'LEGACY_AGENT_HOST_TEAM_MCP_TOKEN',
    enabled_tools: [...required],
    startup_timeout_sec: Math.ceil(profile.limits.timeoutMs / 1000),
    tool_timeout_sec: Math.ceil(profile.limits.timeoutMs / 1000),
    tools: Object.fromEntries(
      required.map((name) => [name, { approval_mode: 'approve' as const }])
    ),
  };
  return captureCodexMcpPolicy({ catalog: profile.capturedMcpCatalog, selected });
}
