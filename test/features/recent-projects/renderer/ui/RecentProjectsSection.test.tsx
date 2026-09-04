import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
  cards: [{ id: 'repo:alpha' }],
  loading: false,
  error: null,
  canLoadMore: false,
  isElectron: true,
  loadMore: vi.fn(),
  reload: vi.fn(),
  openRecentProject: vi.fn(),
  openProjectPath: vi.fn(),
  selectProjectFolder: vi.fn(),
}));

vi.mock('@features/recent-projects/renderer/hooks/useRecentProjectsSection', () => ({
  useRecentProjectsSection: () => hookState,
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      key === 'recentProjects.selectFolder'
        ? 'Select Folder'
        : key === 'recentProjects.selectFolderTitle'
          ? 'Select a project folder'
          : key,
  }),
}));

vi.mock('@features/recent-projects/renderer/ui/RecentProjectCard', () => ({
  RecentProjectCard: () => (
    <button className="project-row-zebra-card" data-recent-project-cell="project">
      alpha
    </button>
  ),
}));

import { RecentProjectsSection } from '@features/recent-projects/renderer/ui/RecentProjectsSection';

describe('RecentProjectsSection', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hookState.selectProjectFolder.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders Select Folder and projects inside one dense divided grid', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(<RecentProjectsSection searchQuery="" />);
    });

    const grid = host.querySelector<HTMLElement>('[data-recent-projects-grid]');
    const selectFolder = host.querySelector<HTMLButtonElement>(
      '[data-recent-project-cell="select-folder"]'
    );

    expect(grid).not.toBeNull();
    expect(grid?.classList.contains('gap-px')).toBe(true);
    expect(grid?.classList.contains('overflow-hidden')).toBe(true);
    expect(grid?.classList.contains('rounded-lg')).toBe(true);
    expect(grid?.classList.contains('border')).toBe(true);
    expect(grid?.querySelectorAll('[data-recent-project-cell]')).toHaveLength(2);

    expect(selectFolder?.textContent).toContain('Select Folder');
    expect(selectFolder?.getAttribute('aria-label')).toBe('Select a project folder');
    expect(selectFolder?.classList.contains('project-row-zebra-card')).toBe(true);
    expect(selectFolder?.classList.contains('items-center')).toBe(true);
    expect(selectFolder?.classList.contains('justify-center')).toBe(true);
    expect(selectFolder?.classList.contains('border')).toBe(false);
    expect([...selectFolder?.classList ?? []].some((name) => name.startsWith('rounded'))).toBe(
      false
    );

    act(() => selectFolder?.click());
    expect(hookState.selectProjectFolder).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
