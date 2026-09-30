import type {
  HostedCreateTaskRegistry,
  HostedCreateTaskSession,
} from '@features/team-task-board/renderer/hosted';
import type { WorkspaceId } from '@shared/contracts/hosted';

export interface HostedCreateSessionAuthority {
  readonly workspaceId: WorkspaceId;
  readonly epoch: string;
}

export interface HostedCreateSessionRegistry extends HostedCreateTaskRegistry {
  reconcileAuthorities(authorities: readonly HostedCreateSessionAuthority[]): void;
  disposeAll(): void;
}

/** The authenticated shell owns sessions across keyed workspace mounts. */
export function createHostedCreateSessionRegistry(): HostedCreateSessionRegistry {
  const sessions = new Map<string, HostedCreateTaskSession>();
  return {
    getOrCreate(scope, create) {
      const key = JSON.stringify([scope.key, scope.authorityEpoch]);
      const existing = sessions.get(key);
      if (existing && existing.controller.getSnapshot().phase !== 'disposed') return existing;
      const session = create();
      sessions.set(key, session);
      return session;
    },
    reconcileAuthorities(authorities) {
      for (const [key, session] of sessions) {
        const current = authorities.find((authority) =>
          session.scope.key.startsWith(`${authority.workspaceId}:`)
        );
        if (current?.epoch === session.scope.authorityEpoch) continue;
        session.dispose();
        sessions.delete(key);
      }
    },
    disposeAll() {
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
    },
  };
}
