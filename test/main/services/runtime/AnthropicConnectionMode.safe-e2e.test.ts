// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configState = vi.hoisted(() => ({
  authMode: 'auto' as 'auto' | 'oauth' | 'api_key',
}));

vi.mock('@main/services/infrastructure/ConfigManager', () => {
  const configManager = {
    getConfig: () => ({
      providerConnections: {
        anthropic: {
          authMode: configState.authMode,
          fastModeDefault: false,
          compatibleEndpoint: { enabled: false, baseUrl: '' },
        },
        codex: {
          preferredAuthMode: 'auto',
          customProvider: { enabled: false, baseUrl: '', model: '' },
        },
      },
      runtime: {
        providerBackends: {
          gemini: 'auto',
          codex: 'codex-native',
        },
      },
    }),
  };

  return {
    ConfigManager: { getInstance: () => configManager },
    configManager,
  };
});

describe('Anthropic connection mode safe e2e', () => {
  let tempHome: string;

  beforeEach(async () => {
    vi.resetModules();
    configState.authMode = 'auto';
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'anthropic-connection-mode-e2e-'));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('keeps explicit API key mode on the direct Anthropic route despite Bedrock shell env', async () => {
    configState.authMode = 'api_key';
    const { buildProviderAwareCliEnv } = await import(
      '@main/services/runtime/providerAwareCliEnv'
    );

    const result = await buildProviderAwareCliEnv({
      binaryPath: '/mock/claude-multimodel',
      providerId: 'anthropic',
      shellEnv: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
        ANTHROPIC_MODEL: 'bedrock-model-id',
        ANTHROPIC_API_KEY: 'sk-ant-direct',
        AWS_PROFILE: 'user-bedrock-profile',
      },
    });

    expect(result.connectionIssues).toEqual({});
    expect(result.env).toMatchObject({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'api_key',
      ANTHROPIC_API_KEY: 'sk-ant-direct',
      AWS_PROFILE: 'user-bedrock-profile',
    });
    expect(result.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(result.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it('keeps subscription mode on Anthropic OAuth despite Bedrock and API-key shell env', async () => {
    configState.authMode = 'oauth';
    const { buildProviderAwareCliEnv } = await import(
      '@main/services/runtime/providerAwareCliEnv'
    );

    const result = await buildProviderAwareCliEnv({
      binaryPath: '/mock/claude-multimodel',
      providerId: 'anthropic',
      shellEnv: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        PATH: '/usr/bin:/bin',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
        ANTHROPIC_API_KEY: 'sk-ant-should-not-win',
      },
    });

    expect(result.env).toMatchObject({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'subscription',
    });
    expect(result.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(result.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});
