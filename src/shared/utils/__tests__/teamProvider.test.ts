import { describe, expect, it } from 'vitest';

import {
  inferTeamProviderIdFromModel,
  isTeamProviderId,
  normalizeOptionalTeamProviderId,
} from '../teamProvider';

describe('inferTeamProviderIdFromModel', () => {
  it('recognizes Anthropic aliases with 1m suffixes', () => {
    expect(inferTeamProviderIdFromModel('opus[1m]')).toBe('anthropic');
    expect(inferTeamProviderIdFromModel('sonnet[1m]')).toBe('anthropic');
    expect(inferTeamProviderIdFromModel('haiku[1m]')).toBe('anthropic');
  });

  it('recognizes full provider-scoped model ids', () => {
    expect(inferTeamProviderIdFromModel('claude-opus-4-6')).toBe('anthropic');
    expect(inferTeamProviderIdFromModel('gpt-5.4')).toBe('codex');
    expect(inferTeamProviderIdFromModel('gemini-2.5-pro')).toBe('gemini');
    expect(inferTeamProviderIdFromModel('opencode/default')).toBe('opencode');
    expect(inferTeamProviderIdFromModel('openai/gpt-5.4')).toBe('opencode');
    expect(inferTeamProviderIdFromModel('openrouter/moonshotai/kimi-k2')).toBe('opencode');
  });

  it('treats OpenCode as a valid explicit team provider id', () => {
    expect(isTeamProviderId('opencode')).toBe(true);
    expect(normalizeOptionalTeamProviderId('opencode')).toBe('opencode');
  });
});
