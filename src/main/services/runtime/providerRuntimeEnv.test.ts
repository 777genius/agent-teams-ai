import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '@shared/constants/anthropicConnectionMode';
import { describe, expect, it } from 'vitest';

import {
  type AnthropicRuntimeConnectionPreference,
  applyProviderRuntimeEnv,
} from './providerRuntimeEnv';

const AUTO_CONNECTION: AnthropicRuntimeConnectionPreference = {
  authMode: 'auto',
  compatibleEndpoint: { enabled: false },
};

function applyAutoProviderRuntimeEnv(
  env: NodeJS.ProcessEnv,
  providerId: Parameters<typeof applyProviderRuntimeEnv>[1]
): NodeJS.ProcessEnv {
  return applyProviderRuntimeEnv(env, providerId, AUTO_CONNECTION);
}

describe('applyProviderRuntimeEnv', () => {
  it('preserves Bedrock as an Anthropic runtime backend', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_PROFILE: 'cc',
      AWS_REGION: 'us-east-1',
    };

    applyAutoProviderRuntimeEnv(env, 'anthropic');

    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('bedrock');
    expect(env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]).toBe('auto');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(env.AWS_PROFILE).toBe('cc');
    expect(env.AWS_REGION).toBe('us-east-1');
  });

  it('preserves Vertex as an Anthropic runtime backend', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_VERTEX: 'true',
      GOOGLE_CLOUD_PROJECT: 'project-1',
    };

    applyAutoProviderRuntimeEnv(env, 'anthropic');

    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('vertex');
    expect(env.CLAUDE_CODE_USE_VERTEX).toBe('1');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.GOOGLE_CLOUD_PROJECT).toBe('project-1');
  });

  it('preserves Claude Platform on AWS as an Anthropic runtime backend', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_123',
      AWS_PROFILE: 'cc',
      AWS_REGION: 'us-west-2',
    };

    applyAutoProviderRuntimeEnv(env, 'anthropic');

    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('claude-platform-aws');
    expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe('wrkspc_123');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(env.AWS_PROFILE).toBe('cc');
    expect(env.AWS_REGION).toBe('us-west-2');
  });

  it('does not infer Claude Platform on AWS from AWS profile and region alone', () => {
    const env: NodeJS.ProcessEnv = {
      AWS_PROFILE: 'cc',
      AWS_REGION: 'us-west-2',
    };

    applyAutoProviderRuntimeEnv(env, 'anthropic');

    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('anthropic');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.AWS_PROFILE).toBe('cc');
    expect(env.AWS_REGION).toBe('us-west-2');
  });

  it('keeps Bedrock ahead of Claude Platform on AWS when both are configured', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_123',
      AWS_PROFILE: 'cc',
      AWS_REGION: 'us-east-1',
    };

    applyAutoProviderRuntimeEnv(env, 'anthropic');

    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('bedrock');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe('wrkspc_123');
  });

  it('still strips Anthropic backend routing when Codex is selected', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_123',
      AWS_PROFILE: 'cc',
    };

    applyAutoProviderRuntimeEnv(env, 'codex');

    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('codex');
    expect(env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]).toBe('auto');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe('wrkspc_123');
    expect(env.AWS_PROFILE).toBe('cc');
  });

  it('carries explicit Anthropic intent through a non-Anthropic primary', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
    };

    applyProviderRuntimeEnv(env, 'codex', {
      authMode: 'api_key',
      compatibleEndpoint: { enabled: false },
    });

    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('codex');
    expect(env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]).toBe('api_key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test');
  });

  it.each([
    ['api_key', 'api_key'],
    ['oauth', 'subscription'],
  ] as const)(
    'forces direct Anthropic routing for %s mode and scrubs external backend aliases',
    (authMode, expectedMode) => {
      const env: NodeJS.ProcessEnv = {
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example.test',
        ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_123',
        ANTHROPIC_AWS_API_KEY: 'platform-key',
        ANTHROPIC_BASE_URL: 'http://localhost:1234',
        ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer gateway-token',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'bedrock-sonnet-id',
        ANTHROPIC_API_KEY: 'sk-ant-direct',
        AWS_PROFILE: 'shared-tools-profile',
      };

      applyProviderRuntimeEnv(env, 'anthropic', {
        authMode,
        compatibleEndpoint: { enabled: false },
      });

      expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('anthropic');
      expect(env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]).toBe(expectedMode);
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(env.CLAUDE_CODE_SKIP_BEDROCK_AUTH).toBeUndefined();
      expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBeUndefined();
      expect(env.ANTHROPIC_AWS_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-direct');
      expect(env.AWS_PROFILE).toBe('shared-tools-profile');
    }
  );

  it('gives the app-managed compatible endpoint precedence over ambient Bedrock routing', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_BASE_URL: 'https://ambient-gateway.example.test',
      ANTHROPIC_AUTH_TOKEN: 'compatible-token',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Gateway-Tenant: team-1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'bedrock-opus-id',
    };

    applyProviderRuntimeEnv(env, 'anthropic', {
      authMode: 'api_key',
      compatibleEndpoint: { enabled: true },
    });

    expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('anthropic');
    expect(env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]).toBe('compatible');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('compatible-token');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Gateway-Tenant: team-1');
  });
});
