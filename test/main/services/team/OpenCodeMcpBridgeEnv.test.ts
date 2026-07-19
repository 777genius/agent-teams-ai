import {
  buildOpenCodeAppScopedMcpOwnershipMarker,
  buildOpenCodeAppScopedMcpUrl,
  clearOpenCodeLocalMcpLaunchEnv,
  copyOpenCodeLocalMcpLaunchEnv,
  hasOpenCodeLocalMcpLaunchEnv,
  isOpenCodeMcpHttpBridgeEnabled,
  mergeOpenCodeLocalMcpChildEnvironment,
  shouldEnsureOpenCodeLocalMcpLaunchEnv,
  snapshotOpenCodeLocalMcpLaunchEnv,
} from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { describe, expect, it } from 'vitest';

describe('OpenCodeMcpBridgeEnv', () => {
  it('adds an app-instance marker without changing the MCP network endpoint', () => {
    const scopedUrl = buildOpenCodeAppScopedMcpUrl('http://127.0.0.1:41001/mcp', '123-456');
    const parsed = new URL(scopedUrl);

    expect(`${parsed.origin}${parsed.pathname}${parsed.search}`).toBe('http://127.0.0.1:41001/mcp');
    expect(parsed.hash).toBe('#agent-teams-app-instance=123-456');
    expect(buildOpenCodeAppScopedMcpOwnershipMarker('123-456')).toBe(
      'agent-teams-app-instance=123-456'
    );
  });

  it('preserves existing URL fragments when adding the app-instance marker', () => {
    expect(
      buildOpenCodeAppScopedMcpUrl('http://127.0.0.1:41001/mcp#transport=http', '123-456')
    ).toBe('http://127.0.0.1:41001/mcp#transport=http&agent-teams-app-instance=123-456');
  });

  it('rejects an empty app-instance marker', () => {
    expect(() => buildOpenCodeAppScopedMcpUrl('http://127.0.0.1:41001/mcp', '  ')).toThrow(
      'OpenCode app instance id is required'
    );
    expect(() => buildOpenCodeAppScopedMcpOwnershipMarker('  ')).toThrow(
      'OpenCode app instance id is required'
    );
  });

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
    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON).toBe('{"ELECTRON_RUN_AS_NODE":"1"}');
    expect(target.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL).toBe('http://127.0.0.1:41001/mcp');
  });

  it('merges app ownership into the local MCP child environment', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: '{"ELECTRON_RUN_AS_NODE":"1"}',
    };

    mergeOpenCodeLocalMcpChildEnvironment(env, {
      CLAUDE_TEAM_APP_INSTANCE_ID: '123-456',
    });

    expect(JSON.parse(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON ?? '{}')).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_TEAM_APP_INSTANCE_ID: '123-456',
    });
  });

  it('replaces malformed optional local MCP child environment safely', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: '{broken',
    };

    mergeOpenCodeLocalMcpChildEnvironment(env, {
      CLAUDE_TEAM_APP_INSTANCE_ID: '123-456',
    });

    expect(JSON.parse(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON ?? '{}')).toEqual({
      CLAUDE_TEAM_APP_INSTANCE_ID: '123-456',
    });
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
