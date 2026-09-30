import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGraphCreateTaskDialog } from './useGraphCreateTaskDialog';

import type { TeamGraphTaskNotificationPort } from '../ports/TeamGraphTaskNotificationPort';
import type { ReactElement, ReactNode } from 'react';
import type { Root } from 'react-dom/client';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  interaction: { submit: vi.fn() },
  getInteraction: vi.fn(),
  storeState: {
    activeContextId: 'context-a',
    isTeamProvisioning: false,
    members: [],
    teamData: { isAlive: true, tasks: [] },
  },
}));

vi.mock('@renderer/components/team/dialogs/CreateTaskDialog', () => ({
  CreateTaskDialog: () => null,
}));
vi.mock('@renderer/composition/team/desktopCreateTaskSessions', () => ({
  getDesktopCreateTaskInteraction: mocks.getInteraction,
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: (state: typeof mocks.storeState) => state.isTeamProvisioning,
  selectResolvedMembersForTeamName: (state: typeof mocks.storeState) => state.members,
  selectTeamDataForName: (state: typeof mocks.storeState) => state.teamData,
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }));

interface DialogProps {
  open: boolean;
  defaultOwner: string;
  interaction: typeof mocks.interaction;
  onClose(): void;
}

function dialogProps(dialog: ReactNode): DialogProps {
  return (dialog as ReactElement<DialogProps>).props;
}

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.clearAllMocks();
});

describe('useGraphCreateTaskDialog', () => {
  it('uses the scope-owned Desktop interaction and keeps dialog state local', () => {
    mocks.getInteraction.mockReturnValue(mocks.interaction);
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    let result: ReturnType<typeof useGraphCreateTaskDialog> | undefined;
    const Host = (): null => {
      result = useGraphCreateTaskDialog('alpha', {} as TeamGraphTaskNotificationPort);
      return null;
    };

    act(() => root.render(<Host />));
    expect(mocks.getInteraction).toHaveBeenCalledWith('alpha', 'context-a');
    expect(dialogProps(result!.dialog).interaction).toBe(mocks.interaction);

    act(() => result!.openCreateTaskDialog('alice'));
    expect(dialogProps(result!.dialog)).toMatchObject({ open: true, defaultOwner: 'alice' });

    act(() => dialogProps(result!.dialog).onClose());
    expect(dialogProps(result!.dialog).open).toBe(false);
    expect(mocks.interaction.submit).not.toHaveBeenCalled();
  });
});
