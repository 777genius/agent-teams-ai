// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  applyProviderRuntimeEnv,
  resolveTeamProviderId,
} from '@main/services/runtime/providerRuntimeEnv';

describe('providerRuntimeEnv', () => {
  it('enables Gemini runtime mode and clears other third-party provider flags', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      CLAUDE_CODE_USE_GEMINI: undefined,
      CLAUDE_CODE_USE_BEDROCK: '1',
    };

    const result = applyProviderRuntimeEnv(env, 'gemini');

    expect(result.CLAUDE_CODE_USE_GEMINI).toBe('1');
    expect(result.CLAUDE_CODE_USE_OPENAI).toBeUndefined();
    expect(result.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('preserves gemini as a valid team provider id', () => {
    expect(resolveTeamProviderId('gemini')).toBe('gemini');
    expect(resolveTeamProviderId('codex')).toBe('codex');
    expect(resolveTeamProviderId(undefined)).toBe('anthropic');
  });
});
