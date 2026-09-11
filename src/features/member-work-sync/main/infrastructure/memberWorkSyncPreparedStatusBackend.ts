import type { MemberWorkSyncStatus } from '../../contracts';
import type { JsonMemberWorkSyncStore } from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncJsonStatusSnapshot } from './memberWorkSyncJsonStatusPersistence';
import type {
  MemberWorkSyncAuthorityRawSnapshot,
  MemberWorkSyncPreparedStatusBackend,
} from './MemberWorkSyncStatusAuthority';
import type { SqliteMemberWorkSyncStore } from './SqliteMemberWorkSyncStore';

function routedStatus(status: MemberWorkSyncStatus, teamName: string): MemberWorkSyncStatus {
  return {
    ...status,
    teamName,
    agenda: { ...status.agenda, teamName },
    ...(status.report ? { report: { ...status.report, teamName } } : {}),
    ...(status.lastAcceptedReport
      ? { lastAcceptedReport: { ...status.lastAcceptedReport, teamName } }
      : {}),
  };
}

function jsonSnapshot(
  snapshot: MemberWorkSyncJsonStatusSnapshot
): MemberWorkSyncAuthorityRawSnapshot {
  if (snapshot.state === 'present')
    return { state: 'present', raw: snapshot.raw, payload: snapshot.payload };
  if (snapshot.state === 'absent') return { state: 'absent', raw: null };
  return snapshot.state === 'corrupt' ? { state: 'corrupt' } : { state: 'unavailable' };
}

function sqliteSnapshot(raw: string | null): MemberWorkSyncAuthorityRawSnapshot {
  if (raw === null) return { state: 'absent', raw: null };
  try {
    return { state: 'present', raw, payload: JSON.parse(raw) };
  } catch {
    return { state: 'corrupt' };
  }
}

/** Only the lifecycle/backend owner may expose this access after strict preflight and preparation. */
export function createJsonPreparedStatusBackend(
  teamName: string,
  store: Pick<
    JsonMemberWorkSyncStore,
    'readCanonicalStatusSnapshot' | 'compareAndWriteCanonicalStatus'
  >
): MemberWorkSyncPreparedStatusBackend {
  return {
    kind: 'json',
    read: async (memberName) =>
      jsonSnapshot(await store.readCanonicalStatusSnapshot({ teamName, memberName })),
    compareAndWrite: async (input) => {
      const result = await store.compareAndWriteCanonicalStatus({
        ...input,
        nextStatus: routedStatus(input.nextStatus, teamName),
      });
      if (result.committed === true) {
        // These bytes are the just-published envelope, not a later competing read.
        const envelope = JSON.parse(result.raw) as { status: unknown };
        return {
          committed: true,
          snapshot: { state: 'present', raw: result.raw, payload: envelope.status },
          projectionDegraded: result.projectionDegraded ? ['metrics'] : [],
        };
      }
      if (result.committed === false && result.reason === 'conflict') {
        return { committed: false, reason: 'conflict', current: jsonSnapshot(result.current) };
      }
      return result;
    },
  };
}

/** Does not call prepareCanonicalStatus: preparation belongs to the outer physical operation. */
export function createSqlitePreparedStatusBackend(
  teamName: string,
  store: Pick<
    SqliteMemberWorkSyncStore,
    'readCanonicalStatusRecord' | 'compareAndWriteCanonicalStatus'
  >
): MemberWorkSyncPreparedStatusBackend {
  return {
    kind: 'sqlite',
    read: async (memberName) =>
      sqliteSnapshot(
        (await store.readCanonicalStatusRecord({ teamName, memberName }))?.statusJson ?? null
      ),
    compareAndWrite: async (input) => {
      const result = await store.compareAndWriteCanonicalStatus({
        ...input,
        nextStatus: routedStatus(input.nextStatus, teamName),
      });
      return result.committed
        ? { committed: true, snapshot: sqliteSnapshot(result.record.statusJson) }
        : {
            committed: false,
            reason: 'conflict',
            current: sqliteSnapshot(result.current?.statusJson ?? null),
          };
    },
  };
}
