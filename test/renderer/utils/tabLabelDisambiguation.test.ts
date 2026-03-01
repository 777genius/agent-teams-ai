/**
 * Tests for tab label disambiguation utility.
 */

import { describe, expect, it } from 'vitest';

import { computeDisambiguatedTabs } from '../../../src/renderer/utils/tabLabelDisambiguation';

import type { EditorFileTab } from '../../../src/shared/types/editor';

// =============================================================================
// Helpers
// =============================================================================

function makeTab(filePath: string): EditorFileTab {
  const fileName = filePath.split('/').pop() ?? 'file';
  return {
    id: filePath,
    filePath,
    fileName,
    language: 'TypeScript',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('computeDisambiguatedTabs', () => {
  it('returns tabs unchanged when all names are unique', () => {
    const tabs = [makeTab('/project/src/app.ts'), makeTab('/project/src/index.ts')];

    const result = computeDisambiguatedTabs(tabs);

    expect(result[0].disambiguatedLabel).toBeUndefined();
    expect(result[1].disambiguatedLabel).toBeUndefined();
  });

  it('adds labels for 2 tabs with the same file name', () => {
    const tabs = [
      makeTab('/project/src/main/utils/index.ts'),
      makeTab('/project/src/renderer/hooks/index.ts'),
    ];

    const result = computeDisambiguatedTabs(tabs);

    expect(result[0].disambiguatedLabel).toBe('(utils)');
    expect(result[1].disambiguatedLabel).toBe('(hooks)');
  });

  it('goes deeper when parent dirs also match', () => {
    const tabs = [
      makeTab('/project/src/main/utils/index.ts'),
      makeTab('/project/src/renderer/utils/index.ts'),
    ];

    const result = computeDisambiguatedTabs(tabs);

    // Both have "utils" parent, need deeper suffix
    expect(result[0].disambiguatedLabel).toBe('(main/utils)');
    expect(result[1].disambiguatedLabel).toBe('(renderer/utils)');
  });

  it('handles 3 tabs with the same name', () => {
    const tabs = [
      makeTab('/project/src/main/utils/index.ts'),
      makeTab('/project/src/renderer/utils/index.ts'),
      makeTab('/project/src/shared/utils/index.ts'),
    ];

    const result = computeDisambiguatedTabs(tabs);

    expect(result[0].disambiguatedLabel).toBe('(main/utils)');
    expect(result[1].disambiguatedLabel).toBe('(renderer/utils)');
    expect(result[2].disambiguatedLabel).toBe('(shared/utils)');
  });

  it('does not add labels for unique names among duplicates', () => {
    const tabs = [
      makeTab('/project/src/main/index.ts'),
      makeTab('/project/src/renderer/index.ts'),
      makeTab('/project/src/app.tsx'),
    ];

    const result = computeDisambiguatedTabs(tabs);

    expect(result[0].disambiguatedLabel).toBe('(main)');
    expect(result[1].disambiguatedLabel).toBe('(renderer)');
    expect(result[2].disambiguatedLabel).toBeUndefined(); // unique name
  });

  it('handles single tab (no disambiguation needed)', () => {
    const tabs = [makeTab('/project/src/index.ts')];

    const result = computeDisambiguatedTabs(tabs);

    expect(result[0].disambiguatedLabel).toBeUndefined();
  });

  it('handles empty array', () => {
    const result = computeDisambiguatedTabs([]);
    expect(result).toEqual([]);
  });

  it('clears labels when tab is closed and names become unique', () => {
    // Start with 2 index.ts
    const tabs = [makeTab('/project/src/main/index.ts'), makeTab('/project/src/renderer/index.ts')];

    const withLabels = computeDisambiguatedTabs(tabs);
    expect(withLabels[0].disambiguatedLabel).toBe('(main)');
    expect(withLabels[1].disambiguatedLabel).toBe('(renderer)');

    // Close one — remaining should lose its label
    const afterClose = computeDisambiguatedTabs([withLabels[1]]);
    expect(afterClose[0].disambiguatedLabel).toBeUndefined();
  });

  it('preserves tab reference when label unchanged', () => {
    const tab = makeTab('/project/src/app.ts');
    const tabs = [tab];

    const result = computeDisambiguatedTabs(tabs);

    // Same object reference (no unnecessary re-render)
    expect(result[0]).toBe(tab);
  });
});
