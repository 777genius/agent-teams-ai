import { describe, expect, it } from 'vitest';

import { formatTeamRuntimeSummary } from './teamRuntimeSummary';

describe('formatTeamRuntimeSummary', () => {
  it('does not claim a backend when the provider is unknown', () => {
    const label = formatTeamRuntimeSummary(undefined, 'gpt-5.3-codex');
    expect(label).toBeTruthy();
    expect(label).not.toContain('undefined');
    expect(label).not.toContain('via ');
  });

  it('retains a known backend for models without its brand', () => {
    expect(formatTeamRuntimeSummary('opencode', 'gpt-5.3-codex')).toContain('via OpenCode');
  });
});
