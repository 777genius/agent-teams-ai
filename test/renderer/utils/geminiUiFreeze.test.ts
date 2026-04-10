import { describe, expect, it } from 'vitest';

import {
  filterMainScreenCliProviders,
  normalizeCreateLaunchProviderForUi,
} from '@renderer/utils/geminiUiFreeze';

describe('geminiUiFreeze', () => {
  it('hides gemini from the dashboard provider list', () => {
    expect(
      filterMainScreenCliProviders([
        { providerId: 'anthropic', label: 'Anthropic' },
        { providerId: 'codex', label: 'Codex' },
        { providerId: 'gemini', label: 'Gemini' },
      ])
    ).toEqual([
      { providerId: 'anthropic', label: 'Anthropic' },
      { providerId: 'codex', label: 'Codex' },
    ]);
  });

  it('falls back to anthropic when a create or launch form receives gemini', () => {
    expect(normalizeCreateLaunchProviderForUi('gemini', true)).toBe('anthropic');
  });

  it('keeps codex available when multimodel is enabled', () => {
    expect(normalizeCreateLaunchProviderForUi('codex', true)).toBe('codex');
  });
});
