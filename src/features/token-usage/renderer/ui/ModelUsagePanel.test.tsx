import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelUsagePanel } from './ModelUsagePanel';

import type {
  TokenUsageBarChartItemViewModel,
  TokenUsageModelSegmentViewModel,
} from '../view-models/tokenUsageViewModel';
import type { Root } from 'react-dom/client';

const segments: TokenUsageModelSegmentViewModel[] = [
  { id: 'alpha', label: 'Alpha', tokens: '700', cost: '$7', percent: 70, color: '#0ea5e9' },
  { id: 'beta', label: 'Beta', tokens: '300', cost: '$3', percent: 30, color: '#10b981' },
];
const bars: TokenUsageBarChartItemViewModel[] = [
  {
    id: 'alpha',
    label: 'Alpha',
    value: '700',
    cost: '$7',
    requests: '7 req',
    detail: '$7 / 7 req',
    percent: 100,
    tone: 'model',
    tooltip: 'Alpha usage',
  },
  {
    id: 'beta',
    label: 'Beta',
    value: '300',
    cost: '$3',
    requests: '3 req',
    detail: '$3 / 3 req',
    percent: 43,
    tone: 'model',
    tooltip: 'Beta usage',
  },
];

describe('ModelUsagePanel highlight', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (visibleSegments = segments, visibleBars = bars): Promise<void> => {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ModelUsagePanel
            modelSegments={visibleSegments}
            modelBars={visibleBars}
            t={(key) => key}
            locale="en"
          />
        </TooltipProvider>
      );
    });
  };

  const button = (name: string): HTMLButtonElement => {
    const element = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${name} usage"]`
    );
    if (!element) throw new Error(`Missing ${name} model`);
    return element;
  };

  it('restores the focused model after a pointer leaves another model', async () => {
    await render();
    await act(async () => button('Beta').focus());
    expect(container.querySelector('.usage-model-center')?.textContent).toContain('Beta');
    await act(async () =>
      button('Alpha').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    );
    expect(container.querySelector('.usage-model-center')?.textContent).toContain('Alpha');
    await act(async () =>
      button('Alpha').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    );
    expect(document.activeElement).toBe(button('Beta'));
    expect(container.querySelector('.usage-model-center')?.textContent).toContain('Beta');
    expect(container.querySelector('.usage-model-center')?.textContent).toContain('30%');
  });

  it('keeps the remaining chart visible when filtering removes the hovered model', async () => {
    await render();
    await act(async () =>
      button('Beta').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    );
    expect(container.querySelector('.usage-model-center')?.textContent).toContain('Beta');
    await render([{ ...segments[0], percent: 100 }], [bars[0]]);
    expect(container.querySelector('.usage-model-center')?.textContent).toContain('Alpha');
    expect(container.querySelector('.usage-model-center')?.textContent).toContain('100%');
    expect(container.querySelectorAll('.usage-model-arc[data-muted="true"]')).toHaveLength(0);
  });
});
