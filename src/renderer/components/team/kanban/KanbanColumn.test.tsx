import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { KanbanColumn } from './KanbanColumn';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('KanbanColumn flat appearance', () => {
  it('uses layered gradients without an accent line or opaque column surface', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <KanbanColumn
          title="TODO"
          count={2}
          accentColor="rgb(59, 130, 246)"
          icon={<span data-testid="column-icon" />}
        >
          <div data-testid="column-content">Task content</div>
        </KanbanColumn>
      );
      await Promise.resolve();
    });

    const column = host.querySelector<HTMLElement>('section');
    const header = host.querySelector<HTMLElement>('header');
    const body = header?.nextElementSibling;
    expect(column?.style.getPropertyValue('--kanban-column-accent')).toBe('rgb(59, 130, 246)');
    expect(column?.className).toContain('kanban-column-glow');
    expect(column?.className).not.toContain('bg-[var(--color-surface)]');
    expect(column?.className).not.toContain('rounded-md');
    expect(header?.className).toContain('kanban-column-header-glow');
    expect(header?.className).not.toContain('border-b-2');
    expect(header?.style.borderBottomColor).toBe('');
    expect(body?.className).not.toContain('pr-2');
    expect(body?.className).not.toContain('px-2');
    expect(host.textContent).toContain('TODO');
    expect(host.textContent).toContain('2');
    expect(host.textContent).toContain('Task content');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
