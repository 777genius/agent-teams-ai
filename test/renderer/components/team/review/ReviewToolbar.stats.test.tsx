import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ReviewToolbar } from '@renderer/components/team/review/ReviewToolbar';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChangeStats } from '@shared/types';

describe('review captured change statistics', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });
  async function shown(stats: ChangeStats) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ReviewToolbar
            stats={{ pending: 0, accepted: 0, rejected: 0 }}
            changeStats={stats}
            collapseUnchanged={false}
            applying={false}
            autoViewed={false}
            onAutoViewedChange={() => {}}
            onAcceptAll={() => {}}
            onRejectAll={() => {}}
            onApply={() => {}}
            onCollapseUnchangedChange={() => {}}
          />
        </TooltipProvider>
      )
    );
    const text = host.querySelector('[data-testid="review-change-stats"]')?.textContent;
    await act(async () => root.unmount());
    return text;
  }
  it('shows partial captured counts and an unknown marker for empty partial inventory', async () => {
    expect(
      await shown({ linesAdded: 0, linesRemoved: 0, filesChanged: 0, completeness: 'partial' })
    ).toBe('?');
    expect(
      await shown({ linesAdded: 2, linesRemoved: 1, filesChanged: 1, completeness: 'partial' })
    ).toContain('~');
    expect(
      await shown({ linesAdded: 0, linesRemoved: 0, filesChanged: 1, completeness: 'unavailable' })
    ).toBe('?');
    expect(await shown({ linesAdded: 0, linesRemoved: 0, filesChanged: 0 })).toContain('+0');
  });
});
