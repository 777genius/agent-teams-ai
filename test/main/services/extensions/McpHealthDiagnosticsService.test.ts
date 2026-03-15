import { describe, expect, it } from 'vitest';

import { parseMcpDiagnosticsOutput } from '@main/services/extensions/state/McpHealthDiagnosticsService';

describe('parseMcpDiagnosticsOutput', () => {
  it('parses mixed MCP health lines from claude mcp list', () => {
    const diagnostics = parseMcpDiagnosticsOutput(`Checking MCP server health...

plugin:context7:context7: npx -y @upstash/context7-mcp - ✓ Connected
plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ✓ Connected
browsermcp: npx @browsermcp/mcp@latest - ✓ Connected
tavily-remote-mcp: npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=test - ✗ Failed to connect
alpic: https://mcp.alpic.ai (HTTP) - ! Needs authentication`);

    expect(diagnostics).toHaveLength(5);
    expect(diagnostics[0]).toMatchObject({
      name: 'plugin:context7:context7',
      target: 'npx -y @upstash/context7-mcp',
      status: 'connected',
      statusLabel: 'Connected',
    });
    expect(diagnostics[3]).toMatchObject({
      name: 'tavily-remote-mcp',
      target: 'npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=test',
      status: 'failed',
      statusLabel: 'Failed to connect',
    });
    expect(diagnostics[4]).toMatchObject({
      name: 'alpic',
      target: 'https://mcp.alpic.ai (HTTP)',
      status: 'needs-authentication',
      statusLabel: 'Needs authentication',
    });
  });

  it('ignores lines that do not look like MCP status rows', () => {
    const diagnostics = parseMcpDiagnosticsOutput(`Checking MCP server health...
random log line
another log line`);

    expect(diagnostics).toEqual([]);
  });
});
