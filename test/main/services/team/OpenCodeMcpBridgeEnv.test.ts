import {
  clearOpenCodeLocalMcpLaunchEnv,
  copyOpenCodeLocalMcpLaunchEnv,
  hasOpenCodeLocalMcpLaunchEnv,
  isOpenCodeMcpHttpBridgeEnabled,
  shouldEnsureOpenCodeLocalMcpLaunchEnv,
  snapshotOpenCodeLocalMcpLaunchEnv,
} from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { describe, expect, it } from 'vitest';

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
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: '{"ELECTRON_RUN_AS_NODE":"1"}',
      },
      target
    );

    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBe('node');
    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY).toBe('mcp-server/dist/index.js');
    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON).toBe('["mcp-server/dist/index.js"]');
    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON).toBe(
      '{"ELECTRON_RUN_AS_NODE":"1"}'
    );
    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL).toBe('http://127.0.0.1:41001/mcp');
  });

  it('resolves local MCP launch env even when HTTP MCP already has a URL', () => {
    expect(
      shouldEnsureOpenCodeLocalMcpLaunchEnv({
        httpBridgeEnabled: true,
        mcpUrl: 'http://127.0.0.1:41001/mcp',
      })
    ).toBe(true);
  });

  it('skips local MCP launch env only when HTTP bridge is disabled and a URL already exists', () => {
    expect(
      shouldEnsureOpenCodeLocalMcpLaunchEnv({
        httpBridgeEnabled: false,
        mcpUrl: 'http://127.0.0.1:41001/mcp',
      })
    ).toBe(false);

    expect(
      shouldEnsureOpenCodeLocalMcpLaunchEnv({
        httpBridgeEnabled: false,
        mcpUrl: undefined,
      })
    ).toBe(true);
  });

  it('snapshots explicit local MCP launch env before mutating an env object', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: ' node ',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: ' mcp-server/dist/index.js ',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: ' ["mcp-server/dist/index.js"] ',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: ' {"ELECTRON_RUN_AS_NODE":"1"} ',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
    };

    const snapshot = snapshotOpenCodeLocalMcpLaunchEnv(env);
    clearOpenCodeLocalMcpLaunchEnv(env);

    expect(snapshot).toEqual({
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'node',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: 'mcp-server/dist/index.js',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["mcp-server/dist/index.js"]',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: '{"ELECTRON_RUN_AS_NODE":"1"}',
    });
    expect(hasOpenCodeLocalMcpLaunchEnv(snapshot ?? {})).toBe(true);
    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBeUndefined();
    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON).toBeUndefined();
  });

  it('migrates legacy MCP child env into the local MCP env JSON snapshot', () => {
    const snapshot = snapshotOpenCodeLocalMcpLaunchEnv({
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'node',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: 'mcp-server/dist/index.js',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["mcp-server/dist/index.js"]',
      ELECTRON_RUN_AS_NODE: '1',
    });

    expect(snapshot?.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON).toBe(
      '{"ELECTRON_RUN_AS_NODE":"1"}'
    );
    expect(snapshot?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('removes local MCP launch env when explicitly requested', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'node',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: 'mcp-server/dist/index.js',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["mcp-server/dist/index.js"]',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: '{"ELECTRON_RUN_AS_NODE":"1"}',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
      ELECTRON_RUN_AS_NODE: '1',
    };

    clearOpenCodeLocalMcpLaunchEnv(env);

    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBeUndefined();
    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY).toBeUndefined();
    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON).toBeUndefined();
    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL).toBe('http://127.0.0.1:41001/mcp');
  });
});
