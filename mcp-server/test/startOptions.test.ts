import { describe, expect, it } from 'vitest';

import { buildHttpHealthIdentity, resolveStartOptions } from '../src/index';

describe('agent-teams MCP start options', () => {
  it('defaults to stdio transport', () => {
    expect(resolveStartOptions(['node', 'index.js'], {})).toEqual({
      transportType: 'stdio',
    });
  });

  it('resolves HTTP stream transport from CLI args', () => {
    expect(
      resolveStartOptions(
        [
          'node',
          'index.js',
          '--transport',
          'httpStream',
          '--host',
          '127.0.0.1',
          '--port',
          '43123',
          '--endpoint',
          'mcp',
        ],
        {}
      )
    ).toEqual({
      transportType: 'httpStream',
      httpStream: {
        host: '127.0.0.1',
        port: 43123,
        endpoint: '/mcp',
      },
    });
  });

  it('resolves HTTP stream transport from environment', () => {
    expect(
      resolveStartOptions(['node', 'index.js'], {
        AGENT_TEAMS_MCP_TRANSPORT: 'httpStream',
        AGENT_TEAMS_MCP_HTTP_PORT: '43124',
      })
    ).toEqual({
      transportType: 'httpStream',
      httpStream: {
        host: '127.0.0.1',
        port: 43124,
        endpoint: '/mcp',
      },
    });
  });

  it('builds HTTP health identity only when app identity env is present', () => {
    const options = resolveStartOptions(
      ['node', 'index.js', '--transport', 'httpStream', '--port', '43125'],
      {}
    );

    expect(buildHttpHealthIdentity(options, {})).toBeNull();
    expect(
      buildHttpHealthIdentity(options, {
        AGENT_TEAMS_MCP_HTTP_IDENTITY_SERVICE: 'agent-teams-mcp-http',
        AGENT_TEAMS_MCP_HTTP_CLAUDE_DIR_HASH: 'claude-hash',
        AGENT_TEAMS_MCP_HTTP_LAUNCH_SPEC_HASH: 'launch-hash',
        AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID: 'owner-id',
      })
    ).toEqual({
      schemaVersion: 1,
      service: 'agent-teams-mcp-http',
      transport: 'httpStream',
      host: '127.0.0.1',
      port: 43125,
      endpoint: '/mcp',
      claudeDirHash: 'claude-hash',
      launchSpecHash: 'launch-hash',
      ownerInstanceId: 'owner-id',
    });
  });

  it('does not build HTTP health identity for stdio transport', () => {
    const options = resolveStartOptions(['node', 'index.js'], {
      AGENT_TEAMS_MCP_HTTP_IDENTITY_SERVICE: 'agent-teams-mcp-http',
      AGENT_TEAMS_MCP_HTTP_CLAUDE_DIR_HASH: 'claude-hash',
      AGENT_TEAMS_MCP_HTTP_LAUNCH_SPEC_HASH: 'launch-hash',
      AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID: 'owner-id',
    });

    expect(buildHttpHealthIdentity(options)).toBeNull();
  });
});
