import { api } from '@renderer/api';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { QueueRoute, QueueScope } from '../../core/domain/queue';

export interface QueueNamespaceAuthority {
  readonly activeContextId: string;
  readonly isContextSwitching: boolean;
  readonly connectedHost: string | null;
}

export async function captureQueueNamespace(
  teamName: string,
  getAuthority: () => QueueNamespaceAuthority
): Promise<Omit<QueueScope, 'chat'>> {
  const epoch = captureContextScopedRequestEpoch();
  const state = getAuthority();
  const contextId = state.activeContextId;
  if (state.isContextSwitching) throw new Error('rootUnavailable');
  const [root, ssh] = await Promise.all([
    api.config.getClaudeRootInfo(),
    contextId === 'local' ? Promise.resolve(null) : api.ssh.getState(),
  ]);
  const current = getAuthority();
  if (
    !root.resolvedPath ||
    !isContextScopedRequestEpochCurrent(epoch) ||
    current.activeContextId !== contextId ||
    current.isContextSwitching ||
    (contextId !== 'local' &&
      (ssh?.state !== 'connected' ||
        !ssh.host ||
        contextId !== 'ssh-' + ssh.host ||
        state.connectedHost !== ssh.host ||
        current.connectedHost !== ssh.host))
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

export async function captureQueueScope(
  teamName: string,
  route: QueueRoute,
  getAuthority: () => QueueNamespaceAuthority
): Promise<QueueScope> {
  return {
    ...(await captureQueueNamespace(teamName, getAuthority)),
    chat: route.kind === 'direct' ? 'direct:' + route.participant : 'group:' + route.groupChatId,
  };
}
