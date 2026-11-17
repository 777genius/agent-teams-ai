import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KanbanApprovedSettingsMenu } from '../../../../../src/renderer/components/team/kanban/KanbanApprovedSettingsMenu';

const popoverMock = vi.hoisted(() => ({
  current: null as null | { open: boolean; onOpenChange: (open: boolean) => void },
}));

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    popoverMock.current = { open, onOpenChange };
    return <>{children}</>;
  },
  PopoverContent: ({ children }: { children: React.ReactNode }) =>
    popoverMock.current?.open ? <div>{children}</div> : null,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <span onClick={() => popoverMock.current?.onOpenChange(true)}>{children}</span>
  ),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const q = <T extends HTMLElement>(testId: string): T | null =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

function setPrompt(value: string): void {
  const area = q<HTMLTextAreaElement>('kanban-review-flow-prompt')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('KanbanApprovedSettingsMenu', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    popoverMock.current = null;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  const mount = (onSave: (settings: unknown) => Promise<void>): void => {
    act(() => {
      createRoot(container).render(
        <KanbanApprovedSettingsMenu
          reviewFlow="agent_approval"
          reviewFlowPrompt=""
          onSave={onSave as never}
        />
      );
    });
    act(() => q<HTMLButtonElement>('kanban-approved-settings')!.parentElement!.click());
  };

  it('saves the chosen flow and instructions together, only once something changed', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    mount(onSave);
    const save = q<HTMLButtonElement>('kanban-review-flow-save')!;
    expect(save.disabled).toBe(true);
    expect(q<HTMLInputElement>('kanban-review-flow-agent_approval')!.checked).toBe(true);

    act(() => q<HTMLInputElement>('kanban-review-flow-human_approval')!.click());
    setPrompt('  Run the e2e suite first.  ');
    expect(save.disabled).toBe(false);
    await act(async () => save.click());

    expect(onSave).toHaveBeenCalledWith({
      reviewFlow: 'human_approval',
      reviewFlowPrompt: '  Run the e2e suite first.  ',
    });
    expect(popoverMock.current?.open).toBe(false);
  });

  it('discards an unsaved draft on Cancel and reopens from the persisted flow', () => {
    const onSave = vi.fn(() => Promise.resolve());
    mount(onSave);
    act(() => q<HTMLInputElement>('kanban-review-flow-human_approval')!.click());
    setPrompt('temporary');

    act(() => popoverMock.current!.onOpenChange(false));
    act(() => popoverMock.current!.onOpenChange(true));

    expect(onSave).not.toHaveBeenCalled();
    expect(q<HTMLInputElement>('kanban-review-flow-agent_approval')!.checked).toBe(true);
    expect(q<HTMLTextAreaElement>('kanban-review-flow-prompt')!.value).toBe('');
  });

  it('keeps the panel open with the draft when saving fails', async () => {
    const onSave = vi.fn(() => Promise.reject(new Error('write failed')));
    mount(onSave);
    act(() => q<HTMLInputElement>('kanban-review-flow-human_approval')!.click());
    await act(async () => q<HTMLButtonElement>('kanban-review-flow-save')!.click());

    expect(popoverMock.current?.open).toBe(true);
    expect(q<HTMLInputElement>('kanban-review-flow-human_approval')!.checked).toBe(true);
  });
});
