import { promises as fs } from 'node:fs';
import path from 'node:path';

import { TeamProvisioningLaunchStateStoreBoundary } from '@main/services/team/provisioning/TeamProvisioningLaunchStateStoreBoundary';
import {
  buildOpenCodeRuntimePendingPermissionsLaunchSnapshot,
  createOpenCodeRuntimePendingPermissionsPersistencePortsFromService,
  type OpenCodeRuntimePermissionListingAdapter,
  persistOpenCodeRuntimePendingPermissions,
  syncOpenCodeRuntimePermissionsAfterDelivery,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimePermissions';
import { getTeamLaunchFreshnessPath } from '@main/services/team/TeamLaunchFreshness';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import {
  getTeamLaunchStatePath,
  TeamLaunchStateStore,
} from '@main/services/team/TeamLaunchStateStore';
import { describe, expect, it, vi } from 'vitest';

const teamName = 'permission-publication-regression';
const observedAt = '2026-09-09T00:00:00.000Z';
function previous(runId = 'run-1') {
  return {
    ...createPersistedLaunchSnapshot({
      teamName,
      expectedMembers: ['Builder'],
      launchPhase: 'active',
      updatedAt: observedAt,
      members: {
        Builder: {
          name: 'Builder',
          providerId: 'opencode',
          laneId: 'primary',
          runtimeRunId: runId,
          runtimeSessionId: 'session-1',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: observedAt,
        },
      },
    }),
    publicationRunId: runId,
  };
}
const permissionsByMember = new Map([
  [
    'Builder',
    [{ providerId: 'opencode' as const, requestId: 'permission-1', sessionId: 'session-1' }],
  ],
]);
function rebuild(snapshot = previous(), overrides = {}) {
  return buildOpenCodeRuntimePendingPermissionsLaunchSnapshot({
    previous: snapshot,
    runId: 'run-1',
    laneId: 'primary',
    sessionId: 'session-1',
    permissionsByMember,
    observedAt,
    ...overrides,
  });
}
async function harness() {
  const store = new TeamLaunchStateStore();
  await fs.mkdir(path.dirname(getTeamLaunchStatePath(teamName)), { recursive: true });
  expect(await store.beginLaunch(teamName, 'run-1', ['Builder'], () => true)).toBe(true);
  expect(await store.write(teamName, previous())).toBe(true);
  let tracked: string | null = 'run-1';
  let atOverlay = async () => {};
  const boundary = new TeamProvisioningLaunchStateStoreBoundary({
    launchStateStore: store,
    membersMetaStore: { getMembers: async () => [] },
    getTrackedRunId: () => tracked,
    applyOpenCodeSecondaryEvidenceOverlay: async ({ snapshot }) => {
      await atOverlay();
      return snapshot;
    },
    applyBootstrapStallOverlay: (snapshot) => snapshot,
    areSnapshotsSemanticallyEqual: () => false,
    clearBootstrapState: async () => {},
    invalidateRuntimeSnapshotCaches: vi.fn(),
    logDebug: vi.fn(),
    nowMs: () => Date.now(),
  });
  const ports = createOpenCodeRuntimePendingPermissionsPersistencePortsFromService(
    {
      enqueueLaunchStateStoreOperation: (team, op) => boundary.enqueue(team, op),
      writeLaunchStateSnapshotNow: (team, snapshot, ...options) =>
        boundary.writeLaunchStateSnapshotNow(team, snapshot, ...options),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      teamChangeEmitter: vi.fn(),
    },
    {
      nowIso: () => observedAt,
      getTrackedRunId: () => tracked,
      readLaunchState: (team) => store.read(team),
      logDebug: vi.fn(),
    }
  );
  ports.emitMemberSpawnChange = vi.fn();
  ports.invalidateRuntimeSnapshotCaches = vi.fn();
  return {
    store,
    ports,
    setTracked: (value: string | null) => {
      tracked = value;
    },
    setOverlay: (hook: () => Promise<void>) => {
      atOverlay = hook;
    },
    persist: () =>
      persistOpenCodeRuntimePendingPermissions(
        {
          teamName,
          runId: 'run-1',
          laneId: 'primary',
          sessionId: 'session-1',
          permissionsByMember,
          previousLaunchState: previous(),
        },
        ports
      ),
  };
}
describe('permission publication retains identity without acquiring launch authority', () => {
  it('rebuilds and persists current permissions under the existing publication identity', async () => {
    expect(rebuild()?.publicationRunId).toBe('run-1');
    const h = await harness();
    await h.persist();
    const stored = await new TeamLaunchStateStore().read(teamName);
    expect(stored?.publicationRunId).toBe('run-1');
    expect(stored?.members.Builder.pendingPermissionRequestIds).toEqual(['permission-1']);
  });
  it.each([
    { runId: 'old-run' },
    { laneId: 'secondary:opencode:Builder' },
    { sessionId: 'old-session' },
  ])('rejects mismatched member authority %j', (overrides) => {
    expect(rebuild(previous(), overrides)).toBeNull();
  });
  it('does not synthesize publication authority from the incoming runtime run', () => {
    const snapshot = previous();
    delete (snapshot as { publicationRunId?: string }).publicationRunId;
    expect(rebuild(snapshot)?.publicationRunId).toBeUndefined();
  });
  it.each(['run-2', null])(
    'rejects a permission write when tracking changes during the write to %s',
    async (tracked) => {
      const h = await harness();
      const before = await h.store.read(teamName);
      h.setOverlay(async () => {
        h.setTracked(tracked);
      });
      expect(await h.persist()).toBe(false);
      expect(await h.store.read(teamName)).toEqual(before);
      expect(h.ports.emitMemberSpawnChange).not.toHaveBeenCalled();
      expect(h.ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    }
  );
  it('does not overwrite a successor published after the permission read', async () => {
    const h = await harness();
    const successor = previous('run-2');
    h.setOverlay(async () => {
      h.setTracked('run-2');
      expect(await h.store.beginLaunch(teamName, 'run-2', ['Builder'], () => true)).toBe(true);
      expect(await h.store.write(teamName, successor)).toBe(true);
    });
    expect(await h.persist()).toBe(false);
    expect(h.ports.emitMemberSpawnChange).not.toHaveBeenCalled();
    expect(h.ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(getTeamLaunchStatePath(teamName), 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(successor))
    );
    expect(
      (await h.store.read(teamName))?.members.Builder.pendingPermissionRequestIds
    ).toBeUndefined();
  });
  it.each(['run-1', 'run-2'])(
    'does not resurrect permissions after Stop of %s during the write',
    async (stoppedRunId) => {
      const h = await harness();
      h.setOverlay(async () => {
        if (stoppedRunId === 'run-2')
          expect(await h.store.beginLaunch(teamName, stoppedRunId, ['Builder'], () => true)).toBe(
            true
          );
        await h.store.markStopped(teamName);
      });
      expect(await h.persist()).toBe(false);
      expect(h.ports.emitMemberSpawnChange).not.toHaveBeenCalled();
      expect(h.ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
      expect(await h.store.isStopped(teamName)).toBe(true);
      expect(await h.store.read(teamName)).toBeNull();
      expect(
        JSON.parse(await fs.readFile(getTeamLaunchFreshnessPath(teamName), 'utf8'))
      ).toMatchObject({ kind: 'stop', stoppedRunId });
    }
  );
});

describe('permission publication results and reopened observation', () => {
  it.each([false, { wrote: false }])('does not announce a rejected write %j', async (result) => {
    const h = await harness();
    h.ports.writeLaunchStateSnapshot = vi.fn(async () => result);
    expect(await h.persist()).toBe(false);
    expect(h.ports.emitMemberSpawnChange).not.toHaveBeenCalled();
    expect(h.ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
  });
  it('updates a reopened untracked launch using its persisted publication identity', async () => {
    const h = await harness();
    h.setTracked(null);
    expect(await h.persist()).toBe(true);
    expect(await new TeamLaunchStateStore().read(teamName)).toMatchObject({
      publicationRunId: 'run-1',
      members: { Builder: { pendingPermissionRequestIds: ['permission-1'] } },
    });
    expect(h.ports.emitMemberSpawnChange).toHaveBeenCalledOnce();
    expect(h.ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledOnce();
  });
  it('rejects a reopened observation when a successor becomes tracked during publication', async () => {
    const h = await harness();
    h.setTracked(null);
    const before = await h.store.read(teamName);
    h.setOverlay(async () => {
      h.setTracked('run-2');
    });
    expect(await h.persist()).toBe(false);
    expect(await h.store.read(teamName)).toEqual(before);
    expect(h.ports.emitMemberSpawnChange).not.toHaveBeenCalled();
    expect(h.ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
  });
  it('does not reinterpret tracking lost while queued as a reopened launch', async () => {
    const h = await harness();
    const enqueue = h.ports.enqueueLaunchStateStoreOperation;
    h.ports.enqueueLaunchStateStoreOperation = (team, operation) => {
      h.setTracked(null);
      return enqueue(team, operation);
    };
    expect(await h.persist()).toBe(false);
    expect(
      (await h.store.read(teamName))?.members.Builder.pendingPermissionRequestIds
    ).toBeUndefined();
    expect(h.ports.emitMemberSpawnChange).not.toHaveBeenCalled();
    expect(h.ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
  });
  it('keeps a reopened Stop final during permission observation', async () => {
    const h = await harness();
    h.setTracked(null);
    h.setOverlay(async () => {
      await h.store.markStopped(teamName);
    });
    expect(await h.persist()).toBe(false);
    expect(await h.store.read(teamName)).toBeNull();
    expect(await h.store.isStopped(teamName)).toBe(true);
    expect(h.ports.emitMemberSpawnChange).not.toHaveBeenCalled();
    expect(h.ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
  });
  it('does not sync member status or approvals after rejected persistence', async () => {
    const syncSpawnStatuses = vi.fn();
    const syncToolApprovals = vi.fn();
    const persistPendingPermissions = vi.fn(async () => false);
    await syncOpenCodeRuntimePermissionsAfterDelivery(
      {
        teamName,
        runId: 'run-1',
        laneId: 'primary',
        memberName: 'Builder',
        cwd: '/tmp/permission-publication-test',
        sessionId: 'session-1',
        responseState: 'permission_blocked',
      },
      {
        getTrackedRunId: () => 'run-1',
        getPermissionListingAdapter: () => ({
          listRuntimePermissions: async () => ({
            permissions: permissionsByMember.get('Builder')!,
            diagnostics: [],
          }),
        } as OpenCodeRuntimePermissionListingAdapter),
        readLaunchState: async () => previous(),
        getTrackedRun: () => null,
        getRuntimeAdapterRun: () => null,
        persistPendingPermissions,
        syncSpawnStatuses,
        syncToolApprovals,
        logWarning: vi.fn(),
      }
    );
    expect(persistPendingPermissions).toHaveBeenCalledOnce();
    expect(syncSpawnStatuses).not.toHaveBeenCalled();
    expect(syncToolApprovals).not.toHaveBeenCalled();
  });
});
