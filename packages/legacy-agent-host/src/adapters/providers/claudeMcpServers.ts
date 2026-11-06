import { capturedMcpServersSchema } from '../../mcp-catalog/capturedServer.js';
import type { ClaudeConfig } from '@agent-teams/provider-implementations/claude';
import type { TeamMcpEndpoint } from '../../mcp/contracts.js';
import type { ClaudeMemberProfile } from '../../composition/runtimeProfile.js';

/** The captured Team endpoint is always composed after, and independently of, user MCP config. */
export function claudeMcpServers(
  profile: ClaudeMemberProfile,
  endpoint: Pick<TeamMcpEndpoint, 'url' | 'bearerToken'>
): ClaudeConfig['mcpServers'] {
  return {
    ...capturedMcpServersSchema.parse(profile.capturedMcpServers ?? {}),
    team: {
      type: 'http',
      url: endpoint.url,
      headers: { Authorization: `Bearer ${endpoint.bearerToken}` },
    },
  };
}
