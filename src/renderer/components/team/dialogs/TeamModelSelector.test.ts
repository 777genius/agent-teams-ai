import { describe, expect, it } from 'vitest';

import {
  shouldElevateOpenCodeVirtualRow,
  shouldShowOpenCodeNeedsTestBadge,
  shouldShowOpenCodeOverviewStatus,
} from './teamModelSelectorUi';

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

  it('does not show a misleading per-model badge for a live configured local server', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('needs_probe', 'ollama', 'configured_local')).toBe(
      false
    );
  });

  it('does not show the badge for other proof states', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('verified', 'cursor-acp')).toBe(false);
  });
});

describe('shouldElevateOpenCodeVirtualRow', () => {
  it('keeps the active heading below its sticky copy', () => {
    expect(shouldElevateOpenCodeVirtualRow('heading', 4, 4)).toBe(false);
  });

  it('raises an incoming heading above the previous sticky heading', () => {
    expect(shouldElevateOpenCodeVirtualRow('heading', 8, 4)).toBe(true);
  });

  it('never raises model rows', () => {
    expect(shouldElevateOpenCodeVirtualRow('models', 5, 4)).toBe(false);
  });
});

describe('shouldShowOpenCodeOverviewStatus', () => {
  it('shows overview guidance only on the unfiltered OpenCode tab', () => {
    expect(shouldShowOpenCodeOverviewStatus('opencode', 0, 0)).toBe(true);
    expect(shouldShowOpenCodeOverviewStatus('opencode', 1, 0)).toBe(false);
    expect(shouldShowOpenCodeOverviewStatus('opencode', 0, 1)).toBe(false);
    expect(shouldShowOpenCodeOverviewStatus('anthropic', 0, 0)).toBe(false);
  });
});
