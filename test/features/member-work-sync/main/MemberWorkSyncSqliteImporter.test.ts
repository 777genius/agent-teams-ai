import { MEMBER_WORK_SYNC_STORE_ID } from '@features/internal-storage/contracts/internalStorageContracts';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import { describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncTeamSnapshotRecords } from '@features/internal-storage/contracts/internalStorageContracts';
import type { MemberWorkSyncStorageGateway } from '@features/internal-storage/main';
import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
import type { MemberWorkSyncStoreSnapshot } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';

function makeStatus(
  memberName: string,
  state: MemberWorkSyncStatus['state'] = 'needs_sync'
): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName,
    state,
    agenda: {
      teamName: 'team-a',
      memberName,
      generatedAt: '2026-07-16T00:00:00.000Z',
      fingerprint: `agenda:${memberName}:${state}`,
      items: [],
      diagnostics: [],
    },
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: state === 'needs_sync',
      fingerprintChanged: false,
    },
    evaluatedAt: '2026-07-16T00:00:00.000Z',
    diagnostics: [],
  };
}

function snapshot(statuses: MemberWorkSyncStatus[]): MemberWorkSyncStoreSnapshot {
  return {
    statuses,
    reportIntents: [],
    outboxItems: [],
    metricEvents: [],
    filesToArchive: [],
  };
}

function emptyRecords(): MemberWorkSyncTeamSnapshotRecords {
  return { statuses: [], reportIntents: [], outboxItems: [], metricEvents: [] };
}

describe('MemberWorkSyncSqliteImporter archive recovery', () => {
  it('combines archived and live snapshot halves and keeps the durable replay marker', async () => {
    let canonical = emptyRecords();
    let imported = false;
    const gateway = {
      hasStoreImport: vi.fn(() => Promise.resolve(imported)),
      listTeamSnapshot: vi.fn(() => Promise.resolve(canonical)),
      importTeam: vi.fn((_teamName, next) => {
        canonical = next;
        return Promise.resolve();
      }),
      recordStoreImport: vi.fn((storeId) => {
        expect(storeId).toBe(MEMBER_WORK_SYNC_STORE_ID);
        imported = true;
        return Promise.resolve();
      }),
    } as unknown as MemberWorkSyncStorageGateway;
    const readActive = vi.fn(
      (): Promise<MemberWorkSyncStoreSnapshot | null> =>
        Promise.resolve(snapshot([makeStatus('bob', 'caught_up'), makeStatus('carol')]))
    );
    const readArchives = vi.fn(() =>
      Promise.resolve(snapshot([makeStatus('alice'), makeStatus('bob')]))
    );

    await new MemberWorkSyncSqliteImporter({
      gateway,
      jsonStore: {
        readSnapshotForImport: readActive,
        readArchivedSnapshotForImport: readArchives,
      },
    }).ensureImported('team-a');

    expect(canonical.statuses.map((record) => record.memberKey)).toEqual(['alice', 'bob', 'carol']);
    expect(
      JSON.parse(
        canonical.statuses.find((record) => record.memberKey === 'bob')?.statusJson ?? '{}'
      )
    ).toMatchObject({ state: 'caught_up' });
    expect(imported).toBe(true);

    const bob = canonical.statuses.find((record) => record.memberKey === 'bob');
    if (!bob) {
      throw new Error('expected bob status');
    }
    canonical = {
      ...canonical,
      statuses: canonical.statuses.map((record) =>
        record.memberKey === 'bob'
          ? { ...record, state: 'blocked', statusJson: JSON.stringify({ state: 'blocked' }) }
          : record
      ),
    };
    readActive.mockResolvedValueOnce(null);
    readArchives.mockClear();
    await new MemberWorkSyncSqliteImporter({
      gateway,
      jsonStore: {
        readSnapshotForImport: readActive,
        readArchivedSnapshotForImport: readArchives,
      },
    }).ensureImported('team-a');

    expect(readArchives).not.toHaveBeenCalled();
    expect(canonical.statuses.find((record) => record.memberKey === 'bob')).toMatchObject({
      state: 'blocked',
    });
  });

  it('recovers an archived-only snapshot when the durable import marker was lost', async () => {
    let canonical = emptyRecords();
    const gateway = {
      hasStoreImport: vi.fn(() => Promise.resolve(false)),
      listTeamSnapshot: vi.fn(() => Promise.resolve(canonical)),
      importTeam: vi.fn((_teamName, next) => {
        canonical = next;
        return Promise.resolve();
      }),
      recordStoreImport: vi.fn(() => Promise.resolve()),
    } as unknown as MemberWorkSyncStorageGateway;
    const readActive = vi.fn(() => Promise.resolve(null));
    const readArchives = vi.fn(() => Promise.resolve(snapshot([makeStatus('archived-only')])));

    await new MemberWorkSyncSqliteImporter({
      gateway,
      jsonStore: {
        readSnapshotForImport: readActive,
        readArchivedSnapshotForImport: readArchives,
      },
    }).ensureImported('team-a');

    expect(readActive).toHaveBeenCalledWith('team-a');
    expect(readArchives).toHaveBeenCalledWith('team-a');
    expect(canonical.statuses).toEqual([
      expect.objectContaining({ memberKey: 'archived-only', memberName: 'archived-only' }),
    ]);
    expect(gateway.recordStoreImport).toHaveBeenCalledWith(MEMBER_WORK_SYNC_STORE_ID, 'team-a', 1);
  });
});
