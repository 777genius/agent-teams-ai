import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { QueueRoute, QueueScope } from '../../core/domain/queue';

export async function captureQueueNamespace(teamName: string): Promise<Omit<QueueScope, 'chat'>> {
  const epoch = captureContextScopedRequestEpoch();
  const state = useStore.getState();
  const contextId = state.activeContextId;
  if (state.isContextSwitching) throw new Error('rootUnavailable');
  const [root, ssh] = await Promise.all([
    api.config.getClaudeRootInfo(),
    contextId === 'local' ? Promise.resolve(null) : api.ssh.getState(),
  ]);
  if (
    !root.resolvedPath ||
    !isContextScopedRequestEpochCurrent(epoch) ||
    useStore.getState().activeContextId !== contextId ||
    useStore.getState().isContextSwitching ||
    (contextId !== 'local' &&
      (ssh?.state !== 'connected' ||
        !ssh.host ||
        contextId !== 'ssh-' + ssh.host ||
        state.connectedHost !== ssh.host ||
        useStore.getState().connectedHost !== ssh.host))
  )
    throw new Error('rootUnavailable');
  return {
    transport: 'desktop-local-teams-v1',
    root: root.resolvedPath,
    contextId,
    host: ssh?.host ?? null,
    teamName,
  };
}

export async function captureQueueScope(teamName: string, route: QueueRoute): Promise<QueueScope> {
  return {
    ...(await captureQueueNamespace(teamName)),
    chat: route.kind === 'direct' ? 'direct:' + route.participant : 'group:' + route.groupChatId,
  };
}
