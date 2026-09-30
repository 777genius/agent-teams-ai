import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { RecentProjectCard } from '@features/recent-projects/renderer/ui/RecentProjectCard';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecentProjectCardModel } from '@features/recent-projects/renderer/browser';

const card: RecentProjectCardModel = {
  identity: { scopeKey: 'local', targetKey: 'recent-1', readEpoch: 1 },
  name: 'alpha',
  subtitle: '~/alpha',
  activity: { kind: 'known', value: { label: 'a minute ago', observedAt: 100, freshness: 'fresh' } },
  providers: { kind: 'known', value: [{ id: 'codex', freshness: 'fresh' }] },
  branch: { kind: 'known', value: 'main' },
  taskCounts: { kind: 'known', value: { pending: 1, inProgress: 1, completed: 2 } },
  tasksLoading: false,
  activeTeams: { kind: 'known', value: [{ targetKey: 'team-a', displayName: 'Team A' }] },
  open: { support: 'supported', availability: 'available' },
  reveal: { support: 'supported', availability: 'available' },
  desktopPathDetails: [{ label: 'Primary path', text: '/Users/test/alpha' }],
};

describe('RecentProjectCard', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('keeps rich desktop facts and renders separate accessible actions without native title', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const open = vi.fn();
    const reveal = vi.fn();
    act(() => root.render(<TooltipProvider><RecentProjectCard card={card} onClick={open} onOpenPath={reveal} /></TooltipProvider>));

    const cell = host.querySelector<HTMLElement>('[data-recent-project-cell="project"]');
    expect(cell?.classList.contains('project-row-zebra-card')).toBe(true);
    expect(cell?.querySelector('button button')).toBeNull();
    expect(cell?.querySelector('[title]')).toBeNull();
    expect(cell?.textContent).toContain('main');
    expect(cell?.textContent).toContain('Team A');
    expect(cell?.querySelector('[role="progressbar"]')).not.toBeNull();
    const buttons = cell?.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    act(() => buttons?.[1]?.click());
    expect(reveal).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    act(() => buttons?.[0]?.click());
    expect(open).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it('marks stale activity and providers while keeping temporary unavailability distinct from deletion', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const unavailable = { support: 'supported', availability: 'unavailable', reason: 'Workspace mount is temporarily unavailable.' } as const;
    const staleCard: RecentProjectCardModel = {
      ...card,
      activity: { kind: 'known', value: { label: 'a minute ago', observedAt: 100, freshness: 'stale' } },
      providers: { kind: 'known', value: [{ id: 'codex', freshness: 'stale' }] },
      open: unavailable,
      reveal: unavailable,
    };
    act(() => root.render(<TooltipProvider><RecentProjectCard card={staleCard} onClick={vi.fn()} onOpenPath={vi.fn()} /></TooltipProvider>));

    expect(host.textContent).toContain('last known');
    expect(host.textContent).toContain('Last known');
    expect(host.textContent).toContain('Unavailable');
    expect(host.textContent).toContain('Workspace mount is temporarily unavailable.');
    expect(host.textContent).not.toContain('recentProjects.card.deleted');
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);

    act(() => root.render(<TooltipProvider><RecentProjectCard card={{ ...staleCard, open: { ...unavailable, cause: 'deleted' } }} onClick={vi.fn()} /></TooltipProvider>));
    expect(host.textContent).toContain('Deleted');
    act(() => root.unmount());
  });
});
