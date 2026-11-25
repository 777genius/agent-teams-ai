import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

// The public entrypoint's refresh utility does not need a real application store here.
vi.mock('@renderer/store', () => ({ useStore: {} }));

type Dialogs = typeof import('../index');

const member: ResolvedTeamMember = {
  name: 'alice',
  agentType: 'developer',
  status: 'idle',
  currentTaskId: null,
  taskCount: 0,
  lastActiveAt: null,
  messageCount: 0,
};

interface DialogCase {
  name: 'EditTeamMemberDialog' | 'TeamMemberSettingsDialogBridge';
  modulePath: string;
  element: (dialogs: Dialogs, onClose: () => void, teamName: string) => React.ReactElement;
}

const cases: DialogCase[] = [
  {
    name: 'EditTeamMemberDialog',
    modulePath: './EditTeamMemberDialog',
    element: (dialogs, onClose, teamName) => (
      <dialogs.EditTeamMemberDialog
        open
        teamName={teamName}
        member={member}
        isTeamAlive
        isTeamProvisioning={false}
        isMixedTeam={false}
        onClose={onClose}
        onRefresh={vi.fn()}
        onRelaunchRequired={vi.fn()}
      />
    ),
  },
  {
    name: 'TeamMemberSettingsDialogBridge',
    modulePath: './TeamMemberSettingsDialogBridge',
    element: (dialogs, onClose, teamName) => (
      <dialogs.TeamMemberSettingsDialogBridge
        teamName={teamName}
        memberName={member.name}
        members={[member]}
        isTeamAlive
        isTeamProvisioning={false}
        onClose={onClose}
        onRefresh={vi.fn()}
        onRelaunchRequired={vi.fn()}
      />
    ),
  },
];

class ErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): React.ReactNode {
    return this.state.failed ? <div>Existing error boundary</div> : this.props.children;
  }
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const caught = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  caught.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host, { onCaughtError: caught });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  for (const dialog of cases) vi.doUnmock(dialog.modulePath);
  vi.restoreAllMocks();
});

describe.each(cases)('$name public loading boundary', (dialog) => {
  function prepareImport() {
    const pending = Promise.withResolvers<void>();
    const loaded = vi.fn();
    const rendered = vi.fn();
    vi.doMock(dialog.modulePath, async () => {
      loaded();
      await pending.promise;
      return {
        [dialog.name]: (props: { onClose: () => void }) => {
          rendered(props);
          return <button onClick={props.onClose}>Close dialog</button>;
        },
      };
    });
    return { pending, loaded, rendered };
  }

  it('keeps utility imports cold and forwards the latest props after opening', async () => {
    const { pending, loaded, rendered } = prepareImport();
    const dialogs = await import('../index');
    expect(dialogs.refreshTeamMemberSettings).toBeTypeOf('function');
    expect(dialogs.assertMemberSettingsRelaunchRoster).toBeTypeOf('function');
    expect(loaded).not.toHaveBeenCalled();

    const originalClose = vi.fn();
    await act(async () => root.render(dialog.element(dialogs, originalClose, 'alpha')));
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    expect(rendered).not.toHaveBeenCalled();
    const currentClose = vi.fn();
    const current = dialog.element(dialogs, currentClose, 'beta');
    await act(async () => {
      root.render(current);
      pending.resolve();
    });
    expect(rendered).toHaveBeenLastCalledWith(current.props);
    act(() => host.querySelector('button')?.click());
    expect(currentClose).toHaveBeenCalledTimes(1);
    expect(originalClose).not.toHaveBeenCalled();
  });

  it('stays unmounted when a closed import settles and reopens with current props', async () => {
    const { pending, loaded, rendered } = prepareImport();
    const dialogs = await import('../index');
    await act(async () => root.render(dialog.element(dialogs, vi.fn(), 'alpha')));
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    // TeamDetailView closes the member-settings route by unmounting its bridge.
    await act(async () => root.render(null));
    await act(async () => pending.resolve());
    expect(rendered).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');

    const currentClose = vi.fn();
    const reopened = dialog.element(dialogs, currentClose, 'beta');
    await act(async () => root.render(reopened));
    expect(rendered).toHaveBeenLastCalledWith(reopened.props);
    expect(loaded).toHaveBeenCalledTimes(1);
    act(() => host.querySelector('button')?.click());
    expect(currentClose).toHaveBeenCalledTimes(1);
  });

  it('preserves a failed import for the existing error boundary', async () => {
    const { pending, loaded, rendered } = prepareImport();
    const dialogs = await import('../index');
    const failure = new Error(`${dialog.name} could not be loaded`);
    await act(async () =>
      root.render(<ErrorBoundary>{dialog.element(dialogs, vi.fn(), 'alpha')}</ErrorBoundary>)
    );
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    await act(async () => pending.reject(failure));
    expect(host.textContent).toBe('Existing error boundary');
    expect(caught).toHaveBeenCalledTimes(1);
    // Vitest wraps a rejected mock factory; the original import error stays its cause.
    expect(caught.mock.calls[0][0]).toHaveProperty('cause', failure);
    expect(rendered).not.toHaveBeenCalled();
  });
});
