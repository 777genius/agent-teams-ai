// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  applyProviderRuntimeEnv,
  resolveTeamProviderId,
} from '@main/services/runtime/providerRuntimeEnv';

describe('providerRuntimeEnv', () => {
  it('pins gemini runtime mode and marks provider routing as host-managed', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      CLAUDE_CODE_USE_GEMINI: undefined,
      CLAUDE_CODE_USE_BEDROCK: '1',
    };

    const result = applyProviderRuntimeEnv(env, 'gemini');

    expect(result.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    expect(result.CLAUDE_CODE_ENTRY_PROVIDER).toBe('gemini');
    expect(result.CLAUDE_CODE_USE_OPENAI).toBeUndefined();
    expect(result.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('pins anthropic explicitly instead of relying on default provider fallback', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_ENTRY_PROVIDER: 'codex',
      CLAUDE_CODE_USE_OPENAI: '1',
    };

    const result = applyProviderRuntimeEnv(env, 'anthropic');

    expect(result.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
    expect(result.CLAUDE_CODE_ENTRY_PROVIDER).toBe('anthropic');
    expect(result.CLAUDE_CODE_USE_OPENAI).toBeUndefined();
  });

  it('preserves gemini as a valid team provider id', () => {
    expect(resolveTeamProviderId('gemini')).toBe('gemini');
    expect(resolveTeamProviderId('codex')).toBe('codex');
    expect(resolveTeamProviderId(undefined)).toBe('anthropic');
  });
});
