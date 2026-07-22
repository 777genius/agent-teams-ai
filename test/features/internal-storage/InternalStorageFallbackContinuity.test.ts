import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMENT_JOURNAL_STORE_ID,
  MEMBER_WORK_SYNC_STORE_ID,
  STALL_JOURNAL_STORE_ID,
} from '@features/internal-storage/contracts/internalStorageContracts';
import { ImportLegacyJsonStoreUseCase } from '@features/internal-storage/core/application/ImportLegacyJsonStoreUseCase';
import { KeyedMutex } from '@features/internal-storage/core/application/KeyedMutex';
import {
  areCommentJournalRecordSetsEquivalent,
  resolveCommentJournalRecordConflict,
} from '@features/internal-storage/main/adapters/output/commentJournalEntryRecordMapper';
import { CommentJournalLegacyJsonSource } from '@features/internal-storage/main/adapters/output/CommentJournalLegacyJsonSource';
import { SqliteTaskCommentNotificationJournalStore } from '@features/internal-storage/main/adapters/output/SqliteTaskCommentNotificationJournalStore';
import { SqliteTaskStallJournalStore } from '@features/internal-storage/main/adapters/output/SqliteTaskStallJournalStore';
import {
  areStallJournalRecordSetsEquivalent,
  resolveStallJournalRecordConflict,
} from '@features/internal-storage/main/adapters/output/stallJournalEntryRecordMapper';
import { StallJournalLegacyJsonSource } from '@features/internal-storage/main/adapters/output/StallJournalLegacyJsonSource';
import { BackendSelectingTaskCommentNotificationJournalStore } from '@features/internal-storage/main/composition/BackendSelectingTaskCommentNotificationJournalStore';
import { BackendSelectingTaskStallJournalStore } from '@features/internal-storage/main/composition/BackendSelectingTaskStallJournalStore';
import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageJsonReplica } from '@features/internal-storage/main/infrastructure/InternalStorageJsonReplica';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { BackendSelectingMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/BackendSelectingMemberWorkSyncStore';
import { MemberWorkSyncPendingReportIntentReplayer } from '@features/member-work-sync/core/application';
import {
  buildPendingReportIntentId,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import { reportIntentToRecord } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { SqliteMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/SqliteMemberWorkSyncStore';
import {
  getCommentNotificationJournalPath,
  JsonTaskCommentNotificationJournalStore,
} from '@main/services/team/JsonTaskCommentNotificationJournalStore';
import {
  getStallMonitorJournalPath,
  JsonTaskStallJournalStore,
} from '@main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import Database from 'better-sqlite3-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InProcessGateway } from './helpers/InProcessGateway';

import type { MemberWorkSyncStorageGateway } from '@features/internal-storage/main';
import type {
  MemberWorkSyncNudgePayload,
  MemberWorkSyncReportIntent,
  MemberWorkSyncStatus,
} from '@features/member-work-sync/contracts';
import type { MemberWorkSyncUseCaseDeps } from '@features/member-work-sync/core/application';
import type { TaskStallJournalStore } from '@main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskCommentNotificationJournalStore } from '@main/services/team/TaskCommentNotificationJournalStore';

const TEAM = 'demo';
const T0 = '2026-07-22T00:00:00.000Z';
const T1 = '2026-07-22T00:01:00.000Z';
const T2 = '2026-07-22T00:02:00.000Z';

describe('internal storage SQLite -> JSON fallback -> SQLite continuity', () => {
  let root: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    for (const core of cores.splice(0)) {
      try {
        core.close();
      } catch {
        // already closed
      }
    }
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  async function setup(): Promise<{ databasePath: string; teamsBasePath: string }> {
    root = await mkdtemp(join(tmpdir(), 'internal-storage-fallback-continuity-'));
    setClaudeBasePathOverride(root);
    const teamsBasePath = getTeamsBasePath();
    await mkdir(join(teamsBasePath, TEAM), { recursive: true });
    return { databasePath: join(root, 'user-data', 'storage', 'app.db'), teamsBasePath };
  }

  function openGateway(databasePath: string): InProcessGateway {
    const core = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    cores.push(core);
    return new InProcessGateway(core);
  }

  function selector(
    kind: 'sqlite' | 'json',
    integrity: 'ok' | 'recovered' = 'ok'
  ): InternalStorageBackendSelector {
    return new InternalStorageBackendSelector(() =>
      kind === 'sqlite'
        ? Promise.resolve({
            driver: 'better-sqlite3',
            databasePath: 'test.db',
            schemaVersion: 4,
            integrity,
          })
        : Promise.reject(new Error('native module ABI mismatch'))
    );
  }

  function createMwsStore(input: {
    kind: 'sqlite' | 'json';
    gateway: MemberWorkSyncStorageGateway;
    teamsBasePath: string;
    fallbackRequiresReplica: boolean;
    integrity?: 'ok' | 'recovered';
  }): BackendSelectingMemberWorkSyncStore {
    const paths = new MemberWorkSyncStorePaths(input.teamsBasePath);
    const jsonStore = new JsonMemberWorkSyncStore(paths);
    const sqliteStore = new SqliteMemberWorkSyncStore({
      gateway: input.gateway,
      importer: new MemberWorkSyncSqliteImporter({ gateway: input.gateway, jsonStore }),
      buildReportIntentId: buildPendingReportIntentId,
    });
    return new BackendSelectingMemberWorkSyncStore(
      selector(input.kind, input.integrity),
      sqliteStore,
      jsonStore,
      {
        gateway: input.gateway,
        paths,
        fallbackRequiresReplica: input.fallbackRequiresReplica,
      }
    );
  }

  function createJournalStores(input: {
    kind: 'sqlite' | 'json';
    gateway: InProcessGateway;
    fallbackRequiresReplica: boolean;
  }): { stall: TaskStallJournalStore; comment: TaskCommentNotificationJournalStore } {
    const stallImporter = new ImportLegacyJsonStoreUseCase({
      storeId: STALL_JOURNAL_STORE_ID,
      source: new StallJournalLegacyJsonSource(),
      loadExisting: (teamName) => input.gateway.loadStallJournalEntries(teamName),
      replaceAll: (teamName, rows) => input.gateway.replaceStallJournalEntries(teamName, rows),
      recordIdentity: (row) => row.epochKey,
      resolveConflict: resolveStallJournalRecordConflict,
      areEquivalent: areStallJournalRecordSetsEquivalent,
      recordImport: (teamName, count) =>
        input.gateway.recordStoreImport(STALL_JOURNAL_STORE_ID, teamName, count),
      hasRecordedImport: (teamName) =>
        input.gateway.hasStoreImport(STALL_JOURNAL_STORE_ID, teamName),
    });
    const commentImporter = new ImportLegacyJsonStoreUseCase({
      storeId: COMMENT_JOURNAL_STORE_ID,
      source: new CommentJournalLegacyJsonSource(),
      loadExisting: (teamName) => input.gateway.loadCommentJournalEntries(teamName),
      replaceAll: (teamName, rows) => input.gateway.replaceCommentJournalEntries(teamName, rows),
      recordIdentity: (row) => row.key,
      resolveConflict: resolveCommentJournalRecordConflict,
      areEquivalent: areCommentJournalRecordSetsEquivalent,
      recordImport: (teamName, count) =>
        input.gateway.recordStoreImport(COMMENT_JOURNAL_STORE_ID, teamName, count),
      hasRecordedImport: (teamName) =>
        input.gateway.hasStoreImport(COMMENT_JOURNAL_STORE_ID, teamName),
    });
    return {
      stall: new BackendSelectingTaskStallJournalStore(
        selector(input.kind),
        new SqliteTaskStallJournalStore({
          gateway: input.gateway,
          importer: stallImporter,
          mutex: new KeyedMutex(),
        }),
        new JsonTaskStallJournalStore(),
        { fallbackRequiresReplica: input.fallbackRequiresReplica }
      ),
      comment: new BackendSelectingTaskCommentNotificationJournalStore(
        selector(input.kind),
        new SqliteTaskCommentNotificationJournalStore({
          gateway: input.gateway,
          importer: commentImporter,
          mutex: new KeyedMutex(),
        }),
        new JsonTaskCommentNotificationJournalStore(),
        { fallbackRequiresReplica: input.fallbackRequiresReplica }
      ),
    };
  }

  it('preserves delivered MWS state and imports fallback-only updates without redelivery', async () => {
    const { databasePath, teamsBasePath } = await setup();
    const gatewayA = openGateway(databasePath);
    const sqlite = createMwsStore({
      kind: 'sqlite',
      gateway: gatewayA,
      teamsBasePath,
      fallbackRequiresReplica: false,
    });
    const payload: MemberWorkSyncNudgePayload = {
      from: 'system',
      to: 'bob',
      messageKind: 'member_work_sync_nudge',
      source: 'member-work-sync',
      actionMode: 'do',
      workSyncIntent: 'agenda_sync',
      text: 'continue',
      taskRefs: [],
    };
    await sqlite.ensurePending({
      id: 'nudge-1',
      teamName: TEAM,
      memberName: 'bob',
      agendaFingerprint: 'agenda-1',
      payloadHash: 'hash-1',
      payload,
      nowIso: T0,
    });
    const [claim] = await sqlite.claimDue({
      teamName: TEAM,
      claimedBy: 'dispatcher-a',
      nowIso: T1,
      limit: 1,
    });
    await sqlite.markDelivered({
      teamName: TEAM,
      id: 'nudge-1',
      attemptGeneration: claim.attemptGeneration,
      deliveredMessageId: 'message-1',
      nowIso: T1,
    });
    gatewayA.close();

    const json = createMwsStore({
      kind: 'json',
      gateway: gatewayA,
      teamsBasePath,
      fallbackRequiresReplica: true,
    });
    const replay = await json.ensurePending({
      id: 'nudge-1',
      teamName: TEAM,
      memberName: 'bob',
      agendaFingerprint: 'agenda-1',
      payloadHash: 'hash-1',
      payload,
      nowIso: T2,
    });
    expect(replay.ok && replay.item.status).toBe('delivered');
    expect(
      await json.claimDue({ teamName: TEAM, claimedBy: 'dispatcher-b', nowIso: T2, limit: 10 })
    ).toEqual([]);

    const fallbackStatus: MemberWorkSyncStatus = {
      teamName: TEAM,
      memberName: 'bob',
      state: 'caught_up',
      agenda: {
        teamName: TEAM,
        memberName: 'bob',
        generatedAt: T2,
        fingerprint: 'agenda-2',
        items: [],
        diagnostics: [],
      },
      evaluatedAt: T2,
      diagnostics: [],
    };
    await json.write(fallbackStatus);

    // Simulate a recovered/recreated primary: the new database must bootstrap
    // from the clean replica before consuming fallback JSON.
    const gatewayC = openGateway(`${databasePath}.recovered`);
    const sqliteAgain = createMwsStore({
      kind: 'sqlite',
      gateway: gatewayC,
      teamsBasePath,
      fallbackRequiresReplica: true,
    });
    await expect(sqliteAgain.read({ teamName: TEAM, memberName: 'bob' })).resolves.toMatchObject({
      state: 'caught_up',
      evaluatedAt: T2,
    });
    const persisted = await sqliteAgain.ensurePending({
      id: 'nudge-1',
      teamName: TEAM,
      memberName: 'bob',
      agendaFingerprint: 'agenda-1',
      payloadHash: 'hash-1',
      payload,
      nowIso: T2,
    });
    expect(persisted.ok && persisted.item.status).toBe('delivered');
  });

  it('normalizes a marked legacy alias through two SQLite replica sessions and replays its report', async () => {
    const { databasePath, teamsBasePath } = await setup();
    const gatewayA = openGateway(databasePath);
    const legacyAlias = TEAM.toUpperCase();
    const intent: MemberWorkSyncReportIntent = {
      id: 'legacy-intent',
      teamName: legacyAlias,
      memberName: 'bob',
      request: {
        teamName: legacyAlias,
        memberName: 'bob',
        state: 'caught_up',
        agendaFingerprint: 'agenda:v1:fixed',
        reportToken: 'legacy-token',
      },
      reason: 'control_api_unavailable',
      status: 'pending',
      recordedAt: T0,
    };
    await gatewayA.reportsAppend(reportIntentToRecord(intent));
    await gatewayA.recordStoreImport(MEMBER_WORK_SYNC_STORE_ID, TEAM, 1);

    const firstSession = createMwsStore({
      kind: 'sqlite',
      gateway: gatewayA,
      teamsBasePath,
      fallbackRequiresReplica: false,
    });
    await expect(firstSession.listPendingReports(TEAM)).resolves.toEqual([
      expect.objectContaining({
        id: intent.id,
        teamName: TEAM,
        request: expect.objectContaining({ teamName: TEAM }),
      }),
    ]);
    const replicaPath = new MemberWorkSyncStorePaths(teamsBasePath).getSqliteFallbackReplicaPath(
      TEAM
    );
    expect(JSON.parse(await readFile(replicaPath, 'utf8'))).toMatchObject({
      state: 'clean',
      snapshot: {
        reportIntents: [
          {
            teamName: TEAM,
            request: { teamName: TEAM },
          },
        ],
      },
    });
    gatewayA.close();

    const gatewayB = openGateway(`${databasePath}.second-session`);
    const secondSession = createMwsStore({
      kind: 'sqlite',
      gateway: gatewayB,
      teamsBasePath,
      fallbackRequiresReplica: true,
    });
    const replayedTeamNames: string[] = [];
    const replayDeps: MemberWorkSyncUseCaseDeps = {
      clock: { now: () => new Date(T2) },
      hash: { sha256Hex: () => 'fixed' },
      agendaSource: {
        loadAgenda: (input) => {
          replayedTeamNames.push(input.teamName);
          if (input.teamName !== TEAM) {
            return Promise.reject(new Error(`pending report replay used alias ${input.teamName}`));
          }
          return Promise.resolve({
            agenda: {
              teamName: TEAM,
              memberName: input.memberName,
              generatedAt: T2,
              items: [],
              diagnostics: [],
            },
            activeMemberNames: [input.memberName],
            inactive: false,
            diagnostics: [],
          });
        },
      },
      statusStore: secondSession,
      reportStore: secondSession,
      reportToken: {
        create: () => Promise.resolve({ token: 'fresh-token', expiresAt: T2 }),
        verify: () => Promise.resolve({ ok: true }),
      },
      lifecycle: {
        isTeamActive: () => true,
        isMemberActive: () => true,
      },
    };

    await expect(
      new MemberWorkSyncPendingReportIntentReplayer(replayDeps).replayTeam(TEAM)
    ).resolves.toEqual({ processed: 1, accepted: 1, rejected: 0, superseded: 0 });
    expect(replayedTeamNames).toEqual([TEAM]);
    await expect(secondSession.listPendingReports(TEAM)).resolves.toEqual([]);
    expect((await gatewayB.listTeamSnapshot(TEAM)).reportIntents).toEqual([
      expect.objectContaining({
        teamName: TEAM,
        id: intent.id,
        status: 'accepted',
      }),
    ]);
  });

  it('preserves alerted, sent, and initialized-empty journal state across forced fallback', async () => {
    const { databasePath } = await setup();
    const gatewayA = openGateway(databasePath);
    const first = createJournalStores({
      kind: 'sqlite',
      gateway: gatewayA,
      fallbackRequiresReplica: false,
    });
    await first.stall.update(TEAM, () => ({
      entries: [
        {
          epochKey: 'task-1:epoch-1',
          teamName: TEAM,
          taskId: 'task-1',
          branch: 'work',
          signal: 'turn_ended_after_touch',
          state: 'alerted',
          consecutiveScans: 3,
          createdAt: T0,
          updatedAt: T1,
          alertedAt: T1,
        },
      ],
      result: undefined,
    }));
    await first.stall.update(TEAM, (entries) => ({
      entries: entries.map((entry) => ({
        ...entry,
        state: 'suspected',
        consecutiveScans: 1,
        updatedAt: T2,
        alertedAt: undefined,
      })),
      result: undefined,
      changed: false,
    }));
    await first.comment.ensureInitialized(TEAM);
    await first.comment.withEntries(TEAM, (entries) => {
      entries.push({
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'bob',
        state: 'sent',
        messageId: 'message-1',
        createdAt: T0,
        updatedAt: T1,
        sentAt: T1,
      });
      return Promise.resolve({ result: undefined, changed: true });
    });
    await first.comment.ensureInitialized('empty-team');
    await expect(first.comment.exists('untouched-team')).resolves.toBe(false);
    gatewayA.close();

    const fallback = createJournalStores({
      kind: 'json',
      gateway: gatewayA,
      fallbackRequiresReplica: true,
    });
    const seenStall = await fallback.stall.update(TEAM, (entries) => ({
      entries,
      result: entries[0],
      changed: false,
    }));
    expect(seenStall).toMatchObject({ state: 'alerted', consecutiveScans: 3 });
    await expect(fallback.comment.read(TEAM)).resolves.toEqual([
      expect.objectContaining({ key: 'task-1:comment-1', state: 'sent' }),
    ]);
    await expect(fallback.comment.exists('empty-team')).resolves.toBe(true);
    await expect(fallback.comment.read('empty-team')).resolves.toEqual([]);
    await expect(fallback.comment.exists('untouched-team')).resolves.toBe(false);

    // Simulate stale fallback-side state. Returning to SQLite must not undo
    // irreversible alert/send evidence already committed by the primary.
    await fallback.stall.update(TEAM, (entries) => ({
      entries: entries.map((entry) => ({
        ...entry,
        state: 'suspected',
        consecutiveScans: 1,
        updatedAt: T2,
        alertedAt: undefined,
      })),
      result: undefined,
    }));
    await fallback.comment.withEntries(TEAM, (entries) => {
      const entry = entries[0];
      entries[0] = {
        ...entry,
        state: 'pending_send',
        updatedAt: T2,
        messageId: undefined,
        sentAt: undefined,
      };
      return Promise.resolve({ result: undefined, changed: true });
    });

    const gatewayC = openGateway(`${databasePath}.recovered`);
    const sqliteAgain = createJournalStores({
      kind: 'sqlite',
      gateway: gatewayC,
      fallbackRequiresReplica: true,
    });
    const persistedStall = await sqliteAgain.stall.update(TEAM, (entries) => ({
      entries,
      result: entries[0],
      changed: false,
    }));
    expect(persistedStall).toMatchObject({ state: 'alerted', consecutiveScans: 3 });
    await expect(sqliteAgain.comment.read(TEAM)).resolves.toEqual([
      expect.objectContaining({ key: 'task-1:comment-1', state: 'sent' }),
    ]);
    await expect(sqliteAgain.comment.exists('empty-team')).resolves.toBe(true);
  });

  it('allows a fresh store without a replica but fails closed after a dirty SQLite publication', async () => {
    const { databasePath, teamsBasePath } = await setup();
    const gateway = openGateway(databasePath);
    await gateway.ping();

    const freshFallback = createMwsStore({
      kind: 'json',
      gateway,
      teamsBasePath,
      fallbackRequiresReplica: false,
    });
    await expect(
      freshFallback.read({ teamName: 'fresh-team', memberName: 'bob' })
    ).resolves.toBeNull();

    const paths = new MemberWorkSyncStorePaths(teamsBasePath);
    const replica = new InternalStorageJsonReplica<never>(
      (teamName) => paths.getSqliteFallbackReplicaPath(teamName),
      (_value): _value is never => false
    );
    await replica.markDirty(TEAM);
    const unsafeFallback = createMwsStore({
      kind: 'json',
      gateway,
      teamsBasePath,
      fallbackRequiresReplica: false,
    });
    await expect(unsafeFallback.read({ teamName: TEAM, memberName: 'bob' })).rejects.toThrow(
      'last SQLite publication is dirty'
    );

    const primaryRecovery = createMwsStore({
      kind: 'sqlite',
      gateway,
      teamsBasePath,
      fallbackRequiresReplica: false,
    });
    await expect(primaryRecovery.read({ teamName: TEAM, memberName: 'bob' })).resolves.toBeNull();
    const safeFallbackAgain = createMwsStore({
      kind: 'json',
      gateway,
      teamsBasePath,
      fallbackRequiresReplica: false,
    });
    await expect(safeFallbackAgain.read({ teamName: TEAM, memberName: 'bob' })).resolves.toBeNull();

    await replica.markDirty(TEAM);
    const recoveredPrimary = createMwsStore({
      kind: 'sqlite',
      gateway,
      teamsBasePath,
      fallbackRequiresReplica: false,
      integrity: 'recovered',
    });
    await expect(recoveredPrimary.read({ teamName: TEAM, memberName: 'bob' })).rejects.toThrow(
      'last SQLite publication is dirty'
    );

    const invalidReplica = new InternalStorageJsonReplica<Record<string, unknown>>(
      (teamName) => paths.getSqliteFallbackReplicaPath(teamName),
      (value): value is Record<string, unknown> => Boolean(value && typeof value === 'object')
    );
    await invalidReplica.writeClean(TEAM, {
      statuses: [
        {
          teamName: 'other-team',
          memberName: 'bob',
          state: 'caught_up',
          evaluatedAt: T2,
          agenda: {},
        },
      ],
      reportIntents: [],
      outboxItems: [],
      metricEvents: [],
      filesToArchive: [],
    });
    const invalidFallback = createMwsStore({
      kind: 'json',
      gateway,
      teamsBasePath,
      fallbackRequiresReplica: false,
    });
    await expect(invalidFallback.read({ teamName: TEAM, memberName: 'bob' })).rejects.toThrow(
      'clean replica snapshot is invalid'
    );
  });

  it('marks journal replicas dirty before lazy SQLite preparation can mutate legacy state', async () => {
    await setup();
    const stallReplicaPath = `${getStallMonitorJournalPath(TEAM)}.sqlite-fallback-replica`;
    const commentReplicaPath = `${getCommentNotificationJournalPath(TEAM)}.sqlite-fallback-replica`;
    const stallReplica = new InternalStorageJsonReplica<{ entries: [] }>(
      () => stallReplicaPath,
      (value): value is { entries: [] } => Boolean(value && typeof value === 'object')
    );
    const commentReplica = new InternalStorageJsonReplica<{ initialized: true; entries: [] }>(
      () => commentReplicaPath,
      (value): value is { initialized: true; entries: [] } =>
        Boolean(value && typeof value === 'object')
    );
    await stallReplica.writeClean(TEAM, { entries: [] });
    await commentReplica.writeClean(TEAM, { initialized: true, entries: [] });

    let stallStateDuringPreparation: string | undefined;
    const failingStallStore: TaskStallJournalStore = {
      update: vi.fn(async () => {
        stallStateDuringPreparation = JSON.parse(await readFile(stallReplicaPath, 'utf8')).state;
        throw new Error('simulated stall importer crash');
      }),
    };
    const stall = new BackendSelectingTaskStallJournalStore(
      selector('sqlite'),
      failingStallStore,
      new JsonTaskStallJournalStore(),
      { fallbackRequiresReplica: false }
    );
    await expect(stall.update(TEAM, () => ({ entries: [], result: undefined }))).rejects.toThrow(
      'simulated stall importer crash'
    );
    expect(stallStateDuringPreparation).toBe('dirty');
    expect(JSON.parse(await readFile(stallReplicaPath, 'utf8'))).toMatchObject({ state: 'dirty' });

    let commentStateDuringPreparation: string | undefined;
    const failingCommentStore: TaskCommentNotificationJournalStore = {
      exists: vi.fn(() => Promise.resolve(false)),
      ensureInitialized: vi.fn(async () => {
        commentStateDuringPreparation = JSON.parse(
          await readFile(commentReplicaPath, 'utf8')
        ).state;
        throw new Error('simulated comment importer crash');
      }),
      read: vi.fn(() => Promise.resolve([])),
      withEntries: vi.fn(async (_teamName, mutate) => {
        const mutation = await mutate([]);
        return mutation.result;
      }),
    };
    const comment = new BackendSelectingTaskCommentNotificationJournalStore(
      selector('sqlite'),
      failingCommentStore,
      new JsonTaskCommentNotificationJournalStore(),
      { fallbackRequiresReplica: false }
    );
    await expect(comment.ensureInitialized(TEAM)).rejects.toThrow(
      'simulated comment importer crash'
    );
    expect(commentStateDuringPreparation).toBe('dirty');
    expect(JSON.parse(await readFile(commentReplicaPath, 'utf8'))).toMatchObject({
      state: 'dirty',
    });
  });
});
