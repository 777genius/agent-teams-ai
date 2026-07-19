import { describe, expect, it } from 'vitest';

import { shouldShowOpenCodeNeedsTestBadge } from './teamModelSelectorUi';

describe('shouldShowOpenCodeNeedsTestBadge', () => {
  it('hides the needs-test badge for Cursor ACP, whose connection flow verifies the model', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('needs_probe', 'cursor-acp')).toBe(false);
  });

  it('keeps the needs-test badge for an unverified Kiro model', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('needs_probe', 'kiro')).toBe(true);
  });

  it('keeps the needs-test badge for other OpenCode sources', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('needs_probe', 'opencode-config')).toBe(true);
  });

  it('does not show the badge for other proof states', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('verified', 'cursor-acp')).toBe(false);
  });
});
