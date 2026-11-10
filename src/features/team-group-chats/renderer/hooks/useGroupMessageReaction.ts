import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { GroupMessageReactionDTO, GroupMessageReactionTarget } from '../../contracts';

export function useGroupMessageReaction(target: GroupMessageReactionTarget) {
  const contextId = useStore((state) => state.activeContextId);
  const contextSwitching = useStore((state) => state.isContextSwitching);
  // Root reset invalidates the epoch before its store update, including local -> local.
  const epoch = useStore(() => captureContextScopedRequestEpoch());
  const { teamName, groupChatId, messageId } = target;
  const identity = JSON.stringify([contextId, teamName, groupChatId, messageId, epoch]);
  const session = useMemo(
    () => ({
      identity,
      contextSwitching,
      sequence: 0,
      mutation: false,
      refreshAfterMutation: false,
    }),
    [identity, contextSwitching]
  );
  const current = useRef(session);
  current.current = session;
  const [state, setState] = useState<{
    session: typeof session;
    snapshot: GroupMessageReactionDTO | null;
    pending: boolean;
    failed: boolean;
  }>({ session, snapshot: null, pending: false, failed: false });
  const isCurrent = useCallback(
    (requestEpoch: number, sequence: number) =>
      current.current === session &&
      session.sequence === sequence &&
      isContextScopedRequestEpochCurrent(requestEpoch) &&
      useStore.getState().activeContextId === contextId &&
      !useStore.getState().isContextSwitching,
    [contextId, session]
  );
  const refresh = useCallback(async () => {
    if (contextSwitching) return;
    if (session.mutation) {
      session.refreshAfterMutation = true;
      return;
    }
    const requestEpoch = captureContextScopedRequestEpoch();
    const sequence = ++session.sequence;
    if (requestEpoch !== epoch || !isCurrent(requestEpoch, sequence)) return;
    try {
      const snapshot = await api.teamGroupChats.getReaction({ teamName, groupChatId, messageId });
      if (isCurrent(requestEpoch, sequence))
        setState({ session, snapshot, pending: false, failed: false });
    } catch {
      if (isCurrent(requestEpoch, sequence))
        setState((previous) => ({
          session,
          snapshot: previous.session === session ? previous.snapshot : null,
          pending: false,
          failed: true,
        }));
    }
  }, [contextSwitching, epoch, groupChatId, isCurrent, messageId, session, teamName]);
  useEffect(() => {
    setState({ session, snapshot: null, pending: false, failed: false });
    void refresh();
    return () => {
      session.sequence += 1;
    };
  }, [refresh, session]);
  useEffect(
    () =>
      api.teams.onTeamChange?.((_event, change) => {
        if (
          change.teamName === teamName &&
          (change.type === 'config' ||
            (change.type === 'group-reactions' && change.detail === messageId))
        )
          void refresh();
      }),
    [messageId, refresh, teamName]
  );
  const toggle = useCallback(async () => {
    if (
      contextSwitching ||
      session.mutation ||
      state.session !== session ||
      !state.snapshot?.canReact
    )
      return;
    const requestEpoch = captureContextScopedRequestEpoch();
    const sequence = ++session.sequence;
    if (requestEpoch !== epoch || !isCurrent(requestEpoch, sequence)) return;
    session.mutation = true;
    setState((previous) => ({ ...previous, pending: true, failed: false }));
    try {
      const snapshot = await api.teamGroupChats.setReaction({
        teamName,
        groupChatId,
        messageId,
        active: !state.snapshot.hasUserReacted,
      });
      if (isCurrent(requestEpoch, sequence))
        setState({ session, snapshot, pending: true, failed: false });
    } catch {
      if (isCurrent(requestEpoch, sequence))
        setState((previous) => ({ ...previous, failed: true }));
    } finally {
      session.mutation = false;
      if (isCurrent(requestEpoch, sequence)) {
        setState((previous) => ({ ...previous, pending: false }));
        if (session.refreshAfterMutation) {
          session.refreshAfterMutation = false;
          void refresh();
        }
      }
    }
  }, [
    contextSwitching,
    epoch,
    groupChatId,
    isCurrent,
    messageId,
    refresh,
    session,
    state,
    teamName,
  ]);
  const visible = state.session === session && !contextSwitching;
  return {
    snapshot: visible ? state.snapshot : null,
    pending: visible && state.pending,
    failed: visible && state.failed,
    disabled: !visible || state.pending || !state.snapshot?.canReact,
    toggle,
  };
}
