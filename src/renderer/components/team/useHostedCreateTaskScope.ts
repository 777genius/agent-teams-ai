import { useMemo } from 'react';

import { HostedCreateTaskSession } from '@features/team-task-board/renderer/hosted';

import type {
  HostedCreateTaskRegistry,
  HostedTaskBoardPageProps,
} from '@features/team-task-board/renderer/hosted';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

/** Standalone workspace mounts get a stable local registry; the Hosted shell supplies its longer lived owner. */
export function useHostedCreateTaskScope(
  workspaceId: WorkspaceId | undefined,
  teamId: TeamId | null,
  providedRegistry: HostedCreateTaskRegistry | undefined,
  authorityEpoch: string | undefined
): Readonly<{
  registry: HostedCreateTaskRegistry;
  scope: HostedTaskBoardPageProps['createScope'];
}> {
  const fallbackRegistry = useMemo<HostedCreateTaskRegistry>(() => {
    const sessions = new Map<string, HostedCreateTaskSession>();
    return {
      getOrCreate(scope, create) {
        const key = JSON.stringify([scope.key, scope.authorityEpoch]);
        const existing = sessions.get(key);
        if (existing) return existing;
        const session = create();
        sessions.set(key, session);
        return session;
      },
    };
  }, []);
  const scope = useMemo<HostedTaskBoardPageProps['createScope']>(
    () => ({
      key: `${workspaceId ?? 'standalone'}:${teamId ?? 'none'}`,
      authorityEpoch: authorityEpoch ?? 'local-session',
    }),
    [workspaceId, teamId, authorityEpoch]
  );
  return { registry: providedRegistry ?? fallbackRegistry, scope };
}
