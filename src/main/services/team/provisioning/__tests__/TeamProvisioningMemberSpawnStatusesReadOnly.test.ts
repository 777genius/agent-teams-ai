import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMemberSpawnStatusesSnapshot,
  type MemberSpawnStatusesSnapshotCacheEntry,
  type MemberSpawnStatusesSnapshotPorts,
  type MemberSpawnStatusRun,
} from '../TeamProvisioningMemberSpawnSnapshots';
import { getMemberSpawnStatusesSnapshotReadOnly } from '../TeamProvisioningMemberSpawnStatusesReadOnly';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

const TEAM = 'demo';
const RUN_ID = 'run-1';
const NOW_MS = Date.parse('2026-08-27T18:10:00.000Z');

function entry(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: false,
    hardFailure: false,
    updatedAt: '2026-08-27T18:08:00.000Z',
    firstSpawnAcceptedAt: '2026-08-27T18:08:00.000Z',
    ...overrides,
  };
}

function launchSnapshot(
  statuses: Record<string, MemberSpawnStatusEntry>
): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: TEAM,
    updatedAt: '2026-08-27T18:08:30.000Z',
    launchPhase: 'active',
    expectedMembers: Object.keys(statuses),
    members: statuses as unknown as PersistedTeamLaunchSnapshot['members'],
    summary: {} as PersistedTeamLaunchSnapshot['summary'],
    teamLaunchState: 'partial_pending',
  };
}

function createRun(
  statuses: Record<string, MemberSpawnStatusEntry>,
  overrides: Partial<MemberSpawnStatusRun> = {}
): MemberSpawnStatusRun & {
  lastMemberSpawnAuditAt: number;
} {
  return {
    runId: RUN_ID,
    teamName: TEAM,
    progress: {} as never,
    onProgress: vi.fn(),
    expectedMembers: Object.keys(statuses),
    isLaunch: true,
    provisioningComplete: false,
    lastMemberSpawnAuditAt: 0,
    memberSpawnStatuses: new Map(Object.entries(statuses)),
    ...overrides,
  };
}

interface Harness {
  ports: MemberSpawnStatusesSnapshotPorts<MemberSpawnStatusRun>;
  snapshotCache: Map<string, MemberSpawnStatusesSnapshotCacheEntry>;
  persistedWrites: string[];
}

/**
 * Every port that mutates run state, launch state, task activity or the shared
 * cache throws. A read-only projection that reaches one of them fails loudly
 * instead of silently regressing a live launch.
 */
function createHarness(options: {
  run?: MemberSpawnStatusRun;
  persisted?: PersistedTeamLaunchSnapshot | null;
  nowMs?: number;
  allowWrites?: boolean;
  /** Members the live liveness pass has runtime metadata for, and its verdict. */
  runtimeByMember?: Record<string, { alive: boolean }>;
}): Harness {
  const snapshotCache = new Map<string, MemberSpawnStatusesSnapshotCacheEntry>();
  const persistedWrites: string[] = [];
  const forbidden = (name: string) => {
    return (...args: unknown[]) => {
      if (!options.allowWrites) {
        throw new Error(`read-only snapshot must not call ${name}`);
      }
      persistedWrites.push(name);
      void args;
      return undefined;
    };
  };
  const ports: MemberSpawnStatusesSnapshotPorts<MemberSpawnStatusRun> = {
    getRun: (runId) => (options.run && runId === options.run.runId ? options.run : undefined),
    cache: {
      snapshotCache,
      inFlightByTeam: new Map(),
      getCacheGeneration: () => 0,
      getTrackedRunId: () => options.run?.runId ?? null,
      nowMs: () => options.nowMs ?? NOW_MS,
      liveCacheTtlMs: 1_000,
      persistedCacheTtlMs: 1_000,
    },
    persisted: {
      readTaskActivityRepairLaunchSnapshot: forbidden(
        'readTaskActivityRepairLaunchSnapshot'
      ) as never,
      repairStaleTaskActivityIntervalsOnce: forbidden(
        'repairStaleTaskActivityIntervalsOnce'
      ) as never,
      reconcilePersistedLaunchState: (async () => {
        if (!options.allowWrites) {
          throw new Error('read-only snapshot must not call reconcilePersistedLaunchState');
        }
        persistedWrites.push('reconcilePersistedLaunchState');
        return {
          snapshot: options.persisted ?? null,
          statuses: (options.persisted?.members ?? {}) as unknown as Record<
            string,
            MemberSpawnStatusEntry
          >,
        };
      }) as never,
      // Mirrors the real helper: only members the live pass has runtime metadata
      // for are rewritten, and every rewritten member is stamped with
      // `livenessLastCheckedAt`. The lead is never in that map.
      attachLiveRuntimeMetadataToStatuses: async (_teamName, statuses) =>
        Object.fromEntries(
          Object.entries(statuses).map(([memberName, value]) => {
            const metadata = options.runtimeByMember?.[memberName];
            return [
              memberName,
              metadata
                ? {
                    ...value,
                    runtimeAlive: metadata.alive,
                    livenessLastCheckedAt: new Date(options.nowMs ?? NOW_MS).toISOString(),
                  }
                : { ...value },
            ];
          })
        ),
      getOpenCodeSecondaryBootstrapPendingMemberNames: () => new Set<string>(),
      resumeActiveTaskActivityForMembers: forbidden('resumeActiveTaskActivityForMembers') as never,
    },
    live: {
      refreshMemberSpawnStatusesFromLeadInbox: (async () => {
        if (!options.allowWrites) {
          throw new Error(
            'read-only snapshot must not call refreshMemberSpawnStatusesFromLeadInbox'
          );
        }
        persistedWrites.push('refreshMemberSpawnStatusesFromLeadInbox');
      }) as never,
      maybeAuditMemberSpawnStatuses: (async (run: MemberSpawnStatusRun) => {
        if (!options.allowWrites) {
          throw new Error('read-only snapshot must not call maybeAuditMemberSpawnStatuses');
        }
        persistedWrites.push('maybeAuditMemberSpawnStatuses');
        (run as unknown as { lastMemberSpawnAuditAt: number }).lastMemberSpawnAuditAt = NOW_MS;
      }) as never,
      persistLaunchStateSnapshot: (async () => {
        if (!options.allowWrites) {
          throw new Error('read-only snapshot must not call persistLaunchStateSnapshot');
        }
        persistedWrites.push('persistLaunchStateSnapshot');
      }) as never,
      readLaunchState: async () =>
        options.persisted ? JSON.parse(JSON.stringify(options.persisted)) : null,
      syncRunMemberSpawnStatusesFromSnapshot: forbidden(
        'syncRunMemberSpawnStatusesFromSnapshot'
      ) as never,
      // Mirrors the real builder: a run that is not a launch (create-team) has
      // no live launch snapshot to project.
      buildLiveLaunchSnapshotForRun: (run) =>
        run.isLaunch && run.memberSpawnStatuses.size > 0
          ? launchSnapshot(Object.fromEntries(run.memberSpawnStatuses))
          : null,
      buildSnapshotFromRuntimeMemberStatuses: (input) => launchSnapshot(input.statuses),
      buildRuntimeSpawnStatusRecord: (run) => Object.fromEntries(run.memberSpawnStatuses),
      getMembersMeta: async () => [],
      filterRemovedMembersFromLaunchSnapshot: (snapshot) => snapshot,
      snapshotToMemberSpawnStatuses: (snapshot) =>
        Object.fromEntries(
          Object.entries(
            (snapshot?.members ?? {}) as unknown as Record<string, MemberSpawnStatusEntry>
          ).map(([memberName, value]) => [memberName, { ...value }])
        ),
      getPersistedLaunchMemberNames: (snapshot) => snapshot?.expectedMembers ?? [],
      deriveTeamLaunchAggregateState: (summary) =>
        summary.failedCount > 0 ? 'partial_failure' : 'partial_pending',
    },
    nowIso: () => new Date(NOW_MS).toISOString(),
  };
  return { ports, snapshotCache, persistedWrites };
}

describe('getMemberSpawnStatusesSnapshotReadOnly', () => {
  let statuses: Record<string, MemberSpawnStatusEntry>;

  beforeEach(() => {
    statuses = { 'team-lead': entry(), Worker: entry({ status: 'online' }) };
  });

  it('projects a tracked launch run without touching the run, launch state or cache', async () => {
    const run = createRun(statuses);
    const persisted = launchSnapshot(statuses);
    const harness = createHarness({ run, persisted });
    const runBefore = JSON.stringify([...run.memberSpawnStatuses.entries()]);
    const persistedBefore = JSON.stringify(persisted);

    const snapshot = await getMemberSpawnStatusesSnapshotReadOnly(TEAM, harness.ports);

    expect(snapshot).toMatchObject({ runId: RUN_ID, source: 'merged', launchPhase: 'active' });
    expect(Object.keys(snapshot.statuses)).toEqual(['team-lead', 'Worker']);
    expect(JSON.stringify([...run.memberSpawnStatuses.entries()])).toBe(runBefore);
    expect(run.lastMemberSpawnAuditAt).toBe(0);
    expect(JSON.stringify(persisted)).toBe(persistedBefore);
    expect(harness.snapshotCache.size).toBe(0);
    expect(harness.ports.cache.inFlightByTeam.size).toBe(0);
  });

  it('projects the persisted launch state when no run is tracked, still without writing', async () => {
    const persisted = launchSnapshot(statuses);
    const harness = createHarness({ persisted });

    const snapshot = await getMemberSpawnStatusesSnapshotReadOnly(TEAM, harness.ports);

    expect(snapshot).toMatchObject({ runId: null, source: 'persisted' });
    expect(Object.keys(snapshot.statuses)).toEqual(['team-lead', 'Worker']);
    expect(harness.snapshotCache.size).toBe(0);
  });

  it('serves a warm cache entry as a clone', async () => {
    const run = createRun(statuses);
    const harness = createHarness({ run, persisted: launchSnapshot(statuses) });
    const cached: MemberSpawnStatusesSnapshot = {
      statuses: { 'team-lead': entry({ status: 'online' }) },
      runId: RUN_ID,
      expectedMembers: ['team-lead'],
      source: 'live',
    };
    harness.snapshotCache.set(TEAM, {
      expiresAtMs: NOW_MS + 1_000,
      generation: 0,
      runId: RUN_ID,
      snapshot: cached,
    });

    const snapshot = await getMemberSpawnStatusesSnapshotReadOnly(TEAM, harness.ports);

    expect(snapshot).toEqual(cached);
    snapshot.statuses['team-lead'] = entry({ status: 'error' });
    expect(cached.statuses['team-lead']?.status).toBe('online');
  });

  it('returns an empty snapshot when there is neither a run nor persisted state', async () => {
    const harness = createHarness({ persisted: null });

    const snapshot = await getMemberSpawnStatusesSnapshotReadOnly(TEAM, harness.ports);

    expect(snapshot).toMatchObject({ statuses: {}, runId: null, expectedMembers: [] });
    expect(harness.snapshotCache.size).toBe(0);
  });

  it('reports a member past its launch grace as failed rather than waiting', async () => {
    const stale = {
      'team-lead': entry({
        runtimeAlive: false,
        firstSpawnAcceptedAt: new Date(NOW_MS - 10 * 60_000).toISOString(),
      }),
    };
    const harness = createHarness({ run: createRun(stale), persisted: launchSnapshot(stale) });

    const snapshot = await getMemberSpawnStatusesSnapshotReadOnly(TEAM, harness.ports);

    expect(snapshot.statuses['team-lead']).toMatchObject({
      status: 'error',
      hardFailure: true,
      launchState: 'failed_to_start',
    });
    expect(snapshot.teamLaunchState).toBe('partial_failure');
  });

  it('does not report a persisted member alive when the liveness pass never saw it', async () => {
    // launch-state.json keeps whatever the launch last wrote. The writing
    // reconcile is where `runtimeAlive = observedRuntimeAlive` demotes a member
    // with no live process; skipping it made GET /members/diagnostics report a
    // stopped team's lead as alive while the UI reported it dead.
    const withinGrace = new Date(NOW_MS - 30_000).toISOString();
    const persisted = launchSnapshot({
      'team-lead': entry({
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        livenessSource: 'heartbeat',
        livenessLastCheckedAt: '2026-08-27T18:08:30.000Z',
      }),
      Worker: entry({
        status: 'online',
        livenessSource: 'process',
        firstSpawnAcceptedAt: withinGrace,
      }),
    });
    const harness = createHarness({ persisted });

    const snapshot = await getMemberSpawnStatusesSnapshotReadOnly(TEAM, harness.ports);

    expect(snapshot.source).toBe('persisted');
    expect(snapshot.statuses['team-lead']).toMatchObject({
      runtimeAlive: false,
      launchState: 'confirmed_alive',
      // The persisted evaluation time survives: the projection only strips the
      // stamp to learn which members the live pass rewrote.
      livenessLastCheckedAt: '2026-08-27T18:08:30.000Z',
    });
    expect(snapshot.statuses.Worker).toMatchObject({
      runtimeAlive: false,
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
    });
    expect(snapshot.statuses.Worker?.livenessSource).toBeUndefined();
  });

  it('keeps the live verdict for the members the liveness pass did evaluate', async () => {
    const withinGrace = new Date(NOW_MS - 30_000).toISOString();
    const persisted = launchSnapshot({
      'team-lead': entry({ status: 'online', firstSpawnAcceptedAt: withinGrace }),
      Worker: entry({ status: 'online', firstSpawnAcceptedAt: withinGrace }),
      Scout: entry({ status: 'online', firstSpawnAcceptedAt: withinGrace }),
    });
    const harness = createHarness({
      persisted,
      runtimeByMember: { Worker: { alive: true }, Scout: { alive: false } },
    });

    const snapshot = await getMemberSpawnStatusesSnapshotReadOnly(TEAM, harness.ports);

    expect(snapshot.statuses.Worker).toMatchObject({ runtimeAlive: true, status: 'online' });
    expect(snapshot.statuses.Scout).toMatchObject({ runtimeAlive: false });
    expect(snapshot.statuses['team-lead']).toMatchObject({ runtimeAlive: false });
  });

  it('projects a tracked run with no live launch snapshot from its own member statuses', async () => {
    // A create-team run (`isLaunch: false`) builds no live launch snapshot. Without
    // the runtime-status fallback the route served the *previous* run's persisted
    // members stamped with the current run id.
    const run = createRun(
      { 'team-lead': entry({ status: 'online', runtimeAlive: true }) },
      { isLaunch: false }
    );
    const stalePersisted = launchSnapshot({
      'team-lead': entry({ status: 'error', launchState: 'failed_to_start', hardFailure: true }),
      Removed: entry({ status: 'offline' }),
    });
    const harness = createHarness({ run, persisted: stalePersisted });

    const snapshot = await getMemberSpawnStatusesSnapshotReadOnly(TEAM, harness.ports);

    expect(snapshot).toMatchObject({ runId: RUN_ID, source: 'merged' });
    expect(Object.keys(snapshot.statuses)).toEqual(['team-lead']);
    expect(snapshot.statuses['team-lead']).toMatchObject({ status: 'online', runtimeAlive: true });
  });

  it('projects the same member view as the writing variant for the same inputs', async () => {
    const readOnly = await getMemberSpawnStatusesSnapshotReadOnly(
      TEAM,
      createHarness({ run: createRun(statuses), persisted: launchSnapshot(statuses) }).ports
    );
    const writing = await getMemberSpawnStatusesSnapshot(
      TEAM,
      createHarness({
        run: createRun(statuses),
        persisted: launchSnapshot(statuses),
        allowWrites: true,
      }).ports
    );

    expect(Object.keys(readOnly).sort()).toEqual(Object.keys(writing).sort());
    expect(readOnly.statuses).toEqual(writing.statuses);
    expect(readOnly.expectedMembers).toEqual(writing.expectedMembers);
    expect(readOnly.source).toBe(writing.source);
    expect(readOnly.runId).toBe(writing.runId);
  });

  it('matches the writing variant for a tracked run that builds no live snapshot', async () => {
    // The persisted branch cannot be compared this way: the writing variant gets
    // its liveness from `reconcilePersistedLaunchState`, which this read-only
    // projection must never call (see the demotion test above).
    const persisted = launchSnapshot({ Removed: entry({ status: 'offline' }) });
    const readOnly = await getMemberSpawnStatusesSnapshotReadOnly(
      TEAM,
      createHarness({ run: createRun(statuses, { isLaunch: false }), persisted }).ports
    );
    const writing = await getMemberSpawnStatusesSnapshot(
      TEAM,
      createHarness({
        run: createRun(statuses, { isLaunch: false }),
        persisted,
        allowWrites: true,
      }).ports
    );

    expect(readOnly.statuses).toEqual(writing.statuses);
    expect(readOnly.expectedMembers).toEqual(writing.expectedMembers);
    expect(readOnly.source).toBe(writing.source);
    expect(readOnly.runId).toBe(writing.runId);
  });

  /**
   * The harness above proves a read-only projection reaches no mutating port
   * only if those ports would otherwise be reached. These two run the writing
   * variant through the same harness and assert exactly that: without them a
   * regression that made `getMemberSpawnStatusesSnapshot` write-free too would
   * leave every test above passing while proving nothing.
   */
  describe('the writing variant, through the same harness', () => {
    it('does refresh, audit, persist and fill the cache on the tracked-run branch', async () => {
      const harness = createHarness({
        run: createRun(statuses),
        persisted: launchSnapshot(statuses),
        allowWrites: true,
      });

      await getMemberSpawnStatusesSnapshot(TEAM, harness.ports);

      expect(harness.persistedWrites).toEqual(
        expect.arrayContaining([
          'refreshMemberSpawnStatusesFromLeadInbox',
          'maybeAuditMemberSpawnStatuses',
          'persistLaunchStateSnapshot',
        ])
      );
      expect(harness.snapshotCache.size).toBe(1);
    });

    it('does run the persisted launch reconcile when no run is tracked', async () => {
      const harness = createHarness({ persisted: launchSnapshot(statuses), allowWrites: true });

      await getMemberSpawnStatusesSnapshot(TEAM, harness.ports);

      expect(harness.persistedWrites).toContain('reconcilePersistedLaunchState');
    });
  });
});
