// @vitest-environment node
import {
  applyProviderRuntimeEnv,
  resolveTeamProviderId,
} from '@main/services/runtime/providerRuntimeEnv';
import { describe, expect, it } from 'vitest';

const AUTO_CONNECTION = {
  authMode: 'auto' as const,
  compatibleEndpoint: { enabled: false },
};

describe('providerRuntimeEnv', () => {
  it('pins gemini runtime mode and marks provider routing as host-managed', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      CLAUDE_CODE_USE_GEMINI: undefined,
      CLAUDE_CODE_USE_BEDROCK: '1',
    };

    const result = applyProviderRuntimeEnv(env, 'gemini', AUTO_CONNECTION);

    expect(result.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    expect(result.CLAUDE_CODE_ENTRY_PROVIDER).toBe('gemini');
    expect(result.AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE).toBe('auto');
    expect(result.CLAUDE_CODE_USE_OPENAI).toBeUndefined();
    expect(result.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('pins anthropic explicitly instead of relying on default provider fallback', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_ENTRY_PROVIDER: 'codex',
      CLAUDE_CODE_USE_OPENAI: '1',
    };

    const result = applyProviderRuntimeEnv(env, 'anthropic', AUTO_CONNECTION);

    expect(result.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    expect(result.CLAUDE_CODE_ENTRY_PROVIDER).toBe('anthropic');
    expect(result.CLAUDE_CODE_USE_OPENAI).toBeUndefined();
  });

  it('pins Claude Platform on AWS only when the workspace id is explicit', () => {
    const awsOnlyEnv: NodeJS.ProcessEnv = {
      AWS_PROFILE: 'cc',
      AWS_REGION: 'us-west-2',
    };
    expect(
      applyProviderRuntimeEnv(awsOnlyEnv, 'anthropic', AUTO_CONNECTION)
        .CLAUDE_CODE_ENTRY_PROVIDER
    ).toBe('anthropic');

    const platformEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_123',
      AWS_PROFILE: 'cc',
      AWS_REGION: 'us-west-2',
    };
    expect(
      applyProviderRuntimeEnv(platformEnv, 'anthropic', AUTO_CONNECTION)
        .CLAUDE_CODE_ENTRY_PROVIDER
    ).toBe('claude-platform-aws');
  });

  it('preserves gemini as a valid team provider id', () => {
    expect(resolveTeamProviderId('gemini')).toBe('gemini');
    expect(resolveTeamProviderId('codex')).toBe('codex');
    expect(resolveTeamProviderId('opencode')).toBe('opencode');
    expect(resolveTeamProviderId(undefined)).toBe('anthropic');
  });
});
