import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useManagementApplied } from '../../../../src/features/external-agent-connection/renderer/useManagementApplied';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { TeamManagementCommittedChange } from '@features/team-prompt-management/contracts';

interface State {
  activeContextId: string;
  teamManagementNoticeByTeam: Record<string, TeamManagementCommittedChange>;
}
type Listener = (state: State, previous: State) => void;
const listeners = new Set<Listener>();
let state: State;
vi.mock('@renderer/store', () => ({
  useStore: {
    getState: () => state,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));

const context: AppConnectionContext = {
  appInstanceId: 'test-app',
  dataRootFingerprint: 'test-root',
  connectionGeneration: 1,
};
function publish(operationId: string, owner = context): void {
  const previous = state;
  state = {
    ...state,
    teamManagementNoticeByTeam: {
      sandbox: {
        operationId,
        committedAt: new Date().toISOString(),
        kind: 'edited',
        changedFields: ['description'],
        context: owner,
      },
    },
  };
  for (const listener of listeners) listener(state, previous);
}

const Probe = ({ open, onApplied }: { open: boolean; onApplied(): void }): null => {
  useManagementApplied(open, context, onApplied);
  return null;
};

describe('management completion navigation callback', () => {
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    state = { activeContextId: 'local', teamManagementNoticeByTeam: {} };
    listeners.clear();
    root = createRoot(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('does not navigate on ordinary close or pre-existing changes, and delivers a new commit once', () => {
    const onApplied = vi.fn();
    publish('before-opening');
    act(() => root.render(<Probe open onApplied={onApplied} />));
    expect(onApplied).not.toHaveBeenCalled();
    act(() => root.render(<Probe open={false} onApplied={onApplied} />));
    publish('while-closed');
    expect(onApplied).not.toHaveBeenCalled();
    act(() => root.render(<Probe open onApplied={onApplied} />));
    publish('while-closed'); // Duplicate accepted fact must not end creation.
    expect(onApplied).not.toHaveBeenCalled();
    publish('new-commit');
    expect(onApplied).toHaveBeenCalledTimes(1);
    publish('next-commit');
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('does not navigate for another app/root/generation or after the active context switches', () => {
    const onApplied = vi.fn();
    act(() => root.render(<Probe open onApplied={onApplied} />));
    publish('other-app', { ...context, appInstanceId: 'other-app' });
    publish('other-root', { ...context, dataRootFingerprint: 'other-root' });
    publish('old-generation', { ...context, connectionGeneration: 0 });
    expect(onApplied).not.toHaveBeenCalled();
    state = { ...state, activeContextId: 'remote' };
    publish('wrong-active-context');
    expect(onApplied).not.toHaveBeenCalled();
  });
});
