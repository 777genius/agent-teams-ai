import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  popover: null as null | { open: boolean; onOpenChange: (open: boolean) => void },
  openSettingsTab: vi.fn(),
  panel: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ openSettingsTab: hoisted.openSettingsTab }),
}));
vi.mock('@features/review-flow/renderer', () => ({
  ReviewFlowTeamPanel: (props: {
    teamName: string;
    testIdPrefix: string;
    onSaved: () => void;
    onCancel: () => void;
  }) => {
    hoisted.panel(props);
    return (
      <div data-testid="team-panel">
        <button data-testid="panel-saved" onClick={props.onSaved} />
        <button data-testid="panel-cancel" onClick={props.onCancel} />
      </div>
    );
  },
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
    hoisted.popover = { open, onOpenChange };
    return <>{children}</>;
  },
  PopoverContent: ({ children }: { children: React.ReactNode }) =>
    hoisted.popover?.open ? <div>{children}</div> : null,
  // Radix Popover opens on click, which is what the trigger stand-in reproduces.
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <span onClick={() => hoisted.popover?.onOpenChange(true)}>{children}</span>
  ),
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

import { KanbanApprovedSettingsMenu } from '../../../../../src/renderer/components/team/kanban/KanbanApprovedSettingsMenu';

const q = <T extends HTMLElement>(testId: string): T | null =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

describe('KanbanApprovedSettingsMenu', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hoisted.popover = null;
    hoisted.openSettingsTab.mockClear();
    hoisted.panel.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(<KanbanApprovedSettingsMenu teamName="alpha" />);
    });
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  const open = (): void =>
    act(() => q<HTMLButtonElement>('kanban-approved-settings')!.parentElement!.click());

  it('opens on click with this team\'s review flow, keeping the E2E test id prefix', () => {
    expect(q('team-panel')).toBeNull();
    open();
    expect(q('team-panel')).not.toBeNull();
    expect(hoisted.panel.mock.calls[0][0]).toMatchObject({
      teamName: 'alpha',
      testIdPrefix: 'kanban-review-flow',
    });
  });

  it('closes after a save and after Cancel', () => {
    open();
    act(() => q<HTMLButtonElement>('panel-saved')!.click());
    expect(hoisted.popover?.open).toBe(false);

    open();
    act(() => q<HTMLButtonElement>('panel-cancel')!.click());
    expect(hoisted.popover?.open).toBe(false);
  });

  it('jumps to the Review flow settings tab for the default of all teams', () => {
    open();
    act(() => q<HTMLButtonElement>('kanban-review-flow-open-settings')!.click());
    expect(hoisted.openSettingsTab).toHaveBeenCalledWith('reviewFlow');
    expect(hoisted.popover?.open).toBe(false);
  });
});
