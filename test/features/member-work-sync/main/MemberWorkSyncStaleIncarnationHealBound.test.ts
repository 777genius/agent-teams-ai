import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { BackendSelectingMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/BackendSelectingMemberWorkSyncStore';
import {
  buildPendingReportIntentId,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import { snapshotToRecords } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { healStaleIncarnationStatuses } from '@features/member-work-sync/main/infrastructure/memberWorkSyncStaleIncarnationHeal';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { SqliteMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/SqliteMemberWorkSyncStore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';

// The heal is replaced by one that always claims success without changing anything, so the
// mismatch survives it. Preparation must still make exactly one attempt and then fail closed.
vi.mock(
  '@features/member-work-sync/main/infrastructure/memberWorkSyncStaleIncarnationHeal',
  () => ({
    healStaleIncarnationStatuses: vi.fn(async () => 'healed'),
  })
);

const roots: string[] = [];
const cores: InternalStorageWorkerCore[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const core of cores.splice(0)) core.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('stale-incarnation heal is attempted once per preparation', () => {
  it('does not loop when the mismatch survives the heal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mws-stale-heal-bound-'));
    roots.push(root);
    const paths = new MemberWorkSyncStorePaths(join(root, 'teams'));
    const core = new InternalStorageWorkerCore({
      databasePath: join(root, 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    cores.push(core);
    const gateway = new InProcessGateway(core);
    const json = new JsonMemberWorkSyncStore(paths);
    const store = new BackendSelectingMemberWorkSyncStore(
      new InternalStorageBackendSelector(() =>
        Promise.resolve({
          driver: 'better-sqlite3',
          databasePath: join(root, 'app.db'),
          schemaVersion: 4,
          integrity: 'ok',
        })
      ),
      new SqliteMemberWorkSyncStore({
        gateway,
        buildReportIntentId: buildPendingReportIntentId,
        importer: new MemberWorkSyncSqliteImporter({ gateway, jsonStore: json }),
      }),
      json,
      { gateway, paths, fallbackRequiresReplica: false }
    );
    await mkdir(paths.getTeamRootDir('sandbox'), { recursive: true });
    await writeFile(
      join(paths.getTeamRootDir('sandbox'), 'config.json'),
      JSON.stringify({ name: 'sandbox', _backupIdentityId: 'inc-1' })
    );
    const owner = { teamName: 'sandbox', memberName: 'alice' };
    await gateway.importTeam(
      'sandbox',
      snapshotToRecords('sandbox', {
        statuses: [
          {
            ...owner,
            state: 'needs_sync',
            evaluatedAt: '2020-01-01T00:00:00.000Z',
            diagnostics: [],
            agenda: {
              ...owner,
              generatedAt: '2020-01-01T00:00:00.000Z',
              fingerprint: 'f',
              items: [],
              diagnostics: [],
            },
            statusRevision: { incarnation: 'old-inc', lineageId: 'l', sequence: 1, nonce: 'n' },
          },
        ],
        reportIntents: [],
        outboxItems: [],
        metricEvents: [],
        filesToArchive: [],
      })
    );

    await expect(
      store.withPreparedBackend(
        { teamName: 'sandbox', incarnation: 'inc-1', mutation: false },
        async () => 'ran'
      )
    ).rejects.toMatchObject({ reason: 'incarnation_mismatch' });
    expect(healStaleIncarnationStatuses).toHaveBeenCalledTimes(1);
  });
});
