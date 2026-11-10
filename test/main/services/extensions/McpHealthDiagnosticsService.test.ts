import { describe, expect, it, vi } from 'vitest';

import {
  McpHealthDiagnosticsService,
  parseMcpDiagnosticsJsonOutput,
  parseMcpDiagnosticsOutput,
} from '@main/services/extensions/state/McpHealthDiagnosticsService';

describe('parseMcpDiagnosticsOutput', () => {
  it('parses mixed MCP health lines from claude mcp list', () => {
    const diagnostics = parseMcpDiagnosticsOutput(`Checking MCP server health...

plugin:context7:context7: npx -y @upstash/context7-mcp - ✓ Connected
plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ✓ Connected
browsermcp: npx @browsermcp/mcp@latest - ✓ Connected
tavily-remote-mcp: npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=test - ✗ Failed to connect
alpic: https://mcp.alpic.ai (HTTP) - ! Needs authentication`);

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]).toMatchObject({
      name: 'browsermcp',
      target: 'npx @browsermcp/mcp@latest',
      status: 'connected',
      statusLabel: 'Connected',
    });
    expect(diagnostics[1]).toMatchObject({
      name: 'tavily-remote-mcp',
      target: 'npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=REDACTED',
      status: 'failed',
      statusLabel: 'Failed to connect',
    });
    expect(diagnostics[2]).toMatchObject({
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

  it('parses structured multimodel MCP diagnostics JSON', () => {
    const diagnostics = parseMcpDiagnosticsJsonOutput(
      JSON.stringify({
        checkedAt: '2026-04-17T10:00:00.000Z',
        diagnostics: [
          {
            name: 'context7',
            target: 'npx -y @upstash/context7-mcp',
            status: 'connected',
            statusLabel: 'Connected',
          },
          {
            name: 'tavily',
            target: 'https://mcp.tavily.com/mcp?token=secret',
            scope: 'global',
            transport: 'http',
            status: 'timeout',
            statusLabel: 'Timed out',
          },
          {
            name: 'plugin:context7:context7',
            target: 'npx -y @upstash/context7-mcp',
            scope: 'dynamic',
            transport: 'stdio',
            status: 'connected',
            statusLabel: 'Connected',
          },
        ],
      })
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        name: 'context7',
        status: 'connected',
        statusLabel: 'Connected',
      }),
      expect.objectContaining({
        name: 'tavily',
        target: 'https://mcp.tavily.com/mcp?token=REDACTED',
        scope: 'global',
        transport: 'http',
        status: 'failed',
        statusLabel: 'Timed out',
      }),
    ]);
  });
});

describe('McpHealthDiagnosticsService', () => {
  it('delegates diagnostics to the active runtime adapter', async () => {
    const diagnoseMcp = vi.fn().mockResolvedValue([
      {
        name: 'context7',
        target: 'npx -y @upstash/context7-mcp',
        status: 'connected',
        statusLabel: 'Connected',
        rawLine: 'context7: npx -y @upstash/context7-mcp - Connected',
        checkedAt: 1,
      },
    ]);
    const service = new McpHealthDiagnosticsService({
      flavor: 'agent_teams_orchestrator',
      buildManagementCliEnv: vi.fn(),
      getInstalledMcp: vi.fn(),
      diagnoseMcp,
    });

    await expect(service.diagnose('/tmp/project-a')).resolves.toEqual([
      expect.objectContaining({ name: 'context7' }),
    ]);
    expect(diagnoseMcp).toHaveBeenCalledWith('/tmp/project-a');
  });
});
