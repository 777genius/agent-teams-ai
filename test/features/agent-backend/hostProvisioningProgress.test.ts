import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hostTeamRunId,
  parseHostTeamRunId,
} from '../../../src/features/agent-backend/contracts/teamRunSelection';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { projectLaunchSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectLaunchSnapshot';
import { createHostTeamProvisioning } from '../../../src/features/agent-backend/renderer/createHostTeamProvisioning';
import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { shouldIgnoreProvisioningProgressRegression } from '../../../src/renderer/store/team/teamProvisioningStateRules';

import type { BackendLaunchConfigurationView } from '../../../src/features/agent-backend/contracts/launch';
import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendOperationResult,
  BackendRuntimeSnapshot,
} from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { TeamProvisioningProgress } from '../../../src/shared/types/team';

const start = Date.parse('2026-10-22T12:00:00.000Z');
function view(): BackendLaunchConfigurationView {
  return {
    launch: {
      launchId: 'run',
      rosterRevision: 'revision',
      startedAtMs: start,
      observedAtMs: start + 5000,
      status: 'ready',
      ready: 1,
      expected: 1,
      retryCapability: 'same-binding-no-allocation-only',
      members: [
        {
          memberId: 'lead',
          generation: 'generation-1',
          attemptId: 'initial',
          status: 'ready',
          nativeReady: true,
          usable: true,
          controlAvailable: true,
          noAllocation: false,
          reason: 'context-applied',
        },
      ],
    },
    members: [{ memberId: 'lead', label: 'captured-lead', role: 'lead', selected: null }],
  };
}
function runtime(): BackendRuntimeSnapshot {
  return {
    memberId: 'lead',
    generation: 'generation-1',
    phase: 'open-unknown',
    custody: 'unknown',
    attached: false,
    sealed: false,
    nativeReady: false,
    diagnostic: 'Readiness observation unavailable',
    inputs: [],
    interactions: [],
  };
}
function fixture() {
  const configuration = view();
  let context = 'original';
  const capture = () => {
    const selected = context;
    return () => selected === context;
  };
  const backend: AgentBackendApi = {
    getConnections: vi.fn(async () => ({
      state: 'ready' as const,
      bindings: [{ handle: { handleId: 'owner-A' }, label: 'Team', members: [] }],
    })),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation === 'team.launch.configuration.read')
        return { ok: true, value: structuredClone(configuration) };
      if (request.operation === 'runtime.read') return { ok: true, value: runtime() };
      if (request.operation === 'runtime.stop')
        return {
          ok: true,
          value: {
            memberId: request.payload.memberId,
            generation: request.payload.expectedGeneration,
            phase: 'closed',
            custody: 'released',
            attached: false,
            sealed: true,
            nativeReady: false,
            inputs: [],
            interactions: [],
          },
        };
      throw new Error('Unexpected operation');
    }),
  };
  const legacy = {
    getProvisioningStatus: vi.fn(async () => ({ legacy: true })),
    getLaunchFailureDiagnostics: vi.fn(async () => ({ legacy: true })),
    cancelProvisioning: vi.fn(),
    other: vi.fn(),
  } as unknown as TeamsAPI;
  return {
    configuration,
    backend,
    legacy,
    control: createHostTeamProvisioning(backend, capture),
    teams: createHostTeamsApi(legacy, backend, capture),
    changeContext: () => {
      context = 'new';
    },
  };
}
const selectedRun = hostTeamRunId('owner-A', 'run', 'revision');

describe('existing Copy diagnostics API for Host launches', () => {
  it('copies real captured launch/runtime evidence with no legacy artifacts, native effects or secrets', async () => {
    const f = fixture();
    Object.assign(f.configuration.launch, { status: 'failed', ready: 0 });
    Object.assign(f.configuration.launch.members[0], {
      status: 'failed',
      reason: 'bootstrap-timeout',
      usable: false,
      nativeReady: false,
    });
    f.configuration.members[0].label = 'captured-lead Authorization: Bearer launch-secret';
    Object.assign(f.configuration.members[0], { selected: { privateConfig: 'must-not-copy' } });
    const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
    vi.mocked(f.backend.invoke).mockImplementation(async (request) =>
      request.operation === 'runtime.read'
        ? {
            ok: true,
            value: { ...runtime(), diagnostic: 'OPENAI_API_KEY=runtime-secret unavailable' },
          }
        : invoke(request)
    );
    const result = await f.teams.getLaunchFailureDiagnostics(
      hostTeamSelectionKey('owner-A'),
      selectedRun
    );
    expect(result).toMatchObject({ source: 'captured-host', runId: selectedRun, files: [] });
    expect(result).not.toHaveProperty('latestPath');
    expect(result).not.toHaveProperty('classification');
    expect(result).not.toHaveProperty('bootstrapTransportBreadcrumb');
    expect(result.observations).toHaveLength(2);
    expect(JSON.parse(result.observations![0].content!)).toMatchObject({
      launchId: 'run',
      rosterRevision: 'revision',
      startedAtMs: start,
      observedAtMs: start + 5000,
      status: 'failed',
      members: [{ memberId: 'lead', generation: 'generation-1', reason: 'bootstrap-timeout' }],
    });
    expect(JSON.parse(result.observations![1].content!)).toMatchObject({
      memberId: 'lead',
      generation: 'generation-1',
      phase: 'open-unknown',
      custody: 'unknown',
      nativeReady: false,
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of ['launch-secret', 'runtime-secret', 'must-not-copy'])
      expect(serialized).not.toContain(privateValue);
    expect(
      vi.mocked(f.backend.invoke).mock.calls.map(([request]) => ({
        operation: request.operation,
        handle: request.handle,
        payload: request.payload,
      }))
    ).toEqual([
      {
        operation: 'team.launch.configuration.read',
        handle: { handleId: 'owner-A' },
        payload: { launchId: 'run' },
      },
      {
        operation: 'runtime.read',
        handle: { handleId: 'owner-A' },
        payload: { memberId: 'lead', expectedGeneration: 'generation-1' },
      },
      {
        operation: 'team.launch.configuration.read',
        handle: { handleId: 'owner-A' },
        payload: { launchId: 'run' },
      },
    ]);
    expect(f.legacy.getLaunchFailureDiagnostics).not.toHaveBeenCalled();
    expect(await f.teams.getLaunchFailureDiagnostics('legacy-team', 'legacy-run')).toEqual({
      legacy: true,
    });
    expect(vi.mocked(f.legacy.getLaunchFailureDiagnostics).mock.contexts[0]).toBe(f.legacy);
  });

  it('resolves a logical project selection only to its exact captured execution run', async () => {
    const f = fixture();
    const logical = {
      handle: { handleId: 'logical' },
      label: 'Team',
      members: [],
      ownerResourceRef: 'owner',
      teamResourceRef: 'logical-team',
      projectContextMode: 'per_project' as const,
    };
    const execution = {
      ...logical,
      handle: { handleId: 'owner-A' },
      teamResourceRef: 'execution-team',
      projectContext: {
        logicalHandleId: 'logical',
        projectPath: '/TEST-project',
        workContextId: 'work',
      },
    };
    vi.mocked(f.backend.getConnections).mockResolvedValue({
      state: 'ready',
      bindings: [
        logical,
        execution,
        {
          ...execution,
          handle: { handleId: 'other-project' },
          teamResourceRef: 'other-execution',
          projectContext: {
            ...execution.projectContext,
            projectPath: '/TEST-other',
            workContextId: 'other-work',
          },
        },
      ],
    });
    const result = await f.teams.getLaunchFailureDiagnostics(
      hostTeamSelectionKey('logical'),
      selectedRun
    );
    expect(result.teamName).toBe(hostTeamSelectionKey('logical'));
    expect(result.runId).toBe(selectedRun);
    expect(
      vi.mocked(f.backend.invoke).mock.calls.every(([r]) => r.handle.handleId === 'owner-A')
    ).toBe(true);
    vi.mocked(f.backend.invoke).mockClear();
    await expect(
      f.teams.getLaunchFailureDiagnostics(hostTeamSelectionKey('other-project'), selectedRun)
    ).rejects.toThrow('conflict');
    expect(f.backend.invoke).not.toHaveBeenCalled();
    expect(f.legacy.getLaunchFailureDiagnostics).not.toHaveBeenCalled();
  });

  it('refuses malformed, foreign and replaced run/roster selections without falling back to legacy', async () => {
    const f = fixture();
    for (const [team, run] of [
      [hostTeamSelectionKey('owner-A'), 'host-run:%'],
      ['legacy-team', selectedRun],
      [hostTeamSelectionKey('owner-B'), selectedRun],
      [hostTeamSelectionKey('owner-A'), hostTeamRunId('owner-B', 'run', 'revision')],
    ])
      await expect(f.teams.getLaunchFailureDiagnostics(team, run)).rejects.toThrow();
    expect(f.backend.invoke).not.toHaveBeenCalled();
    for (const run of [
      hostTeamRunId('owner-A', 'replaced', 'revision'),
      hostTeamRunId('owner-A', 'run', 'replaced'),
    ])
      await expect(
        f.teams.getLaunchFailureDiagnostics(hostTeamSelectionKey('owner-A'), run)
      ).rejects.toThrow('conflict');
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.every(([r]) => r.operation === 'team.launch.configuration.read')
    ).toBe(true);
    expect(f.legacy.getLaunchFailureDiagnostics).not.toHaveBeenCalled();
  });

  it('preserves partial runtime unavailability without disclosing a transport error body', async () => {
    for (const failure of ['finite', 'transport'] as const) {
      const f = fixture();
      const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
      vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
        if (request.operation !== 'runtime.read') return invoke(request);
        if (failure === 'transport')
          throw new Error('private transport OPENAI_API_KEY=runtime-secret');
        return { ok: false, code: 'hold', outcome: 'unknown' };
      });
      const result = await f.teams.getLaunchFailureDiagnostics(
        hostTeamSelectionKey('owner-A'),
        selectedRun
      );
      expect(result.observations).toHaveLength(2);
      expect(result.observations![0].content).toContain('"launchId": "run"');
      expect(result.observations![1]).toEqual({
        label: 'Runtime lead',
        issue: failure === 'finite' ? 'hold (unknown)' : 'Runtime observation unavailable',
      });
      expect(JSON.stringify(result)).not.toContain('private transport');
      expect(JSON.stringify(result)).not.toContain('runtime-secret');
    }
  });

  it('refuses runtime access rejection and a snapshot from another generation', async () => {
    for (const failure of ['forbidden', 'conflict', 'generation'] as const) {
      const f = fixture();
      const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
      vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
        if (request.operation !== 'runtime.read') return invoke(request);
        return failure === 'generation'
          ? { ok: true, value: { ...runtime(), generation: 'replacement' } }
          : { ok: false, code: failure, outcome: 'not-dispatched' };
      });
      await expect(
        f.teams.getLaunchFailureDiagnostics(hostTeamSelectionKey('owner-A'), selectedRun)
      ).rejects.toThrow(failure === 'generation' ? 'invalid-result' : failure);
    }
  });

  it('rejects a changed context, attempt, generation, roster or destination while copying', async () => {
    for (const change of [
      'context',
      'attemptId',
      'generation',
      'rosterRevision',
      'destination',
    ] as const) {
      const f = fixture();
      const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
      vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
        const result = await invoke(request);
        if (request.operation === 'runtime.read') {
          if (change === 'context') f.changeContext();
          else if (change === 'rosterRevision')
            f.configuration.launch.rosterRevision = 'replacement';
          else if (change === 'destination')
            vi.mocked(f.backend.getConnections).mockResolvedValue({ state: 'ready', bindings: [] });
          else f.configuration.launch.members[0][change] = 'replacement';
        }
        return result;
      });
      await expect(
        f.teams.getLaunchFailureDiagnostics(hostTeamSelectionKey('owner-A'), selectedRun)
      ).rejects.toThrow();
      expect(f.legacy.getLaunchFailureDiagnostics).not.toHaveBeenCalled();
    }
  });

  it('cannot publish pre-stop observations after a mutation but does not retire normal progress reads', async () => {
    const f = fixture();
    let resolve!: (result: BackendOperationResult) => void;
    const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
    vi.mocked(f.backend.invoke).mockImplementation((request) =>
      request.operation === 'runtime.read'
        ? new Promise((done) => {
            resolve = done;
          })
        : invoke(request)
    );
    const copy = f.teams.getLaunchFailureDiagnostics(hostTeamSelectionKey('owner-A'), selectedRun);
    const rejected = expect(copy).rejects.toThrow('mutation boundary');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect((await f.teams.getProvisioningStatus(selectedRun)).state).toBe('ready');
    await f.teams.cancelProvisioning(selectedRun);
    resolve({ ok: true, value: runtime() });
    await rejected;

    const other = fixture();
    vi.mocked(other.backend.invoke).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const progress = other.teams.getProvisioningStatus(selectedRun);
    await vi.waitFor(() => expect(other.backend.invoke).toHaveBeenCalledTimes(1));
    expect(
      (await other.teams.getLaunchFailureDiagnostics(hostTeamSelectionKey('owner-A'))).source
    ).toBe('captured-host');
    resolve({ ok: true, value: view() });
    expect((await progress).state).toBe('ready');
  });
});

describe('existing Host provisioning status API', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it('uses owner-qualified run IDs and original source timestamps, preserving legacy receivers', async () => {
    const f = fixture();
    const progress = await f.teams.getProvisioningStatus(selectedRun);
    expect(progress).toMatchObject({
      runId: selectedRun,
      teamName: hostTeamSelectionKey('owner-A'),
      state: 'ready',
      startedAt: '2026-10-22T12:00:00.000Z',
      updatedAt: '2026-10-22T12:00:05.000Z',
      configReady: true,
      launchDiagnostics: [{ memberName: 'captured-lead', code: 'bootstrap_confirmed' }],
    });
    expect(progress).not.toHaveProperty('pid');
    expect(progress).not.toHaveProperty('cliLogsTail');
    expect(f.legacy.getProvisioningStatus).not.toHaveBeenCalled();
    expect(await f.teams.getProvisioningStatus('legacy-run')).toEqual({ legacy: true });
    expect(vi.mocked(f.legacy.getProvisioningStatus).mock.contexts[0]).toBe(f.legacy);
    expect(vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request.operation)).toEqual([
      'team.launch.configuration.read',
    ]);
  });
  it('rejects noncanonical, malformed and removed selections without legacy fallback or effects', async () => {
    const f = fixture();
    for (const key of [
      'host-run:%',
      'host-run:[]',
      selectedRun.replace('%5B', '%5b'),
      hostTeamRunId('owner-B', 'run', 'revision'),
    ]) {
      await expect(f.teams.getProvisioningStatus(key)).rejects.toThrow();
      await expect(f.teams.cancelProvisioning(key)).rejects.toThrow();
    }
    expect(f.legacy.getProvisioningStatus).not.toHaveBeenCalled();
    expect(f.legacy.cancelProvisioning).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
    expect(parseHostTeamRunId(hostTeamRunId('owner:one', 'run/二', 'revision?'))).toEqual({
      handleId: 'owner:one',
      launchId: 'run/二',
      rosterRevision: 'revision?',
    });
  });
  it('does not read or cancel a replacement launch or roster', async () => {
    const f = fixture();
    for (const field of ['launchId', 'rosterRevision'] as const) {
      f.configuration.launch[field] += '-new';
      await expect(f.teams.getProvisioningStatus(selectedRun)).rejects.toThrow('selection changed');
      await expect(f.teams.cancelProvisioning(selectedRun)).rejects.toThrow('selection changed');
    }
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.every(([request]) => request.operation === 'team.launch.configuration.read')
    ).toBe(true);
    expect(f.legacy.cancelProvisioning).not.toHaveBeenCalled();
  });
  it('shows partial/human/unknown/failed/stopped states without declaring the whole Team ready', async () => {
    const f = fixture();
    const initial = await f.teams.getProvisioningStatus(selectedRun);
    expect(initial.state).toBe('ready');
    const member = f.configuration.launch.members[0];
    for (const [status, reason, state] of [
      ['pending-bootstrap', 'context-unconfirmed', 'assembling'],
      ['pending-human', 'human-decision', 'verifying'],
      ['unknown', 'custody-unresolved', 'disconnected'],
      ['failed', 'bootstrap-timeout', 'failed'],
      ['failed', 'stopped', 'disconnected'],
    ] as const) {
      Object.assign(member, { status, reason, nativeReady: false, usable: false });
      f.configuration.launch.status = status === 'failed' ? 'failed' : 'pending';
      f.configuration.launch.ready = 0;
      const progress = await f.teams.getProvisioningStatus(selectedRun);
      if (reason === 'stopped') {
        expect(progress.runId).toBe(initial.runId);
        expect(progress.startedAt).toBe(initial.startedAt);
        expect(shouldIgnoreProvisioningProgressRegression(initial.state, progress.state)).toBe(
          false
        );
      }
      expect(progress.state).toBe(state);
    }
    f.configuration.launch.members.push({ ...member, memberId: 'worker', status: 'unknown' });
    f.configuration.members.push({
      ...f.configuration.members[0],
      memberId: 'worker',
      label: 'worker',
      role: 'member',
    });
    f.configuration.launch.expected = 2;
    expect((await f.teams.getProvisioningStatus(selectedRun)).state).toBe('disconnected');
  });
  it('refuses a timestamp-free old capture instead of using renderer clock time', async () => {
    const f = fixture();
    delete f.configuration.launch.startedAtMs;
    delete f.configuration.launch.observedAtMs;
    await expect(f.teams.getProvisioningStatus(selectedRun)).rejects.toThrow('timestamps');
    Object.assign(f.configuration.launch, { startedAtMs: null, observedAtMs: start });
    await expect(f.teams.getProvisioningStatus(selectedRun)).rejects.toThrow('timestamps');
  });
  it('drops an older concurrent read and a late result after a context switch', async () => {
    const f = fixture();
    let resolve!: (result: BackendOperationResult) => void;
    vi.mocked(f.backend.invoke).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const first = f.control.getProvisioningStatus(selectedRun);
    const firstRejected = expect(first).rejects.toThrow('Stale');
    await vi.waitFor(() => expect(f.backend.invoke).toHaveBeenCalledTimes(1));
    expect((await f.control.getProvisioningStatus(selectedRun)).state).toBe('ready');
    resolve({ ok: true, value: view() });
    await firstRejected;
    vi.mocked(f.backend.invoke).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const next = f.control.getProvisioningStatus(selectedRun);
    const contextRejected = expect(next).rejects.toThrow('context changed');
    await vi.waitFor(() => expect(f.backend.invoke).toHaveBeenCalledTimes(3));
    f.changeContext();
    resolve({ ok: true, value: view() });
    await contextRejected;
  });
  it('cancels only the captured member generations and never rereads into a replacement', async () => {
    const f = fixture();
    let stopped: BackendOperationRequest | undefined;
    const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
    vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
      if (request.operation === 'runtime.stop') stopped = request;
      const result = await invoke(request);
      if (request.operation === 'team.launch.configuration.read') {
        f.configuration.launch.members[0].generation = 'replacement';
        f.configuration.launch.rosterRevision = 'replacement';
      }
      return result;
    });
    await f.teams.cancelProvisioning(selectedRun);
    expect(stopped).toMatchObject({
      handle: { handleId: 'owner-A' },
      operation: 'runtime.stop',
      payload: { memberId: 'lead', expectedGeneration: 'generation-1' },
    });
    expect(vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request.operation)).toEqual([
      'team.launch.configuration.read',
      'runtime.stop',
    ]);
    expect(f.legacy.cancelProvisioning).not.toHaveBeenCalled();
  });
  it('preserves unknown cancellation results and continues other originally captured members', async () => {
    const f = fixture();
    f.configuration.launch.members.push({
      ...f.configuration.launch.members[0],
      memberId: 'worker',
      generation: 'worker-1',
    });
    f.configuration.members.push({
      ...f.configuration.members[0],
      memberId: 'worker',
      label: 'worker',
      role: 'member',
    });
    f.configuration.launch.expected = 2;
    const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
    vi.mocked(f.backend.invoke).mockImplementation(async (request) =>
      request.operation === 'runtime.stop' && request.payload.memberId === 'lead'
        ? { ok: false, code: 'hold', outcome: 'unknown' }
        : invoke(request)
    );
    await expect(f.teams.cancelProvisioning(selectedRun)).rejects.toThrow();
    expect(
      vi.mocked(f.backend.invoke).mock.calls.filter(([r]) => r.operation === 'runtime.stop')
    ).toHaveLength(2);
    expect(f.legacy.cancelProvisioning).not.toHaveBeenCalled();
  });
  it('validates optional source timestamp pairs at the Main projection boundary', () => {
    const launch = view().launch;
    const raw = {
      ...launch,
      members: launch.members.map((m) => ({
        memberId: m.memberId,
        binding: { memberId: m.memberId, generation: m.generation },
        attempt: m,
      })),
    };
    expect(projectLaunchSnapshot(raw)).toMatchObject({
      startedAtMs: start,
      observedAtMs: start + 5000,
    });
    for (const patch of [
      { startedAtMs: -1 },
      { observedAtMs: Infinity },
      { observedAtMs: undefined },
      { startedAtMs: 'fake' },
    ])
      expect(() => projectLaunchSnapshot({ ...raw, ...patch })).toThrow();
    const { startedAtMs: _start, observedAtMs: _observed, ...old } = raw;
    expect(projectLaunchSnapshot(old)).not.toHaveProperty('observedAtMs');
  });

  it('shares the existing Team observer loop and deduplicates time-only progress for subscribers', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const stopLegacy = vi.fn();
    let legacyListener!: Parameters<TeamsAPI['onProvisioningProgress']>[0];
    f.legacy.onProvisioningProgress = function (callback) {
      expect(this).toBe(f.legacy);
      legacyListener = callback;
      return stopLegacy;
    };
    const first = vi.fn(),
      second = vi.fn();
    const stopFirst = f.teams.onProvisioningProgress(first);
    const stopTeam = f.teams.onTeamChange(vi.fn());
    const stopSecond = f.teams.onProvisioningProgress(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.backend.invoke).mock.calls.map(([r]) => r.operation)).toEqual([
      'team.launch.configuration.read',
      'team.changes.read',
    ]);
    f.configuration.launch.observedAtMs! += 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).toHaveBeenCalledTimes(1);
    const progress = first.mock.calls[0][1] as TeamProvisioningProgress;
    legacyListener(undefined, progress);
    expect(second).toHaveBeenCalledTimes(1);
    legacyListener(undefined, { ...progress, runId: 'legacy-run', teamName: 'legacy-team' });
    expect(second).toHaveBeenCalledTimes(2);
    stopFirst();
    stopSecond();
    stopTeam();
    const count = vi.mocked(f.backend.invoke).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.backend.invoke).toHaveBeenCalledTimes(count);
    expect(stopLegacy).toHaveBeenCalledTimes(2);
  });

  it('keeps long bootstrap visible and warns about a partial failure while other members are pending', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const lead = f.configuration.launch.members[0];
    Object.assign(lead, {
      status: 'failed',
      reason: 'bootstrap-timeout',
      usable: false,
      nativeReady: false,
    });
    f.configuration.launch.members.push({
      ...lead,
      memberId: 'worker',
      status: 'pending-bootstrap',
      reason: 'opening',
    });
    f.configuration.members.push({
      ...f.configuration.members[0],
      memberId: 'worker',
      label: 'worker',
      role: 'member',
    });
    Object.assign(f.configuration.launch, { status: 'failed', ready: 0, expected: 2 });
    const events: TeamProvisioningProgress[] = [];
    const stop = f.teams.onProvisioningProgress((_event, progress) => events.push(progress));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: 'assembling',
      messageSeverity: 'warning',
      warnings: ['Some team members failed to start.'],
    });
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.every(([r]) => r.operation === 'team.launch.configuration.read')
    ).toBe(true);
    Object.assign(f.configuration.launch.members[1], {
      status: 'ready',
      usable: true,
      nativeReady: true,
      reason: 'context-applied',
    });
    Object.assign(f.configuration.launch, { status: 'partial', ready: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.at(-1)?.state).toBe('failed');
    stop();
  });

  it('drops late progress after context change/unsubscribe and does not overlap a pending Host read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value: BackendOperationResult) => void;
    vi.mocked(f.backend.invoke).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const events = vi.fn();
    const stop = f.teams.onProvisioningProgress(events);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
    f.changeContext();
    resolve({ ok: true, value: view() });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.backend.invoke).toHaveBeenCalledTimes(2);
    stop();
    resolve({ ok: true, value: view() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).not.toHaveBeenCalled();
    expect(f.backend.invoke).toHaveBeenCalledTimes(2);
  });

  it('isolates an unavailable owner and sends a current result to a later subscriber', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.backend.getConnections).mockResolvedValue({
      state: 'ready',
      bindings: ['owner-A', 'owner-B'].map((handleId) => ({
        handle: { handleId },
        label: 'Team',
        members: [],
      })),
    });
    const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
    vi.mocked(f.backend.invoke).mockImplementation(async (request) =>
      request.handle.handleId === 'owner-A'
        ? { ok: false, code: 'hold', outcome: 'unknown' }
        : invoke(request)
    );
    const first = vi.fn(),
      second = vi.fn();
    const stopFirst = f.teams.onProvisioningProgress(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][1].teamName).toBe(hostTeamSelectionKey('owner-B'));
    const stopSecond = f.teams.onProvisioningProgress(second);
    await vi.advanceTimersByTimeAsync(2000);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
  });

  it('cannot publish pre-stop readiness after cancellation crosses an observer read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value: BackendOperationResult) => void;
    vi.mocked(f.backend.invoke).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const events = vi.fn();
    const stop = f.teams.onProvisioningProgress(events);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
    await f.teams.cancelProvisioning(selectedRun);
    resolve({ ok: true, value: view() });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).not.toHaveBeenCalled();
    expect(vi.mocked(f.backend.invoke).mock.calls.map(([r]) => r.operation)).toEqual([
      'team.launch.configuration.read',
      'team.launch.configuration.read',
      'runtime.stop',
    ]);
    stop();
  });

  it('shares ordering between a direct status read and newer callback progress', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value: BackendOperationResult) => void;
    vi.mocked(f.backend.invoke).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const old = f.teams.getProvisioningStatus(selectedRun);
    const rejected = expect(old).rejects.toThrow('Stale Host launch read');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
    const events = vi.fn();
    const stop = f.teams.onProvisioningProgress(events);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveBeenCalledTimes(1);
    resolve({ ok: true, value: view() });
    await rejected;
    stop();
  });
});
