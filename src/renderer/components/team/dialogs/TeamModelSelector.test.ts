import { describe, expect, it } from 'vitest';

import {
  shouldElevateOpenCodeVirtualRow,
  shouldShowOpenCodeNeedsTestBadge,
} from './teamModelSelectorUi';

describe('shouldShowOpenCodeNeedsTestBadge', () => {
  it.each(['cursor-acp', 'kiro'])(
    'hides the needs-test badge for the %s OpenCode source',
    (sourceId) => {
      expect(shouldShowOpenCodeNeedsTestBadge('needs_probe', sourceId)).toBe(false);
    }
  );

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
