import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { KanbanTaskCardSkeleton } from './KanbanTaskCardSkeleton';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('KanbanTaskCardSkeleton', () => {
  it('matches the flat task card metadata, owner text, and separator geometry', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<KanbanTaskCardSkeleton height={116} showSeparator />);
      await Promise.resolve();
    });

    const card = host.firstElementChild as HTMLElement | null;
    expect(card?.className).toContain('kanban-task-card-flat');
    expect(card?.className).toContain('bg-transparent');
    expect(card?.className).not.toContain('border');
    expect(card?.getAttribute('data-task-separator')).toBe('true');
    expect(card?.style.height).toBe('116px');

    const owner = card?.querySelector<HTMLElement>('[data-kanban-skeleton-owner]');
    expect(owner?.className).toContain('gap-1');
    expect(owner?.className).not.toContain('rounded');
    expect(owner?.className).not.toContain('border');
    expect(owner?.children[0]?.className).toContain('size-4');
    expect(owner?.children[0]?.className).toContain('rounded-full');
    expect(owner?.children[1]?.className).toContain('h-2');
    expect(owner?.children[1]?.className).toContain('w-8');
    expect(card?.querySelector('.mt-3')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
