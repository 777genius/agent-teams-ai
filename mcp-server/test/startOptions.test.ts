import { describe, expect, it } from 'vitest';

import { resolveStartOptions } from '../src/index';

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
});
