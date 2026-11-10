import { describe, expect, it } from 'vitest';

import { shouldLoadOpenCodeDialogCatalog } from './openCodeDialogCatalogGate';

describe('shouldLoadOpenCodeDialogCatalog', () => {
  it('does not launch model checks for Codex or Anthropic-only teams', () => {
    expect(shouldLoadOpenCodeDialogCatalog(true, true, true, ['codex'])).toBe(false);
    expect(shouldLoadOpenCodeDialogCatalog(true, true, true, ['anthropic', 'codex'])).toBe(false);
  });

  it('checks selected OpenCode routes and only when launching with multimodel enabled', () => {
    expect(shouldLoadOpenCodeDialogCatalog(true, true, true, ['codex', 'opencode'])).toBe(true);
    expect(shouldLoadOpenCodeDialogCatalog(false, true, true, ['opencode'])).toBe(false);
    expect(shouldLoadOpenCodeDialogCatalog(true, false, true, ['opencode'])).toBe(false);
    expect(shouldLoadOpenCodeDialogCatalog(true, true, false, ['opencode'])).toBe(false);
  });
});
