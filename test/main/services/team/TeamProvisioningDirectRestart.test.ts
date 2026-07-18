import {
  buildDirectTmuxRestartCommand,
  buildDirectTmuxRestartEnvAssignments,
  hasAnthropicCompatibleAuthTokenEnv,
  isAnthropicCompatibleBaseUrl,
  isInteractiveShellCommand,
  shellQuote,
} from '@main/services/team/provisioning/TeamProvisioningDirectRestart';
import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '@shared/constants/anthropicConnectionMode';
import { describe, expect, it } from 'vitest';

describe('TeamProvisioningDirectRestart', () => {
  it('quotes shell values without losing apostrophes or empty strings', () => {
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('/tmp/demo path')).toBe("'/tmp/demo path'");
    expect(shellQuote("worker's path")).toBe("'worker'\\''s path'");
  });

  it('detects interactive shell pane commands by basename', () => {
    expect(isInteractiveShellCommand('/bin/zsh')).toBe(true);
    expect(isInteractiveShellCommand('  FISH  ')).toBe(true);
    expect(isInteractiveShellCommand('node')).toBe(false);
    expect(isInteractiveShellCommand(undefined)).toBe(false);
  });

  it('classifies Anthropic-compatible base URLs without accepting first-party or credential URLs', () => {
    expect(isAnthropicCompatibleBaseUrl('http://localhost:1234')).toBe(true);
    expect(isAnthropicCompatibleBaseUrl('https://proxy.example.test')).toBe(true);
    expect(isAnthropicCompatibleBaseUrl('https://api.anthropic.com')).toBe(false);
    expect(isAnthropicCompatibleBaseUrl('https://api-staging.anthropic.com')).toBe(false);
    expect(isAnthropicCompatibleBaseUrl('http://token@localhost:1234')).toBe(false);
    expect(isAnthropicCompatibleBaseUrl('not a url')).toBe(false);
    expect(isAnthropicCompatibleBaseUrl('')).toBe(false);
  });

  it('requires both compatible base URL and auth token for compatible auth token env', () => {
    expect(
      hasAnthropicCompatibleAuthTokenEnv({
        ANTHROPIC_BASE_URL: 'http://localhost:1234',
        ANTHROPIC_AUTH_TOKEN: 'local-token',
      })
    ).toBe(true);
    expect(
      hasAnthropicCompatibleAuthTokenEnv({
        ANTHROPIC_BASE_URL: 'http://localhost:1234',
        ANTHROPIC_AUTH_TOKEN: '   ',
      })
    ).toBe(false);
    expect(
      hasAnthropicCompatibleAuthTokenEnv({
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_AUTH_TOKEN: 'stale-token',
      })
    ).toBe(false);
  });

  it('preserves provider-specific direct restart env while resetting provider selection flags', () => {
    const assignments = buildDirectTmuxRestartEnvAssignments(
      {
        CODEX_HOME: '/tmp/codex home',
        CODEX_CLI_PATH: '/opt/codex/bin/codex',
        CLAUDE_CODE_USE_GEMINI: '1',
        CLAUDE_CODE_ENTRY_PROVIDER: 'gemini',
        CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
        CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
        CLAUDE_TEAM_RUNTIME_SETTINGS_PATH: '/tmp/runtime-settings.json',
      },
      'codex'
    );

    expect(assignments).toContain("CLAUDECODE='1'");
    expect(assignments).toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS='1'");
    expect(assignments).toContain("CODEX_HOME='/tmp/codex home'");
    expect(assignments).toContain("CODEX_CLI_PATH='/opt/codex/bin/codex'");
    expect(assignments).toContain("CLAUDE_CODE_USE_GEMINI=''");
    expect(assignments).toContain("CLAUDE_CODE_ENTRY_PROVIDER='codex'");
    expect(assignments).toContain("CLAUDE_CODE_CODEX_BACKEND='codex-native'");
    expect(assignments).toContain("CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD='chatgpt'");
    expect(assignments).toContain("CLAUDE_TEAM_RUNTIME_SETTINGS_PATH='/tmp/runtime-settings.json'");
    expect(assignments).toContain("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST='1'");
  });

  it('preserves Anthropic-compatible tokens but blanks stale first-party auth tokens', () => {
    const compatibleAssignments = buildDirectTmuxRestartEnvAssignments(
      {
        ANTHROPIC_BASE_URL: ' http://localhost:1234 ',
        ANTHROPIC_AUTH_TOKEN: ' local-token ',
        ANTHROPIC_API_KEY: '',
      },
      'anthropic'
    );

    expect(compatibleAssignments).toContain("ANTHROPIC_BASE_URL='http://localhost:1234'");
    expect(compatibleAssignments).toContain("ANTHROPIC_AUTH_TOKEN='local-token'");
    expect(compatibleAssignments).toContain("ANTHROPIC_API_KEY=''");

    const firstPartyAssignments = buildDirectTmuxRestartEnvAssignments(
      {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_AUTH_TOKEN: 'stale-token',
      },
      'anthropic'
    );

    expect(firstPartyAssignments).toContain("ANTHROPIC_BASE_URL='https://api.anthropic.com'");
    expect(firstPartyAssignments).toContain("ANTHROPIC_AUTH_TOKEN=''");
    expect(firstPartyAssignments).not.toContain('stale-token');
  });

  it('preserves the app-owned Anthropic connection intent across direct restart', () => {
    const assignments = buildDirectTmuxRestartEnvAssignments(
      {
        [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'api_key',
        CLAUDE_CODE_ENTRY_PROVIDER: 'bedrock',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
      'anthropic'
    );

    expect(assignments).toContain(
      `${AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV}='api_key'`
    );
    expect(assignments).toContain("CLAUDE_CODE_ENTRY_PROVIDER='anthropic'");
    expect(assignments).toContain("CLAUDE_CODE_USE_BEDROCK=''");
  });

  it('scrubs inherited endpoint and model routing for an explicit API-key restart', () => {
    const assignments = buildDirectTmuxRestartEnvAssignments(
      {
        [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'api_key',
        ANTHROPIC_API_KEY: 'sk-ant-direct',
        ANTHROPIC_AUTH_TOKEN: 'ambient-token',
        ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
        ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer ambient-token',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'bedrock-model-id',
        CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth-token',
      },
      'anthropic'
    );

    expect(assignments).toContain(
      `${AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV}='api_key'`
    );
    expect(assignments).toContain("ANTHROPIC_API_KEY='sk-ant-direct'");
    expect(assignments).toContain("ANTHROPIC_AUTH_TOKEN=''");
    expect(assignments).toContain("ANTHROPIC_BASE_URL=''");
    expect(assignments).toContain("ANTHROPIC_CUSTOM_HEADERS=''");
    expect(assignments).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL=''");
    expect(assignments).toContain("CLAUDE_CODE_OAUTH_TOKEN=''");
  });

  it('keeps the configured compatible endpoint while scrubbing external model aliases', () => {
    const assignments = buildDirectTmuxRestartEnvAssignments(
      {
        [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'compatible',
        ANTHROPIC_BASE_URL: 'http://localhost:1234',
        ANTHROPIC_AUTH_TOKEN: 'local-token',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Gateway-Tenant: team-1',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'bedrock-opus-id',
      },
      'anthropic'
    );

    expect(assignments).toContain("ANTHROPIC_BASE_URL='http://localhost:1234'");
    expect(assignments).toContain("ANTHROPIC_AUTH_TOKEN='local-token'");
    expect(assignments).toContain("ANTHROPIC_CUSTOM_HEADERS='X-Gateway-Tenant: team-1'");
    expect(assignments).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=''");
  });

  it('blanks competing Anthropic helper auth carriers for direct restart helper mode', () => {
    const assignments = buildDirectTmuxRestartEnvAssignments(
      {
        CLAUDE_TEAM_ANTHROPIC_AUTH_MODE: 'api_key_helper',
        CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH:
          '/tmp/team-runtime-auth/demo/runtime-settings-anthropic.json',
        ANTHROPIC_API_KEY: 'sk-ant-direct-restart-should-not-leak',
        ANTHROPIC_AUTH_TOKEN: 'direct-restart-token-should-not-leak',
        CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3',
        CLAUDE_CODE_OAUTH_TOKEN: 'direct-restart-oauth-token-should-not-leak',
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '4',
      },
      'anthropic'
    );

    expect(assignments).toContain("CLAUDE_TEAM_ANTHROPIC_AUTH_MODE='api_key_helper'");
    expect(assignments).toContain(
      "CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH='/tmp/team-runtime-auth/demo/runtime-settings-anthropic.json'"
    );
    expect(assignments).toContain("ANTHROPIC_API_KEY=''");
    expect(assignments).toContain("ANTHROPIC_AUTH_TOKEN=''");
    expect(assignments).toContain("CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=''");
    expect(assignments).toContain("CLAUDE_CODE_OAUTH_TOKEN=''");
    expect(assignments).toContain("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=''");
    expect(assignments).not.toContain('sk-ant-direct-restart-should-not-leak');
    expect(assignments).not.toContain('direct-restart-token-should-not-leak');
    expect(assignments).not.toContain('direct-restart-oauth-token-should-not-leak');
  });

  it('builds a restart command that preserves cwd, binary and args quoting', () => {
    const command = buildDirectTmuxRestartCommand({
      cwd: '/tmp/team work',
      env: { CODEX_HOME: '/tmp/codex' },
      providerId: 'codex',
      binaryPath: '/usr/local/bin/claude',
      args: ['--model', "gpt worker's model"],
    });

    expect(command).toContain("cd '/tmp/team work' && env");
    expect(command).toContain("CODEX_HOME='/tmp/codex'");
    expect(command).toContain("'/usr/local/bin/claude' '--model' 'gpt worker'\\''s model'");
    expect(command).toContain('__CLAUDE_TEAMMATE_EXIT__:%s');
  });
});
