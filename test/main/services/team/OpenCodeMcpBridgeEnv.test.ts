import { describe, expect, it } from 'vitest';

import {
  clearOpenCodeLocalMcpLaunchEnv,
  copyOpenCodeLocalMcpLaunchEnv,
  hasOpenCodeLocalMcpLaunchEnv,
  isOpenCodeMcpHttpBridgeEnabled,
} from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';

describe('OpenCodeMcpBridgeEnv', () => {
  it('uses the app-owned HTTP MCP bridge by default', () => {
    expect(isOpenCodeMcpHttpBridgeEnabled({})).toBe(true);
    expect(isOpenCodeMcpHttpBridgeEnabled({ CLAUDE_TEAM_OPENCODE_MCP_HTTP: '1' })).toBe(true);
    expect(isOpenCodeMcpHttpBridgeEnabled({ CLAUDE_TEAM_OPENCODE_MCP_HTTP: 'true' })).toBe(true);
  });

  it('keeps the legacy local MCP command path behind an explicit opt-out', () => {
    expect(isOpenCodeMcpHttpBridgeEnabled({ CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0' })).toBe(false);
    expect(isOpenCodeMcpHttpBridgeEnabled({ CLAUDE_TEAM_OPENCODE_MCP_HTTP: ' false ' })).toBe(
      false
    );
    expect(isOpenCodeMcpHttpBridgeEnabled({ CLAUDE_TEAM_OPENCODE_MCP_HTTP: 'off' })).toBe(false);
  });

  it('accepts process-style env objects', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CLAUDE_TEAM_OPENCODE_MCP_HTTP: 'no',
    };

    expect(isOpenCodeMcpHttpBridgeEnabled(env)).toBe(false);
  });

  it('detects complete local MCP launch env', () => {
    expect(
      hasOpenCodeLocalMcpLaunchEnv({
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: 'mcp-server/dist/index.js',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["mcp-server/dist/index.js"]',
      })
    ).toBe(true);

    expect(
      hasOpenCodeLocalMcpLaunchEnv({
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["mcp-server/dist/index.js"]',
      })
    ).toBe(false);
  });

  it('copies local MCP launch env for HTTP fallback without copying the HTTP URL', () => {
    const target: NodeJS.ProcessEnv = {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
    };

    copyOpenCodeLocalMcpLaunchEnv(
      {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: 'mcp-server/dist/index.js',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["mcp-server/dist/index.js"]',
      },
      target
    );

    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBe('node');
    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY).toBe('mcp-server/dist/index.js');
    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON).toBe('["mcp-server/dist/index.js"]');
    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL).toBe('http://127.0.0.1:41001/mcp');
  });

  it('removes local MCP launch env when HTTP MCP is active', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'node',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: 'mcp-server/dist/index.js',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["mcp-server/dist/index.js"]',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
    };

    clearOpenCodeLocalMcpLaunchEnv(env);

    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBeUndefined();
    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY).toBeUndefined();
    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON).toBeUndefined();
    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL).toBe('http://127.0.0.1:41001/mcp');
  });
});
