import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { setOpenCodeRuntimeActiveRunManifest } from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TeamProvisioningLaunchStateStoreBoundary } from '@main/services/team/provisioning/TeamProvisioningLaunchStateStoreBoundary';
import { createDefaultOpenCodeRuntimeBootstrapEvidencePorts } from '@main/services/team/provisioning/TeamProvisioningOpenCodeBootstrapEvidence';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost,
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFromService,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryServiceHost,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';
import {
  createRememberOpenCodeRuntimePidFromBridgePortsFromService,
  rememberOpenCodeRuntimePidFromBridge,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimePidBridge';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenCodeRuntimeCheckinRun } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeCheckin';

const team = 'publication-callers';
const publicationRun = 'aggregate-run';
const laneRun = 'different-lane-run';
const lane = 'secondary:opencode:alice';
const before = '2026-09-09T00:00:00.000Z';
const after = '2026-09-09T00:01:00.000Z';
const payload = {
  teamName: team,
  runId: laneRun,
  memberName: 'alice',
  runtimeSessionId: 'session-a',
  observedAt: after,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('real OpenCode liveness publication callers', () => {
  let temp: string;
  beforeEach(async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'opencode-publication-callers-'));
    setClaudeBasePathOverride(temp);
    await mkdir(path.join(getTeamsBasePath(), team), { recursive: true });
  });
  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await rm(temp, { recursive: true, force: true });
  });

  async function fixture(reopen: boolean) {
    let store = new TeamLaunchStateStore();
    await store.beginLaunch(team, publicationRun, ['alice'], () => true);
    await store.write(
      team,
      createPersistedLaunchSnapshot({
        teamName: team,
        expectedMembers: ['alice'],
        launchPhase: 'finished',
        members: {
          alice: {
            name: 'alice',
            providerId: 'opencode',
            laneOwnerProviderId: 'opencode',
            laneId: lane,
            laneKind: 'secondary',
            runtimeRunId: laneRun,
            runtimeSessionId: 'session-a',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            lastEvaluatedAt: before,
            lastHeartbeatAt: before,
          },
        },
      }),
      { runId: publicationRun }
    );
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: getTeamsBasePath(),
      teamName: team,
      laneId: lane,
      runId: laneRun,
    });
    if (reopen) store = new TeamLaunchStateStore();
    const events = vi.fn();
    const boundary = new TeamProvisioningLaunchStateStoreBoundary({
      launchStateStore: store,
      membersMetaStore: { getMembers: async () => [] },
      getTrackedRunId: () => (reopen ? null : publicationRun),
      applyOpenCodeSecondaryEvidenceOverlay: async ({ snapshot }) => snapshot,
      applyBootstrapStallOverlay: (snapshot) => snapshot,
      areSnapshotsSemanticallyEqual: () => false,
      clearBootstrapState: async () => {},
      invalidateRuntimeSnapshotCaches: vi.fn(),
      logDebug: vi.fn(),
      nowMs: Date.now,
    });
    const service = {
      launchStateStore: store,
      enqueueLaunchStateStoreOperation: boundary.enqueue.bind(boundary),
      writeLaunchStateSnapshot: boundary.writeLaunchStateSnapshot.bind(boundary),
      writeLaunchStateSnapshotNow: boundary.writeLaunchStateSnapshotNow.bind(boundary),
      withTeamLock: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      resolveOpenCodeRuntimeLaneId: async () => lane,
      openCodeRuntimeRecoveryIdentity: { resolveCurrentOpenCodeRuntimeRunId: async () => laneRun },
      membersMetaStore: { getMembers: async () => [] },
      readConfigForStrictDecision: async () => ({
        name: team,
        members: [{ name: 'alice', providerId: 'opencode' }],
      }),
      runTracking: {
        getTrackedRunId: () => (reopen ? null : publicationRun),
        resolveDeliverableTrackedRuntimeRunId: () => publicationRun,
        canDeliverToTrackedRuntimeRun: () => true,
      },
      runs: new Map(),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      teamChangeEmitter: events,
      createOpenCodeRuntimeBootstrapEvidencePorts: () =>
        createDefaultOpenCodeRuntimeBootstrapEvidencePorts({ teamsBasePath: getTeamsBasePath() }),
    };
    const host = createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryHostFromService(
      service as unknown as TeamProvisioningOpenCodeRuntimeDeliveryBoundaryServiceHost<OpenCodeRuntimeCheckinRun>
    );
    const delivery = createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost(host, {
      getTeamsBasePath,
      nowIso: () => after,
      logger: { warn: vi.fn() },
    });
    const pid = createRememberOpenCodeRuntimePidFromBridgePortsFromService(service, {
      nowIso: () => after,
      readProcessCommandByPid: () => 'opencode serve',
      isOpenCodeServeCommand: () => true,
      logDebug: vi.fn(),
    });
    return { store, boundary, delivery, pid, events, service };
  }

  it.each([false, true])(
    'persists heartbeat, duplicate check-in and PID with aggregate authority (reopen=%s)',
    async (reopen) => {
      const { store, delivery, pid } = await fixture(reopen);
      await expect(delivery.recordOpenCodeRuntimeHeartbeat(payload)).resolves.toMatchObject({
        state: 'accepted',
      });
      expect((await store.read(team))?.members.alice.lastHeartbeatAt).toBe(after);
      await expect(
        delivery.recordOpenCodeRuntimeBootstrapCheckin({
          ...payload,
          observedAt: '2026-09-09T00:02:00.000Z',
        })
      ).resolves.toMatchObject({ state: 'accepted' });
      expect((await store.read(team))?.members.alice.lastHeartbeatAt).toBe(
        '2026-09-09T00:02:00.000Z'
      );
      await rememberOpenCodeRuntimePidFromBridge(
        { ...payload, laneId: lane, runtimePid: 4242, reason: 'bridge' },
        pid
      );
      expect(await new TeamLaunchStateStore().read(team)).toMatchObject({
        publicationRunId: publicationRun,
        members: {
          alice: { runtimeRunId: laneRun, runtimePid: 4242, pidSource: 'opencode_bridge' },
        },
      });
    }
  );

  it('persists a first check-in through the real bootstrap evidence store after reopening', async () => {
    const { store, delivery } = await fixture(true);
    const previous = (await store.read(team))!;
    previous.members.alice.bootstrapConfirmed = false;
    delete previous.members.alice.runtimeSessionId;
    expect(await store.write(team, previous)).toBe(true);
    await expect(delivery.recordOpenCodeRuntimeBootstrapCheckin(payload)).resolves.toMatchObject({
      state: 'accepted',
    });
    expect(await new TeamLaunchStateStore().read(team)).toMatchObject({
      publicationRunId: publicationRun,
      members: {
        alice: {
          runtimeRunId: laneRun,
          runtimeSessionId: 'session-a',
          bootstrapConfirmed: true,
          lastHeartbeatAt: after,
        },
      },
    });
  });

  it('retains heartbeat admission while the outer mutation queue waits through Stop and successor Launch', async () => {
    const { store, delivery, boundary, service } = await fixture(true);
    const snapshot = (await store.read(team))!;
    const enqueued = deferred();
    service.enqueueLaunchStateStoreOperation = (name, operation) => {
      enqueued.resolve();
      return boundary.enqueue(name, operation);
    };
    const entered = deferred(),
      release = deferred();
    const held = boundary.enqueue(team, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const update = delivery.recordOpenCodeRuntimeHeartbeat(payload);
    const checked = expect(update).rejects.toThrow(/superseded|run|session/);
    await enqueued.promise;
    await store.markStopped(team);
    await store.beginLaunch(team, 'successor', ['alice'], () => true);
    expect(await store.write(team, snapshot, { runId: 'successor' })).toBe(true);
    release.resolve();
    await held;
    await checked;
    expect((await store.read(team))?.publicationRunId).toBe('successor');
  });

  it.each(['run', 'session'])(
    'rejects stale %s heartbeat/check-in/PID without changing publication',
    async (kind) => {
      const { store, delivery, pid, events } = await fixture(true);
      const stale = {
        ...payload,
        ...(kind === 'run' ? { runId: 'old-run' } : { runtimeSessionId: 'old-session' }),
      };
      const original = await store.read(team);
      await expect(delivery.recordOpenCodeRuntimeHeartbeat(stale)).rejects.toThrow();
      await expect(delivery.recordOpenCodeRuntimeBootstrapCheckin(stale)).rejects.toThrow();
      await rememberOpenCodeRuntimePidFromBridge(
        { ...stale, laneId: lane, runtimePid: 4242, reason: 'stale' },
        pid
      );
      expect(await store.read(team)).toEqual(original);
      expect(events).not.toHaveBeenCalled();
    }
  );

  it.each(['heartbeat', 'checkin', 'pid'])(
    'suppresses %s publication acknowledgement/events when Stop wins inside mutation',
    async (kind) => {
      const { store, delivery, pid, service, events } = await fixture(true);
      const entered = deferred(),
        release = deferred();
      const original = service.writeLaunchStateSnapshotNow;
      service.writeLaunchStateSnapshotNow = async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      };
      const update =
        kind === 'heartbeat'
          ? delivery.recordOpenCodeRuntimeHeartbeat(payload)
          : kind === 'checkin'
            ? delivery.recordOpenCodeRuntimeBootstrapCheckin(payload)
            : rememberOpenCodeRuntimePidFromBridge(
                { ...payload, laneId: lane, runtimePid: 4242, reason: 'late' },
                pid
              );
      const checked = kind === 'pid' ? update : expect(update).rejects.toThrow(/superseded/);
      await entered.promise;
      await store.markStopped(team);
      release.resolve();
      await checked;
      expect(await store.read(team)).toBeNull();
      expect(events).not.toHaveBeenCalled();
    }
  );
});
