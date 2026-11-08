import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KanbanFilterState } from '@renderer/components/team/kanban/KanbanFilterPopover';
import type { KanbanState } from '@shared/types';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key, resolvedLanguage: 'en' }),
}));
vi.mock('@renderer/hooks/useRelativeTimeClock', () => ({
  useRelativeTimeClock: () => 0,
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0 }),
}));
vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      data-testid="column-visibility-toggle"
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { TaskTableView } from '@renderer/components/team/kanban/table/TaskTableView';

describe('task table layout and column interactions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resizes and hides columns while matching visible column widths', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <TaskTableView
          tasks={[]}
          allTasks={[]}
          kanbanState={{} as KanbanState}
          filter={{ columns: new Set() } as KanbanFilterState}
          contextId="local"
          teamName="width-test"
          members={[]}
          isActive={true}
        />
      )
    );

    const table = host.querySelector('table') as HTMLTableElement;
    const widths = (): number[] =>
      [...table.querySelectorAll('col')].map((col) => parseFloat(col.style.width));
    const sum = (): number => widths().reduce((total, width) => total + width, 0);
    expect(parseFloat(table.style.width)).toBe(1200);
    expect(sum()).toBe(1200);

    const statusHeader = host.querySelector('[data-testid="team-task-table-header-status"]');
    const resize = statusHeader?.querySelector('button[aria-label]');
    const before = widths()[1];
    act(() => {
      resize?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(widths()[1]).toBe(before + 10);
    expect(parseFloat(table.style.width)).toBe(sum());

    // Task resizing must remain effective even while it fills spare space.
    const taskHeader = host.querySelector('[data-testid="team-task-table-header-task"]');
    const resizeTask = taskHeader?.querySelector('button[aria-label]');
    const originalTaskWidth = widths()[0];
    act(() => {
      resizeTask?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(widths()[0]).toBe(originalTaskWidth + 10);
    expect(parseFloat(table.style.width)).toBe(1210);

    const toggles = host.querySelectorAll<HTMLButtonElement>(
      '[data-testid="column-visibility-toggle"]'
    );
    act(() => toggles[2].click()); // owner
    expect(host.querySelector('[data-testid="team-task-table-header-owner"]')).toBeNull();
    expect(widths()).toHaveLength(5);
    expect(parseFloat(table.style.width)).toBe(1210);
    expect(sum()).toBe(1210);
    act(() => root.unmount());
  });
});
