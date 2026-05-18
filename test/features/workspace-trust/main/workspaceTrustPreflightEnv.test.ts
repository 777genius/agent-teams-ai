import { describe, expect, it } from 'vitest';

import { buildWorkspaceTrustPreflightEnv } from '@features/workspace-trust/main';

describe('workspaceTrustPreflightEnv', () => {
  it('strips team runtime and provider-routing env while preserving user auth env', () => {
    const env = buildWorkspaceTrustPreflightEnv({
      HOME: '/Users/tester',
      PATH: '/usr/local/bin',
      CLAUDE_CONFIG_DIR: '/Users/tester/.claude-custom',
      ANTHROPIC_API_KEY: 'user-anthropic-key',
      ANTHROPIC_AUTH_TOKEN: 'user-oauth-token',
      OPENAI_API_KEY: 'user-openai-key',
      CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP: '1',
      CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:1234',
      CLAUDE_TEAM_ANTHROPIC_AUTH_MODE: 'api_key_helper',
      CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER: '1',
      CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH: '/tmp/helper-settings.json',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_ENTRY_PROVIDER: 'codex',
      CLAUDE_CODE_USE_OPENAI: '1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_USE_GEMINI: '1',
      CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      CLAUDE_CODE_GEMINI_BACKEND: 'api',
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: '/tmp/opencode',
      CODEX_HOME: '/tmp/codex-home',
      AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/tmp/spool',
      AGENT_TEAMS_MCP_CLAUDE_DIR: '/tmp/claude-dir',
      CLAUDE_TEAM_BOOTSTRAP_TOKEN: 'bootstrap-token',
    });

    expect(env).toMatchObject({
      HOME: '/Users/tester',
      PATH: '/usr/local/bin',
      CLAUDE_CONFIG_DIR: '/Users/tester/.claude-custom',
      ANTHROPIC_API_KEY: 'user-anthropic-key',
      ANTHROPIC_AUTH_TOKEN: 'user-oauth-token',
      OPENAI_API_KEY: 'user-openai-key',
    });
    expect(env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP).toBeUndefined();
    expect(env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
    expect(env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE).toBeUndefined();
    expect(env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER).toBeUndefined();
    expect(env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH).toBeUndefined();
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_OPENAI).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_GEMINI).toBeUndefined();
    expect(env.CLAUDE_CODE_CODEX_BACKEND).toBeUndefined();
    expect(env.CLAUDE_CODE_GEMINI_BACKEND).toBeUndefined();
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT).toBeUndefined();
    expect(env.AGENT_TEAMS_MCP_CLAUDE_DIR).toBeUndefined();
    expect(env.CLAUDE_TEAM_BOOTSTRAP_TOKEN).toBeUndefined();
  });
});
