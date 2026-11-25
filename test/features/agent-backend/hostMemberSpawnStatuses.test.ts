import { describe, expect, it, vi } from 'vitest';

import { hostTeamRunId } from '../../../src/features/agent-backend/contracts/teamRunSelection';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { projectLaunchConfiguration } from '../../../src/features/agent-backend/main/adapters/output/projectLaunchConfiguration';
import { projectHostMemberSpawnStatuses } from '../../../src/features/agent-backend/renderer/createHostMemberSpawnStatuses';
import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { projectHostProvisioningProgress } from '../../../src/features/agent-backend/renderer/projectHostProvisioningProgress';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';
import { getLaunchJoinMilestonesFromMembers } from '../../../src/renderer/components/team/provisioningSteps';
import {
  projectIncomingMemberSpawnSnapshot,
  shouldAdoptSuccessorProvisioningRun,
} from '../../../src/renderer/store/team/teamRuntimeRunAdoption';
import { buildTeamProvisioningPresentation } from '../../../src/renderer/utils/teamProvisioningPresentation';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { BackendLaunchConfigurationView } from '../../../src/features/agent-backend/contracts/launch';
import type {
  AgentBackendApi,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts/operations';
import type { IncomingMemberSpawnProjectionState } from '../../../src/renderer/store/team/teamRuntimeRunAdoption';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { MemberSpawnStatusesSnapshot } from '../../../src/shared/types/team';

const observedAt = Date.parse('2026-10-27T19:00:05.000Z');
const handleId = 'TEST-original-owner';
const key = hostTeamSelectionKey(handleId);
const runId = hostTeamRunId(handleId, 'TEST-original-launch', 'TEST-original-roster');
function configuration(): BackendLaunchConfigurationView {
  const members = [
    { memberId: 'lead-id', label: 'custom-lead', role: 'lead' as const, selected: null },
    { memberId: 'codex-id', label: 'bob', role: 'member' as const, selected: null },
    { memberId: 'opencode-id', label: 'carol', role: 'member' as const, selected: null },
  ];
  return {
    members,
    launch: {
      launchId: 'TEST-original-launch',
      rosterRevision: 'TEST-original-roster',
      startedAtMs: observedAt - 5000,
      observedAtMs: observedAt,
      status: 'ready',
      ready: 3,
      expected: 3,
      retryCapability: 'same-binding-no-allocation-only',
      members: members.map((member) => ({
        memberId: member.memberId,
        generation: 'TEST-generation',
        attemptId: `TEST-${member.memberId}`,
        status: 'ready',
        nativeReady: true,
        usable: true,
        controlAvailable: true,
        noAllocation: false,
        reason: 'context-applied',
      })),
    },
  };
}
function fixture() {
  const view = configuration();
  let epoch = 0;
  const capture = () => {
    const original = epoch;
    return () => epoch === original;
  };
  const connections: BackendConnectionSnapshot = {
    state: 'ready',
    bindings: [{ handle: { handleId }, label: 'TEST owner', members: [] }],
  };
  const backend: AgentBackendApi = {
    getConnections: vi.fn(async () => structuredClone(connections)),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      expect(request.operation).toBe('team.launch.configuration.read');
      return { ok: true, value: structuredClone(view) };
    }),
  };
  const legacy = {
    getMemberSpawnStatuses: vi.fn(async () => ({ statuses: {}, runId: 'legacy-run' })),
  } as unknown as TeamsAPI;
  const readOrder = new TeamProductReadOrder();
  return {
    view,
    backend,
    connections,
    legacy,
    readOrder,
    api: createHostTeamsApi(legacy, backend, capture, readOrder),
    changeContext: () => {
      epoch++;
    },
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const joinMembers = (view: BackendLaunchConfigurationView) =>
  view.members.map((member) => ({
    name: member.label,
    agentType: member.role === 'lead' ? 'team-lead' : 'teammate',
  }));
function setMemberState(
  view: BackendLaunchConfigurationView,
  status: BackendLaunchConfigurationView['launch']['members'][number]['status']
) {
  Object.assign(view.launch.members[1]!, {
    status,
    usable: false,
    nativeReady: false,
    reason: 'TEST-current-reason',
  });
  view.launch.ready = 2;
  view.launch.status = 'partial';
}

describe('captured Host member spawn observations', () => {
  it('connects the existing facade and actual shared readiness presentation without native process claims', async () => {
    const f = fixture();
    // Exercise the actual Main allowlist projector before the renderer adapter.
    const projected = projectLaunchConfiguration({
      members: f.view.members,
      launch: {
        ...f.view.launch,
        members: f.view.launch.members.map(({ memberId, generation, ...attempt }) => ({
          memberId,
          binding: { memberId, generation },
          attempt,
        })),
      },
    });
    vi.mocked(f.backend.invoke).mockResolvedValueOnce({ ok: true, value: projected });
    const snapshot = await f.api.getMemberSpawnStatuses(key);
    expect(snapshot).toEqual({
      runId,
      expectedMembers: ['bob', 'carol'],
      updatedAt: '2026-10-27T19:00:05.000Z',
      statuses: {
        bob: {
          status: 'online',
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          updatedAt: '2026-10-27T19:00:05.000Z',
        },
        carol: {
          status: 'online',
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          updatedAt: '2026-10-27T19:00:05.000Z',
        },
      },
    });
    const members = joinMembers(projected);
    expect(
      getLaunchJoinMilestonesFromMembers({
        members,
        memberSpawnStatuses: snapshot.statuses,
        memberSpawnSnapshot: snapshot,
      })
    ).toMatchObject({
      expectedTeammateCount: 2,
      heartbeatConfirmedCount: 2,
      pendingSpawnCount: 0,
      failedSpawnCount: 0,
    });
    expect(
      buildTeamProvisioningPresentation({
        progress: projectHostProvisioningProgress(handleId, projected),
        members,
        memberSpawnStatuses: snapshot.statuses,
        memberSpawnSnapshot: snapshot,
      })
    ).toMatchObject({
      allTeammatesConfirmedAlive: true,
      pendingSpawnCount: 0,
      successMessage: 'Team launched - all 2 teammates joined',
    });
    expect(f.backend.getConnections).toHaveBeenCalledTimes(1);
    expect(f.backend.invoke).toHaveBeenCalledWith({
      handle: { handleId },
      commandId: expect.any(String),
      operation: 'team.launch.configuration.read',
      payload: {},
    });
    expect(f.legacy.getMemberSpawnStatuses).not.toHaveBeenCalled();
    expect(await f.api.getMemberSpawnStatuses('legacy-team')).toEqual({
      statuses: {},
      runId: 'legacy-run',
    });
    expect(vi.mocked(f.legacy.getMemberSpawnStatuses).mock.contexts[0]).toBe(f.legacy);
  });

  it.each(['not-started', 'pending-bootstrap', 'pending-human', 'unknown'] as const)(
    'keeps %s pending without offline or failure inference',
    async (status) => {
      const f = fixture();
      setMemberState(f.view, status);
      const snapshot = await f.api.getMemberSpawnStatuses(key);
      expect(snapshot.statuses.bob).toMatchObject({
        status: status === 'pending-bootstrap' ? 'spawning' : 'waiting',
        launchState:
          status === 'pending-human' ? 'runtime_pending_permission' : 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
      });
      expect(snapshot.statuses.bob).not.toHaveProperty('error');
      expect(snapshot.statuses.bob).not.toHaveProperty('hardFailure');
      if (status === 'unknown')
        expect(snapshot.statuses.bob).toMatchObject({
          runtimeDiagnosticSeverity: 'warning',
          runtimeDiagnostic: expect.stringContaining('unavailable'),
        });
      expect(
        getLaunchJoinMilestonesFromMembers({
          members: joinMembers(f.view),
          memberSpawnStatuses: snapshot.statuses,
          memberSpawnSnapshot: snapshot,
        })
      ).toMatchObject({
        expectedTeammateCount: 2,
        heartbeatConfirmedCount: 1,
        pendingSpawnCount: 1,
        failedSpawnCount: 0,
      });
    }
  );

  it('retains exact failed and intentionally skipped members instead of reducing the expected roster', async () => {
    const f = fixture();
    setMemberState(f.view, 'failed');
    Object.assign(f.view.launch.members[2]!, {
      status: 'skipped',
      usable: false,
      nativeReady: false,
      reason: 'launch-policy',
    });
    f.view.launch.ready = 1;
    const snapshot = await f.api.getMemberSpawnStatuses(key);
    expect(snapshot.expectedMembers).toEqual(['bob', 'carol']);
    expect(snapshot.statuses.bob).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      error: 'TEST-current-reason',
      hardFailureReason: 'TEST-current-reason',
    });
    expect(snapshot.statuses.carol).toMatchObject({
      status: 'skipped',
      launchState: 'skipped_for_launch',
      skippedForLaunch: true,
      skipReason: 'launch-policy',
    });
    expect(
      getLaunchJoinMilestonesFromMembers({
        members: joinMembers(f.view),
        memberSpawnStatuses: snapshot.statuses,
        memberSpawnSnapshot: snapshot,
      })
    ).toMatchObject({
      expectedTeammateCount: 2,
      heartbeatConfirmedCount: 0,
      pendingSpawnCount: 0,
      failedSpawnCount: 1,
      skippedSpawnCount: 1,
    });
  });

  it('uses the captured launch identity even when the caller mutates its connection object', async () => {
    const f = fixture(),
      wait = deferred<BackendOperationResult>();
    vi.mocked(f.backend.getConnections).mockResolvedValue(f.connections);
    vi.mocked(f.backend.invoke).mockReturnValueOnce(wait.promise);
    const pending = f.api.getMemberSpawnStatuses(key);
    await vi.waitFor(() => expect(f.backend.invoke).toHaveBeenCalledTimes(1));
    Object.assign(f.connections.bindings[0]!.handle, { handleId: 'replacement' });
    wait.resolve({ ok: true, value: f.view });
    expect((await pending).runId).toBe(runId);
    expect(vi.mocked(f.backend.invoke).mock.calls[0]![0].handle).toEqual({ handleId });
  });

  it('returns only an authoritative absent launch and refuses unavailable observations', async () => {
    const f = fixture();
    vi.mocked(f.backend.invoke).mockResolvedValueOnce({ ok: true, value: null });
    expect(await f.api.getMemberSpawnStatuses(key)).toEqual({ statuses: {}, runId: null });
    vi.mocked(f.backend.invoke).mockResolvedValueOnce({
      ok: false,
      code: 'unavailable',
      outcome: 'not-dispatched',
    });
    await expect(f.api.getMemberSpawnStatuses(key)).rejects.toThrow('unavailable');
    expect(f.legacy.getMemberSpawnStatuses).not.toHaveBeenCalled();
  });

  it.each([
    (view: BackendLaunchConfigurationView) => {
      view.members.pop();
    },
    (view: BackendLaunchConfigurationView) => {
      view.members[2]!.memberId = view.members[1]!.memberId;
    },
    (view: BackendLaunchConfigurationView) => {
      view.members[2]!.label = view.members[1]!.label;
    },
    (view: BackendLaunchConfigurationView) => {
      view.members[1]!.memberId = 'unmatched';
    },
    (view: BackendLaunchConfigurationView) => {
      view.launch.members[2]!.memberId = view.launch.members[1]!.memberId;
    },
    (view: BackendLaunchConfigurationView) => {
      view.launch.members[1]!.usable = false;
    },
    (view: BackendLaunchConfigurationView) => {
      view.launch.members[1]!.nativeReady = false;
    },
    (view: BackendLaunchConfigurationView) => {
      view.launch.members[1]!.generation = null;
    },
    (view: BackendLaunchConfigurationView) => {
      view.launch.ready = 0;
    },
    (view: BackendLaunchConfigurationView) => {
      delete view.launch.observedAtMs;
    },
    (view: BackendLaunchConfigurationView) => {
      view.launch.observedAtMs = -1;
    },
  ])('rejects missing, duplicate or contradictory source facts', (mutate) => {
    const view = configuration();
    mutate(view);
    expect(() => projectHostMemberSpawnStatuses(handleId, view)).toThrow();
  });

  it('rejects malformed, unavailable, removed and duplicate opaque connections before reading', async () => {
    const f = fixture();
    await expect(f.api.getMemberSpawnStatuses('host-team:%')).rejects.toThrow();
    f.connections.bindings = [];
    await expect(f.api.getMemberSpawnStatuses(key)).rejects.toThrow('unavailable');
    f.connections.bindings = [
      { handle: { handleId }, label: 'one', members: [] },
      { handle: { handleId }, label: 'duplicate', members: [] },
    ];
    await expect(f.api.getMemberSpawnStatuses(key)).rejects.toThrow('unavailable');
    f.connections.state = 'unconfigured';
    await expect(f.api.getMemberSpawnStatuses(key)).rejects.toThrow('unavailable');
    expect(f.backend.invoke).not.toHaveBeenCalled();
    expect(f.legacy.getMemberSpawnStatuses).not.toHaveBeenCalled();
  });

  it('rejects an older status response after a later read completes', async () => {
    const f = fixture(),
      wait = deferred<BackendOperationResult>();
    vi.mocked(f.backend.invoke).mockReturnValueOnce(wait.promise);
    const older = f.api.getMemberSpawnStatuses(key);
    const rejected = expect(older).rejects.toThrow('Stale');
    await vi.waitFor(() => expect(f.backend.invoke).toHaveBeenCalledTimes(1));
    expect((await f.api.getMemberSpawnStatuses(key)).runId).toBe(runId);
    wait.resolve({ ok: true, value: f.view });
    await rejected;
    expect(f.backend.getConnections).toHaveBeenCalledTimes(2);
  });

  it('rejects an older discovery response instead of recapturing after a newer read', async () => {
    const f = fixture(),
      wait = deferred<BackendConnectionSnapshot>();
    vi.mocked(f.backend.getConnections).mockReturnValueOnce(wait.promise);
    const older = f.api.getMemberSpawnStatuses(key);
    const rejected = expect(older).rejects.toThrow('Stale');
    await f.api.getMemberSpawnStatuses(key);
    wait.resolve(f.connections);
    await rejected;
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['mutation', 'new-launch-read', 'context'] as const)(
    'rejects late status after %s invalidates the original read',
    async (change) => {
      const f = fixture(),
        wait = deferred<BackendOperationResult>();
      vi.mocked(f.backend.invoke).mockReturnValueOnce(wait.promise);
      const pending = f.api.getMemberSpawnStatuses(key);
      const rejected = expect(pending).rejects.toThrow(
        change === 'context'
          ? 'context changed'
          : change === 'mutation'
            ? 'mutation boundary'
            : 'Stale'
      );
      await vi.waitFor(() => expect(f.backend.invoke).toHaveBeenCalledTimes(1));
      if (change === 'context') f.changeContext();
      else if (change === 'mutation') f.readOrder.invalidateReads(handleId);
      else f.readOrder.launchReadFence(handleId);
      wait.resolve({ ok: true, value: f.view });
      await rejected;
      expect(f.legacy.getMemberSpawnStatuses).not.toHaveBeenCalled();
    }
  );
});


describe('current Host live-roster snapshot handoff', () => {
  const pin = (snapshot: MemberSpawnStatusesSnapshot): IncomingMemberSpawnProjectionState => ({
    ignoredRuntimeRunIds: {},
    ignoredProvisioningRunIds: {},
    currentRuntimeRunIdByTeam: { [key]: snapshot.runId },
    leadActivityByTeam: { [key]: 'idle' },
    memberSpawnStatusesByTeam: { [key]: snapshot.statuses },
    memberSpawnSnapshotsByTeam: { [key]: snapshot },
  });
  const apply = (prev: IncomingMemberSpawnProjectionState, snapshot: MemberSpawnStatusesSnapshot) =>
    projectIncomingMemberSpawnSnapshot({
      teamName: key,
      prev,
      snapshot,
      onEqualSuppressed: vi.fn(),
    });

  it('accepts a fresh added member without stopping Bob and retires only the old exact tuple', async () => {
    const f = fixture(),
      member = f.view.members.pop()!,
      attempt = f.view.launch.members.pop()!;
    f.view.launch.expected = 2;
    f.view.launch.ready = 2;
    const original = await f.api.getMemberSpawnStatuses(key),
      previous = pin(original);
    f.view.members.push(member);
    f.view.launch.members.push(attempt);
    f.view.launch.expected = 3;
    f.view.launch.ready = 3;
    f.view.launch.rosterRevision = 'TEST-added-roster';
    const next = await f.api.getMemberSpawnStatuses(key),
      changed = apply(previous, next);
    expect(changed.currentRuntimeRunIdByTeam?.[key]).toBe(next.runId);
    expect(changed.ignoredRuntimeRunIds).toEqual({ [runId]: key });
    expect(changed.memberSpawnStatusesByTeam?.[key].bob).toEqual(original.statuses.bob);
    expect(
      buildTeamProvisioningPresentation({
        progress: projectHostProvisioningProgress(handleId, f.view),
        members: joinMembers(f.view),
        memberSpawnStatuses: changed.memberSpawnStatusesByTeam?.[key],
        memberSpawnSnapshot: changed.memberSpawnSnapshotsByTeam?.[key],
      })
    ).toMatchObject({
      allTeammatesConfirmedAlive: true,
      remainingJoinCount: 0,
      successMessage: 'Team launched - all 2 teammates joined',
    });
    expect(
      shouldAdoptSuccessorProvisioningRun({
        teamName: key,
        previousRunId: runId,
        previousState: 'assembling',
        nextRunId: next.runId,
        currentRuntimeRunId: changed.currentRuntimeRunIdByTeam?.[key],
        ignoredRuntimeRunIds: changed.ignoredRuntimeRunIds!,
        pinnedSpawnStatuses: changed.memberSpawnStatusesByTeam?.[key],
      })
    ).toBe(true);
    expect(apply({ ...previous, ...changed }, original)).toEqual({});
  });

  it('does not revive an unpinned R1 after a fresh R2 restore, even when the pinned members are offline', async () => {
    const f = fixture(),
      previous = pin(await f.api.getMemberSpawnStatuses(key));
    f.view.launch.rosterRevision = 'TEST-R1';
    const held = await f.api.getMemberSpawnStatuses(key);
    f.view.launch.rosterRevision = 'TEST-R2';
    Object.assign(f.view.launch.members[2]!, {
      generation: 'TEST-restored-generation',
      status: 'pending-bootstrap',
      usable: false,
      nativeReady: false,
    });
    f.view.launch.status = 'partial';
    f.view.launch.ready = 2;
    const fresh = await f.api.getMemberSpawnStatuses(key),
      changed = apply(previous, fresh);
    expect(changed.currentRuntimeRunIdByTeam?.[key]).toBe(fresh.runId);
    expect(changed.memberSpawnStatusesByTeam?.[key].carol.bootstrapConfirmed).toBe(false);
    const stopped = {
      ...previous,
      ...changed,
      memberSpawnStatusesByTeam: {
        [key]: { bob: { ...fresh.statuses.bob, status: 'offline' as const } },
      },
    };
    expect(apply(stopped, held)).toEqual({});
    expect(apply(stopped, structuredClone(held))).toEqual({});
    expect(
      shouldAdoptSuccessorProvisioningRun({
        teamName: key,
        previousRunId: runId,
        previousState: 'ready',
        nextRunId: held.runId,
        currentRuntimeRunId: fresh.runId,
        ignoredRuntimeRunIds: changed.ignoredRuntimeRunIds!,
        pinnedSpawnStatuses: stopped.memberSpawnStatusesByTeam[key],
      })
    ).toBe(false);
  });

  it.each(['context', 'mutation', 'new-launch-read'] as const)(
    'refuses an actual resolved snapshot invalidated by %s before store application',
    async (change) => {
      const f = fixture(),
        previous = pin(await f.api.getMemberSpawnStatuses(key));
      f.view.launch.rosterRevision = 'TEST-next';
      const next = await f.api.getMemberSpawnStatuses(key);
      if (change === 'context') f.changeContext();
      else if (change === 'mutation') f.readOrder.invalidateReads(handleId);
      else f.readOrder.launchReadFence(handleId);
      expect(apply(previous, next)).toEqual({});
    }
  );

  it.each(['clone', 'plain', 'other-launch', 'other-owner', 'changed-id'] as const)(
    'does not infer current same-launch provenance from %s',
    async (change) => {
      const f = fixture(),
        previous = pin(await f.api.getMemberSpawnStatuses(key));
      f.view.launch.rosterRevision = 'TEST-next';
      if (change === 'other-launch') f.view.launch.launchId = 'TEST-other-launch';
      let next = await f.api.getMemberSpawnStatuses(key);
      if (change === 'clone') next = structuredClone(next);
      if (change === 'plain') next = projectHostMemberSpawnStatuses(handleId, f.view);
      if (change === 'other-owner')
        previous.currentRuntimeRunIdByTeam[key] = hostTeamRunId(
          'TEST-other-owner',
          'TEST-original-launch',
          'TEST-original-roster'
        );
      if (change === 'changed-id')
        next.runId = hostTeamRunId(handleId, 'TEST-original-launch', 'TEST-forged');
      expect(apply(previous, next)).toEqual({});
    }
  );

  it.each(['ignoredRuntimeRunIds', 'ignoredProvisioningRunIds'] as const)(
    'preserves %s for both original and incoming exact tuples',
    async (map) => {
      const f = fixture(),
        previous = pin(await f.api.getMemberSpawnStatuses(key));
      f.view.launch.rosterRevision = 'TEST-next';
      const next = await f.api.getMemberSpawnStatuses(key);
      for (const ignored of [runId, next.runId!])
        expect(apply({ ...previous, [map]: { [ignored]: key } }, next)).toEqual({});
    }
  );
});
