import { capturedMcpServersSchema } from '../../mcp-catalog/capturedServer.js';
import type { CapturedMcpServers } from '../../mcp-catalog/capturedServer.js';

export const openCodeV2TeamToolActions = [
  'agent-teams_*', 'agent_teams_*', 'mcp__agent-teams__*', 'mcp__agent_teams__*',
] as const;

type NativeServer = {
  type: 'local'; command: string[]; environment?: Record<string, string>; codemode: false;
} | {
  type: 'remote'; url: string; headers?: Record<string, string>; oauth: false; codemode: false;
};

/** Exact 2.1.4 native MCP shape. Selection and source ownership remain in the launch capture. */
export function openCodeV2CapturedMcp(captured: CapturedMcpServers = {}) {
  const selected = capturedMcpServersSchema.parse(captured);
  // The pinned native inventory accepts 256 entries, including the immutable Team server.
  if (Object.keys(selected).length > 255) throw new Error('OpenCode V2 external MCP server limit exceeded');
  const namespaces: string[] = [];
  const servers: Record<string, NativeServer> = Object.create(null);
  for (const name of Object.keys(selected).sort()) {
    // Same normalization as the pinned engine's MCP tool namespace, before any process allocation.
    const namespace = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const actionPrefix = namespace + '_';
    if (namespaces.includes(namespace) || openCodeV2TeamToolActions.some(action => {
      const privilegedPrefix = action.slice(0, -1);
      // Either overlap could let an external tool name match a privileged Team rule.
      return actionPrefix.startsWith(privilegedPrefix) || privilegedPrefix.startsWith(actionPrefix);
    })) throw new Error('OpenCode V2 external MCP namespace conflicts with captured tool authority');
    namespaces.push(namespace);
    const server = selected[name]!;
    servers[name] = server.type === 'stdio'
      ? { type: 'local', command: [server.command, ...(server.args ?? [])], codemode: false,
          ...(server.env ? { environment: { ...server.env } } : {}) }
      : { type: 'remote', url: server.url, oauth: false, codemode: false,
          ...(server.headers ? { headers: { ...server.headers } } : {}) };
  }
  return { servers, namespaces, names: Object.keys(servers) };
}
