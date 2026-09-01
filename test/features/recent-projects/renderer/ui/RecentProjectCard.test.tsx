import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { RecentProjectCard } from '@features/recent-projects/renderer/ui/RecentProjectCard';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecentProjectCardModel } from '@features/recent-projects/renderer/view-models/recentProjectsSectionViewModel';

const card: RecentProjectCardModel = {
  id: 'repo:alpha',
  project: {
    id: 'repo:alpha',
    name: 'alpha',
    primaryPath: '/Users/test/alpha',
    associatedPaths: ['/Users/test/alpha'],
    mostRecentActivity: Date.parse('2026-09-01T12:00:00Z'),
    providerIds: [],
    source: 'codex',
    openTarget: { type: 'synthetic-path', path: '/Users/test/alpha' },
  },
  name: 'alpha',
  formattedPath: '~/alpha',
  lastActivityLabel: 'a minute ago',
  providerIds: [],
  tasksLoading: false,
  additionalPathCount: 0,
};

describe('RecentProjectCard', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not render a decorative project icon beside the project title', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <TooltipProvider>
          <RecentProjectCard card={card} onClick={vi.fn()} onOpenPath={vi.fn()} />
        </TooltipProvider>
      );
    });

    const heading = host.querySelector('h3');
    const headerRow = heading?.parentElement?.parentElement?.parentElement;

    expect(heading?.textContent).toBe('alpha');
    expect(headerRow?.querySelector('svg')).toBeNull();
  });
});
