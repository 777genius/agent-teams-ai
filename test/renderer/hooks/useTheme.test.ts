import { beforeEach, describe, expect, it } from 'vitest';

import { readCachedResolvedTheme, writeCachedResolvedTheme } from '@renderer/hooks/useTheme';

describe('theme cache migration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads the new Agent Teams theme cache key first', () => {
    localStorage.setItem('claude-devtools-theme-cache', 'dark');
    localStorage.setItem('agent-teams-theme-cache', 'light');

    expect(readCachedResolvedTheme()).toBe('light');
  });

  it('falls back to the legacy Claude DevTools theme cache key', () => {
    localStorage.setItem('claude-devtools-theme-cache', 'dark');

    expect(readCachedResolvedTheme()).toBe('dark');
  });

  it('writes only the new Agent Teams theme cache key', () => {
    localStorage.setItem('claude-devtools-theme-cache', 'dark');

    writeCachedResolvedTheme('light');

    expect(localStorage.getItem('agent-teams-theme-cache')).toBe('light');
    expect(localStorage.getItem('claude-devtools-theme-cache')).toBe('dark');
  });
});
