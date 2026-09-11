import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import {
  buildPendingReportIntentId,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { SqliteMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/SqliteMemberWorkSyncStore';
import Database from 'better-sqlite3-node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';

import type { MemberWorkSyncReportJournalInput } from '@features/member-work-sync/core/application/MemberWorkSyncReportJournalPort';

const input: MemberWorkSyncReportJournalInput = {
  teamName: 'sandbox-sqlite-journal',
  memberName: 'tester',
  incarnation: 'inc-1',
  intentId: 'intent-1',
  requestDigest: 'digest-1',
  receivedAt: '2026-09-10T10:00:00.000Z',
  origin: 'online',
  request: {
    teamName: 'sandbox-sqlite-journal',
    memberName: 'tester',
    state: 'still_working',
    agendaFingerprint: 'agenda-1',
  },
};
const receipt = {
  intentId: input.intentId,
  incarnation: input.incarnation,
  requestDigest: input.requestDigest,
  acceptedAt: input.receivedAt,
  appliedStatusRevision: {
    incarnation: input.incarnation,
    lineageId: 'lineage-1',
    sequence: 1,
    nonce: 'nonce-1',
  },
};

describe('strict SQLite report journal', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function openJournal() {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-sqlite-journal-'));
    const paths = new MemberWorkSyncStorePaths(root);
    const jsonStore = new JsonMemberWorkSyncStore(paths);
    const core = new InternalStorageWorkerCore({
      databasePath: join(root, 'storage', 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    const gateway = new InProcessGateway(core);
    const store = new SqliteMemberWorkSyncStore({
      gateway,
      importer: new MemberWorkSyncSqliteImporter({ gateway, jsonStore }),
      buildReportIntentId: buildPendingReportIntentId,
    });
    cleanups.push(async () => {
      core.close();
      await rm(root, { recursive: true, force: true });
    });
    return { journal: store.createReportJournal(), store };
  }

  it('binds once, preserves first timestamp, and rejects another member for the same ID', async () => {
    const { journal } = await openJournal();
    expect((await journal.read(input)).state).toBe('absent');
    expect((await journal.ensure(input)).state).toBe('present');
    const retry = await journal.ensure({
      ...input,
      receivedAt: '2026-09-11T10:00:00.000Z',
      origin: 'fallback',
    });
    expect(retry.state === 'present' && retry.intent.journal?.firstRecordedAt).toBe(input.receivedAt);
    expect(
      (
        await journal.ensure({
          ...input,
          memberName: 'other',
          request: { ...input.request, memberName: 'other' },
        })
      ).state
    ).toBe('conflict');
    expect((await journal.read({ ...input, memberName: 'other' })).state).toBe('conflict');
  });

  it('transfers an immutable receipt and rejects digest collisions', async () => {
    const { journal } = await openJournal();
    expect((await journal.transfer({ ...input, receipt })).state).toBe('absent');
    await journal.ensure(input);
    expect(await journal.transfer({ ...input, receipt })).toMatchObject({
      state: 'present',
      intent: { status: 'accepted', resultCode: 'accepted', processedAt: receipt.acceptedAt },
    });
    expect((await journal.ensure({ ...input, requestDigest: 'other' })).state).toBe('conflict');
  });

  it('legacy append cannot steal a bound journal ID', async () => {
    const { journal, store } = await openJournal();
    const otherRequest = { ...input.request, memberName: 'other' };
    const stolenId = buildPendingReportIntentId(otherRequest);
    expect((await journal.ensure({ ...input, intentId: stolenId })).state).toBe('present');
    await expect(store.appendPendingReport(otherRequest, 'online')).rejects.toThrow(
      'Bound report intent requires strict journal API'
    );
  });
});
