import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Dialogs = typeof import('@renderer/components/team/TeamDetailLazyDialogs');

interface DialogCase {
  name: keyof Dialogs;
  modulePath: string;
  element: (
    dialogs: Dialogs,
    open: boolean,
    onClose: () => void,
    teamName: string
  ) => React.ReactElement;
}

const cases: DialogCase[] = [
  {
    name: 'AddMemberDialog',
    modulePath: '@renderer/components/team/dialogs/AddMemberDialog',
    element: (dialogs, open, onClose, teamName) => (
      <dialogs.AddMemberDialog
        open={open}
        teamName={teamName}
        existingNames={['alice']}
        onClose={onClose}
        onAdd={vi.fn()}
      />
    ),
  },
  {
    name: 'EditTeamDialog',
    modulePath: '@renderer/components/team/dialogs/EditTeamDialog',
    element: (dialogs, open, onClose, teamName) => (
      <dialogs.EditTeamDialog
        open={open}
        teamName={teamName}
        currentName={teamName}
        currentDescription="Team description"
        currentColor="blue"
        currentMembers={[]}
        onClose={onClose}
        onChangeLeadRuntime={vi.fn()}
        onSaved={vi.fn()}
      />
    ),
  },
  {
    name: 'ReviewDialog',
    modulePath: '@renderer/components/team/dialogs/ReviewDialog',
    element: (dialogs, open, onClose, teamName) => (
      <dialogs.ReviewDialog
        open={open}
        teamName={teamName}
        taskId="task-1"
        members={[]}
        onCancel={onClose}
        onSubmit={vi.fn()}
      />
    ),
  },
  {
    name: 'TrashDialog',
    modulePath: '@renderer/components/team/kanban/TrashDialog',
    element: (dialogs, open, onClose) => (
      <dialogs.TrashDialog open={open} tasks={[]} onClose={onClose} onRestore={vi.fn()} />
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

describe.each(cases)('$name loading boundary', (dialog) => {
  function prepareImport() {
    const pending = Promise.withResolvers<void>();
    const loaded = vi.fn();
    const rendered = vi.fn();
    vi.doMock(dialog.modulePath, async () => {
      loaded();
      await pending.promise;
      return {
        [dialog.name]: (props: { onClose?: () => void; onCancel?: () => void }) => {
          rendered(props);
          return <button onClick={props.onClose ?? props.onCancel}>Close dialog</button>;
        },
      };
    });
    return { pending, loaded, rendered };
  }

  it('loads only when opened and forwards the latest props after a pending import', async () => {
    const { pending, loaded, rendered } = prepareImport();
    const dialogs = await import('@renderer/components/team/TeamDetailLazyDialogs');
    const originalClose = vi.fn();
    await act(async () => root.render(dialog.element(dialogs, false, originalClose, 'alpha')));
    expect(loaded).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');

    await act(async () => root.render(dialog.element(dialogs, true, originalClose, 'alpha')));
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    expect(rendered).not.toHaveBeenCalled();
    const currentClose = vi.fn();
    const current = dialog.element(dialogs, true, currentClose, 'beta');
    await act(async () => {
      root.render(current);
      pending.resolve();
    });
    expect(rendered).toHaveBeenLastCalledWith(current.props);
    act(() => host.querySelector('button')?.click());
    expect(currentClose).toHaveBeenCalledTimes(1);
    expect(originalClose).not.toHaveBeenCalled();
  });

  it('stays closed when an import settles, then reopens with the current props', async () => {
    const { pending, loaded, rendered } = prepareImport();
    const dialogs = await import('@renderer/components/team/TeamDetailLazyDialogs');
    await act(async () => root.render(dialog.element(dialogs, true, vi.fn(), 'alpha')));
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    await act(async () => root.render(dialog.element(dialogs, false, vi.fn(), 'alpha')));
    await act(async () => pending.resolve());
    expect(rendered).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');

    const currentClose = vi.fn();
    const reopened = dialog.element(dialogs, true, currentClose, 'beta');
    await act(async () => root.render(reopened));
    expect(rendered).toHaveBeenLastCalledWith(reopened.props);
    expect(loaded).toHaveBeenCalledTimes(1);
    act(() => host.querySelector('button')?.click());
    expect(currentClose).toHaveBeenCalledTimes(1);
  });

  it('passes a failed import through to the existing error boundary', async () => {
    const { pending, loaded, rendered } = prepareImport();
    const dialogs = await import('@renderer/components/team/TeamDetailLazyDialogs');
    const failure = new Error(`${dialog.name} could not be loaded`);
    await act(async () =>
      root.render(<ErrorBoundary>{dialog.element(dialogs, true, vi.fn(), 'alpha')}</ErrorBoundary>)
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
