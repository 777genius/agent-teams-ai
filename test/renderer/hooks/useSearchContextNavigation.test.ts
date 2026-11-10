import { describe, expect, it } from 'vitest';

import { findCurrentSearchResultInContainer } from '../../../src/renderer/hooks/navigation/utils';

describe('useSearchContextNavigation helpers', () => {
  it('finds current search result only within the provided container', () => {
    const activeContainer = document.createElement('div');
    activeContainer.innerHTML = `
      <div data-search-result="current" id="active-result"></div>
    `;

    const inactiveContainer = document.createElement('div');
    inactiveContainer.innerHTML = `
      <div data-search-result="current" id="inactive-result"></div>
    `;

    document.body.appendChild(inactiveContainer);
    document.body.appendChild(activeContainer);

    const result = findCurrentSearchResultInContainer(activeContainer);
    expect(result?.id).toBe('active-result');
  });

  it('returns null when container is missing', () => {
    expect(findCurrentSearchResultInContainer(null)).toBeNull();
  });

  it('finds the exact current result using item identity metadata', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <mark
        data-search-result="current"
        data-search-item-id="ai-1"
        data-search-match-index="0"
        id="first"
      ></mark>
      <mark
        data-search-result="current"
        data-search-item-id="ai-1"
        data-search-match-index="1"
        id="second"
      ></mark>
    `;

    const result = findCurrentSearchResultInContainer(container, 'ai-1', 1);
    expect(result?.id).toBe('second');
  });
});
