import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamLoadingSkeleton } from './TeamLoadingSkeleton';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('./TeamProvisioningBanner', () => ({
  TeamProvisioningBanner: () => null,
}));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('TeamLoadingSkeleton Kanban', () => {
  it('uses the live five-column flat layout and shared card skeletons', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TeamLoadingSkeleton
          teamName="test-team"
          messagesPanelMode="inline"
          headerColorSet={{
            border: '#3b82f6',
            badge: 'rgba(59, 130, 246, 0.15)',
            text: '#60a5fa',
          }}
          isLight={false}
        />
      );
      await Promise.resolve();
    });

    const columns = Array.from(host.querySelectorAll<HTMLElement>('.kanban-column-glow'));
    expect(columns).toHaveLength(5);
    expect(
      columns.map((column) => column.style.getPropertyValue('--kanban-column-accent'))
    ).toEqual([
      'rgb(59, 130, 246)',
      'rgb(234, 179, 8)',
      'rgb(139, 92, 246)',
      'rgb(20, 184, 166)',
      'rgb(101, 163, 13)',
    ]);
    expect(columns.every((column) => column.className.includes('animate-pulse'))).toBe(true);
    expect(columns.every((column) => !column.className.includes('border'))).toBe(true);
    expect(columns.every((column) => !column.className.includes('rounded-md'))).toBe(true);

    const gridItems = columns.map((column) => column.parentElement!);
    const grid = gridItems[0]?.parentElement;
    const fullBleedWrapper = grid?.parentElement;
    expect(fullBleedWrapper?.className).toContain('-mx-4');
    expect(fullBleedWrapper?.className).toContain('w-[calc(100%+2rem)]');
    expect(gridItems.map((item) => item.style.gridColumn)).toEqual([
      '1 / span 4',
      '5 / span 4',
      '9 / span 4',
      '1 / span 6',
      '7 / span 6',
    ]);
    expect(gridItems.map((item) => item.style.gridRow)).toEqual([
      '1 / span 14',
      '1 / span 14',
      '1 / span 14',
      '15 / span 14',
      '15 / span 14',
    ]);
    expect(host.querySelectorAll('.kanban-column-header-glow')).toHaveLength(5);
    expect(host.querySelectorAll('.kanban-task-card-skeleton')).toHaveLength(8);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
