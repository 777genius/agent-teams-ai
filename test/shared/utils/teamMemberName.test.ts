import { describe, expect, it } from 'vitest';

import { createCliAutoSuffixNameGuard, parseNumericSuffixName } from '@shared/utils/teamMemberName';

describe('teamMemberName helpers', () => {
  it('parses numeric suffix names', () => {
    expect(parseNumericSuffixName('alice-2')).toEqual({ base: 'alice', suffix: 2 });
    expect(parseNumericSuffixName('alice')).toBeNull();
    expect(parseNumericSuffixName('')).toBeNull();
  });

  it('drops cli auto-suffixed names only when the base name also exists', () => {
    const keepName = createCliAutoSuffixNameGuard(['dev', 'dev-2', 'dev-3']);

    expect(keepName('dev')).toBe(true);
    expect(keepName('dev-2')).toBe(false);
    expect(keepName('dev-3')).toBe(false);
  });

  it('keeps -1 names because they are often intentional', () => {
    const keepName = createCliAutoSuffixNameGuard(['worker', 'worker-1']);

    expect(keepName('worker')).toBe(true);
    expect(keepName('worker-1')).toBe(true);
  });

  it('keeps suffixed names when the base name is absent', () => {
    const keepName = createCliAutoSuffixNameGuard(['alice-2']);

    expect(keepName('alice-2')).toBe(true);
  });

  it('treats base-name collisions case-insensitively', () => {
    const keepName = createCliAutoSuffixNameGuard(['Alice', 'alice-2']);

    expect(keepName('alice-2')).toBe(false);
  });
});
