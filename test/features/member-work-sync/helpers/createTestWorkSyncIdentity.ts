import type { TeamWorkSyncIdentityAccess } from '@main/services/team/permanent-deletion/TeamWorkSyncIdentityAccess';

/** Test-only lifecycle seam; serialized callbacks model the owner's fence. */
export function createTestWorkSyncIdentity(
  incarnation = 'inc-a'
): Pick<TeamWorkSyncIdentityAccess, 'readCurrent' | 'adoptLegacy' | 'withCurrent'> {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    readCurrent: async () => ({ status: 'identified', identityId: incarnation }),
    adoptLegacy: async () => ({ status: 'identified', identityId: incarnation }),
    withCurrent: async (_team, expected, operation) => {
      const next = tail.then(async () =>
        expected === incarnation
          ? { current: true as const, value: await operation() }
          : {
              current: false as const,
              identity: { status: 'identified' as const, identityId: incarnation },
            }
      );
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
