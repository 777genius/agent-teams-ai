import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ProjectContextMenu } from '@renderer/components/sidebar/ProjectContextMenu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    React.createElement('div', { 'data-testid': 'project-context-menu-content' }, children),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => React.createElement('button', { type: 'button', onClick: () => onSelect?.() }, children),
}));

function renderProjectContextMenu(options?: {
  autoOpen?: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
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
      <ProjectContextMenu
        isPinned={options?.isPinned ?? false}
        onTogglePin={options?.onTogglePin ?? vi.fn()}
      >
        <span>Project folder</span>
      </ProjectContextMenu>
    );
  });

  return { host, root };
}

describe('ProjectContextMenu', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    contextMenuMockState.autoOpen = false;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not mount menu content while closed', () => {
    const { host, root } = renderProjectContextMenu();

    expect(host.textContent).toBe('Project folder');
    expect(host.querySelector('[data-testid="project-context-menu-content"]')).toBeNull();

    act(() => root.unmount());
  });

  it('mounts only pin/unpin and calls onTogglePin', () => {
    const onTogglePin = vi.fn();
    const { host, root } = renderProjectContextMenu({ autoOpen: true, onTogglePin });

    const content = host.querySelector('[data-testid="project-context-menu-content"]');
    expect(content).not.toBeNull();
    expect(host.textContent).toContain('taskContextMenu.pin');
    expect(host.textContent).not.toContain('taskContextMenu.rename');
    expect(host.textContent).not.toContain('taskContextMenu.archive');
    expect(host.textContent).not.toContain('taskContextMenu.deleteTask');
    expect(host.textContent).not.toContain('taskContextMenu.markUnread');

    const pinButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('taskContextMenu.pin')
    );
    expect(pinButton).not.toBeUndefined();
    act(() => pinButton?.click());
    expect(onTogglePin).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it('shows unpin when the project folder is already pinned', () => {
    const { host, root } = renderProjectContextMenu({ autoOpen: true, isPinned: true });

    expect(host.textContent).toContain('taskContextMenu.unpin');
    expect(host.textContent).not.toContain('taskContextMenu.rename');

    act(() => root.unmount());
  });
});
