import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useStore } from '@renderer/store';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGroupMessageReaction } from '../../../src/features/team-group-chats/renderer/hooks/useGroupMessageReaction';

import type { GroupMessageReactionDTO } from '../../../src/features/team-group-chats/contracts';
import type { TeamChangeEvent } from '@shared/types';

const ports = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), subscribe: vi.fn() }));
vi.mock('@renderer/api', () => ({
  api: {
    teamGroupChats: { getReaction: ports.get, setReaction: ports.set },
    teams: { onTeamChange: ports.subscribe },
  },
}));
vi.mock('@renderer/store', async () => {
  const { create } = await import('zustand');
  return { useStore: create(() => ({ activeContextId: 'local', isContextSwitching: false })) };
});
const target = {
  teamName: 'test-team',
  groupChatId: 'test-group',
  messageId: 'd49f3a9c-50a0-42e2-b8d3-632d7feb7f4c',
};
const snapshot = (actorNames: string[], canReact = true): GroupMessageReactionDTO => ({
  groupChatId: target.groupChatId,
  messageId: target.messageId,
  actorNames,
  canReact,
  hasUserReacted: actorNames.includes('user'),
});
function deferred() {
  let resolve!: (value: GroupMessageReactionDTO) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<GroupMessageReactionDTO>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let reaction: ReturnType<typeof useGroupMessageReaction>;
let change: (event: unknown, payload: TeamChangeEvent) => void;
let view: ReturnType<typeof createRoot>;
let unsubscribe: ReturnType<typeof vi.fn>;
function Probe() {
  reaction = useGroupMessageReaction(target);
  return null;
}
const notify = async (
  type: TeamChangeEvent['type'],
  detail?: string,
  teamName = target.teamName
) => {
  await act(async () => change(undefined, { type, detail, teamName }));
};
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  resetContextScopedRequestEpochForTests();
  useStore.setState({ activeContextId: 'local', isContextSwitching: false });
  unsubscribe = vi.fn();
  ports.subscribe.mockImplementation((listener) => {
    change = listener;
    return unsubscribe;
  });
  ports.get.mockResolvedValue(snapshot(['alice']));
  view = createRoot(document.createElement('div'));
  await act(async () => view.render(<Probe />));
});
afterEach(() => {
  act(() => view.unmount());
  expect(unsubscribe).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('canonical reaction target request lifetime', () => {
  it('ignores unrelated events and older reads, preserves failed mutations, and disables archive writes', async () => {
    await notify('inbox');
    await notify('group-reactions', 'another-message');
    await notify('group-reactions', target.messageId, 'another-team');
    expect(ports.get).toHaveBeenCalledTimes(1);
    const older = deferred();
    ports.get.mockReturnValueOnce(older.promise).mockResolvedValueOnce(snapshot(['alice', 'bob']));
    await notify('group-reactions', target.messageId);
    await notify('group-reactions', target.messageId);
    await act(async () => older.resolve(snapshot(['obsolete'])));
    expect(reaction.snapshot?.actorNames).toEqual(['alice', 'bob']);
    const failed = deferred();
    ports.set.mockReturnValueOnce(failed.promise);
    await act(async () => {
      void reaction.toggle();
      void reaction.toggle();
    });
    expect(ports.set).toHaveBeenCalledTimes(1);
    expect(ports.set).toHaveBeenCalledWith({ ...target, active: true });
    expect(reaction.pending).toBe(true);
    await act(async () => failed.reject(new Error('write failed')));
    expect(reaction.snapshot?.actorNames).toEqual(['alice', 'bob']);
    expect(reaction.failed).toBe(true);
    expect(reaction.pending).toBe(false);
    ports.get.mockResolvedValueOnce(snapshot(['alice', 'bob'], false));
    await notify('config');
    await act(async () => reaction.toggle());
    expect(reaction.disabled).toBe(true);
    expect(ports.set).toHaveBeenCalledTimes(1);
  });

  it('rejects stale mutation success and finally after a local root change with the same context ID', async () => {
    const oldMutation = deferred();
    ports.set.mockReturnValueOnce(oldMutation.promise);
    await act(async () => {
      void reaction.toggle();
    });
    ports.get.mockResolvedValueOnce(snapshot(['new-root']));
    await act(async () => {
      invalidateContextScopedRequestEpoch();
      useStore.setState({ projects: [] });
    });
    expect(useStore.getState().activeContextId).toBe('local');
    expect(reaction.snapshot?.actorNames).toEqual(['new-root']);
    const newMutation = deferred();
    ports.set.mockReturnValueOnce(newMutation.promise);
    await act(async () => {
      void reaction.toggle();
    });
    await act(async () => oldMutation.resolve(snapshot(['alice', 'user'])));
    expect(reaction.snapshot?.actorNames).toEqual(['new-root']);
    expect(reaction.pending).toBe(true);
    expect(reaction.failed).toBe(false);
    await act(async () => newMutation.resolve(snapshot(['new-root', 'user'])));
    expect(reaction.snapshot?.hasUserReacted).toBe(true);
    expect(reaction.pending).toBe(false);
    ports.set.mockResolvedValueOnce(snapshot(['new-root']));
    await act(async () => reaction.toggle());
    expect(ports.set).toHaveBeenLastCalledWith({ ...target, active: false });
  });

  it('blocks an already captured click during context switching and ignores a stale read error', async () => {
    const staleRead = deferred();
    ports.get.mockReturnValueOnce(staleRead.promise);
    await notify('group-reactions', target.messageId);
    const capturedToggle = reaction.toggle;
    await act(async () => {
      useStore.setState({ isContextSwitching: true });
      await capturedToggle();
    });
    expect(ports.set).not.toHaveBeenCalled();
    expect(reaction.disabled).toBe(true);
    expect(reaction.snapshot).toBeNull();
    ports.get.mockResolvedValueOnce(snapshot(['current-context']));
    await act(async () => {
      invalidateContextScopedRequestEpoch();
      useStore.setState({ activeContextId: 'remote-test', isContextSwitching: false });
    });
    await act(async () => staleRead.reject(new Error('old root failed')));
    expect(reaction.snapshot?.actorNames).toEqual(['current-context']);
    expect(reaction.failed).toBe(false);
  });
});
