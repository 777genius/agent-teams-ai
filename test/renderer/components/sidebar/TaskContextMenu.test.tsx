import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TaskContextMenu } from '@renderer/components/sidebar/TaskContextMenu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlobalTask } from '@shared/types';

const contextMenuMockState = vi.hoisted(() => ({
  autoOpen: false,
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    React.useEffect(() => {
      if (contextMenuMockState.autoOpen && open !== true) {
        onOpenChange?.(true);
      }
    }, [onOpenChange, open]);
    return React.createElement('div', { 'data-context-menu-open': open ? 'true' : 'false' }, children);
  },
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  ContextMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'task-context-menu-content' }, children),
  ContextMenuItem: ({
    children,
    onSelect,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    className?: string;
  }) =>
    React.createElement(
      'button',
      { className, type: 'button', onClick: () => onSelect?.() },
      children
    ),
  ContextMenuSeparator: () => React.createElement('hr'),
}));

function renderTaskContextMenu(options?: {
  autoOpen?: boolean;
  onRename?: () => void;
}): {
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
} {
  contextMenuMockState.autoOpen = options?.autoOpen ?? false;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      <TaskContextMenu
        task={{ id: 'task-1' } as GlobalTask}
        isPinned={false}
        isArchived={false}
        onTogglePin={vi.fn()}
        onToggleArchive={vi.fn()}
        onMarkUnread={vi.fn()}
        onRename={options?.onRename ?? vi.fn()}
        onDelete={vi.fn()}
      >
        <span>Task row</span>
      </TaskContextMenu>
    );
  });

  return { host, root };
}

describe('TaskContextMenu', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    contextMenuMockState.autoOpen = false;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not mount menu content while closed', () => {
    const { host, root } = renderTaskContextMenu();

    expect(host.textContent).toBe('Task row');
    expect(host.querySelector('[data-testid="task-context-menu-content"]')).toBeNull();

    act(() => root.unmount());
  });

  it('mounts menu content when opened and keeps actions wired', () => {
    const onRename = vi.fn();
    const { host, root } = renderTaskContextMenu({ autoOpen: true, onRename });

    const content = host.querySelector('[data-testid="task-context-menu-content"]');
    expect(content).not.toBeNull();
    expect(host.textContent).toContain('taskContextMenu.rename');

    const renameButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('taskContextMenu.rename')
    );
    expect(renameButton).not.toBeUndefined();
    act(() => renameButton?.click());
    expect(onRename).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
