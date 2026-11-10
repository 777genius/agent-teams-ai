import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActivityHeatmapPanel } from './ActivityHeatmapPanel';

import type { TokenUsageActivityDayViewModel } from '../view-models/tokenUsageViewModel';
import type { Root } from 'react-dom/client';

describe('Activity heatmap current streak', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T23:59:30Z'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = async (id: string): Promise<void> => {
    const days: TokenUsageActivityDayViewModel[] = [
      {
        id,
        label: id,
        title: `${id}: 10 tokens`,
        tokens: '10',
        cost: '$0',
        tokenValue: 10,
        intensity: 1,
      },
    ];
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ActivityHeatmapPanel
            days={days}
            t={(key, options) =>
              key === 'tokenUsage.labels.streakCount' ? `${options?.count} day streak` : key
            }
          />
        </TooltipProvider>
      )
    );
  };

  it('hides a stale streak badge entirely while keeping historical calendar activity visible', async () => {
    await render('2026-06-30');
    expect(container.querySelector('.usage-streak')).toBeNull();
    expect(container.querySelector('button[aria-label="2026-06-30: 10 tokens"]')).not.toBeNull();
  });

  it('refreshes at UTC midnight without receiving a new snapshot and cleans up its clock', async () => {
    await render('2026-10-02');
    expect(container.querySelector('.usage-streak')?.textContent).toBe('1 day streak');
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(container.querySelector('.usage-streak')).toBeNull();
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
