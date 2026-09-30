import {
  createTeamLifecycleCommandFeature,
  type TeamLifecycleCommandFeature,
} from '@features/team-lifecycle/main';
import { parseLaneId } from '@features/team-runtime-control';
import { describe, expect, it } from 'vitest';

import {
  createTestClock,
  createTestContext,
  createTestIds,
  createTestRuntimePlan,
  FakeExternalWriterBarrier,
  FakeLegacyRuntimeDrain,
  FakeLifecycleBackendRegistry,
  FakeLifecycleDeadline,
  FakeProvisioningPreflight,
  FakeTeamLifecycleCommandState,
  FakeTeamLifecycleFingerprint,
  TEST_TEAM_ID,
} from './fixtures/FakeTeamLifecycleCommandState';

function harness(state = new FakeTeamLifecycleCommandState()) {
  const backendRegistry = new FakeLifecycleBackendRegistry();
  const externalWriterBarrier = new FakeExternalWriterBarrier();
  const deadlines = new FakeLifecycleDeadline();
  const provisioningPreflight = new FakeProvisioningPreflight();
  const legacyRuntime = new FakeLegacyRuntimeDrain();
  const feature = createTeamLifecycleCommandFeature({
    state,
    fingerprint: new FakeTeamLifecycleFingerprint(),
    externalWriterBarrier,
    deadlines,
    provisioningPreflight,
    backendRegistry,
    legacyRuntime,
    clock: createTestClock(),
    ids: createTestIds(),
  });
  return {
    backendRegistry,
    externalWriterBarrier,
    deadlines,
    feature,
    legacyRuntime,
    provisioningPreflight,
    state,
  };
}

function launchRequest(
  featureState: FakeTeamLifecycleCommandState,
  plan = createTestRuntimePlan(),
  overrides: Partial<Parameters<TeamLifecycleCommandFeature['launchTeam']>[0]> = {}
) {
  return {
    schemaVersion: 1 as const,
    teamId: TEST_TEAM_ID,
    commandId: 'command_launch_fixture',
    idempotencyKey: 'launch_fixture_key',
    expectedLifecycleRevision: featureState.snapshot.lifecycle.revision,
    expectedCurrentRunRef: featureState.snapshot.lifecycle.currentRunRef,
    plan,
    ...overrides,
  };
}

describe('canonical team lifecycle commands', () => {
  it('enforces the bounded preparation deadline before invoking preflight', async () => {
    const test = harness();
    test.deadlines.status = 'deadline_exceeded';

    const result = await test.feature.prepareProvisioning(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        inputRevision: 7,
      },
      createTestContext()
    );

    expect(result).toEqual({ status: 'rejected', reason: 'preparation_timeout' });
    expect(test.provisioningPreflight.calls).toBe(0);
    expect(test.deadlines.deadlines).toEqual([
      {
        startedAtIso: '2026-01-01T00:00:00.000Z',
        timeoutMs: 30_000,
        expiresAtIso: '2026-01-01T00:00:30.000Z',
      },
    ]);
  });

  it('keeps prepare as bounded preflight without a run, epoch advance, or runtime effect', async () => {
    const test = harness();
    const before = test.state.snapshot;

    const result = await test.feature.prepareProvisioning(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        inputRevision: 7,
      },
      createTestContext()
    );

    expect(result).toEqual({
      status: 'ready',
      inputRevision: 7,
      lanes: [
        { laneKey: 'primary', backend: 'provisioning_cli', status: 'ready' },
        {
          laneKey: 'secondary:opencode:reviewer',
          backend: 'opencode',
          status: 'ready',
        },
      ],
    });
    expect(test.state.snapshot).toBe(before);
    expect(test.state.snapshot.lifecycle.currentRunRef).toBeNull();
    expect(test.state.snapshot.lifecycle.fileWriterEpoch).toBe(0);
    expect(test.externalWriterBarrier.calls).toBe(0);
    expect(test.backendRegistry.calls).toEqual([]);
  });

  it('atomically accepts the exact immutable plan before the primary runtime effect', async () => {
    const test = harness();
    const plan = createTestRuntimePlan();
    let planAtLaunch: unknown;
    let runRefAtLaunch: unknown;
    let fileWriterEpochAtLaunch = -1;
    let acceptedOutboxAtLaunch = false;
    test.backendRegistry.onOperation = (call) => {
      if (call.operation === 'launch') {
        planAtLaunch = test.state.snapshot.currentRun?.plan;
        runRefAtLaunch = test.state.snapshot.lifecycle.currentRunRef;
        fileWriterEpochAtLaunch = test.state.snapshot.lifecycle.fileWriterEpoch;
        acceptedOutboxAtLaunch = test.state.outbox[0]?.eventType === 'team-lifecycle.run-accepted';
      }
    };

    const result = await test.feature.launchTeam(
      launchRequest(test.state, plan),
      createTestContext()
    );

    expect(result.status).toBe('accepted');
    expect(test.state.acceptedPlanReferences).toEqual([plan]);
    expect(test.state.snapshot.currentRun?.plan).toBe(plan);
    expect(test.state.snapshot.lifecycle.currentRunRef).toEqual({
      runId: plan.runId,
      generation: plan.generation,
    });
    expect(test.state.snapshot.lifecycle.fileWriterEpoch).toBe(1);
    expect(test.state.snapshot.lifecycle.writerBarrierReceipt).toMatchObject({
      schemaVersion: 1,
      previousFileWriterEpoch: 0,
      nextFileWriterEpoch: 1,
      drainedThrough: {
        fileWriterEpoch: 0,
        observationSequence: 11,
      },
    });
    expect(planAtLaunch).toBe(plan);
    expect(runRefAtLaunch).toEqual({
      runId: plan.runId,
      generation: plan.generation,
    });
    expect(fileWriterEpochAtLaunch).toBe(1);
    expect(acceptedOutboxAtLaunch).toBe(true);
    expect(test.state.outbox[0]?.eventType).toBe('team-lifecycle.run-accepted');
    expect(test.state.outbox[0]).toMatchObject({
      eventType: 'team-lifecycle.run-accepted',
      semanticRevision: 2,
    });
    expect(test.backendRegistry.count('launch', 'provisioning_cli')).toBe(1);
    expect(test.backendRegistry.count('launch', 'opencode')).toBe(0);
    expect(
      test.backendRegistry.calls.findIndex((call) => call.operation === 'launch')
    ).toBeGreaterThanOrEqual(0);
  });

  it('accepts reconstructed scopes with the exact stored semantic identities', async () => {
    const test = harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });
    test.backendRegistry.reconstructResolvedScope = true;

    const result = await test.feature.launchTeam(
      launchRequest(test.state, plan),
      createTestContext()
    );

    expect(result.status).toBe('accepted');
    expect(test.backendRegistry.count('launch')).toBe(1);
    expect(test.backendRegistry.executedScopes).toHaveLength(1);
    expect(test.backendRegistry.executedScopes[0]).toMatchObject({
      plan,
      lane: plan.lanes[0],
      executionUnit: plan.executionUnits[0],
      requiredProviderIds: ['anthropic', 'codex'],
    });
    expect((test.backendRegistry.executedScopes[0] as { readonly plan: unknown }).plan).toBe(plan);
    expect(test.state.snapshot.currentRun?.lanes[0]?.diagnostic).toBeNull();
  });

  it('uses the persisted writer barrier receipt to fence stale progress writers', async () => {
    const test = harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });
    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());
    const snapshot = test.state.snapshot;
    const run = snapshot.currentRun!;
    const receipt = snapshot.lifecycle.writerBarrierReceipt!;
    const staleReceipt = Object.freeze({
      ...receipt,
      barrierId: 'stale_writer_barrier_fixture',
      drainedThrough: Object.freeze({ ...receipt.drainedThrough }),
    });

    const result = await test.state.saveRunProgress({
      expectedLifecycleRevision: snapshot.lifecycle.revision,
      expectedRunRevision: run.revision,
      runRef: { runId: run.runId, generation: run.generation },
      nextLifecycle: snapshot.lifecycle,
      nextRun: run,
      expectedWriterBarrierReceipt: staleReceipt,
      outbox: Object.freeze({
        eventId: 'event_stale_writer_fixture',
        eventType: 'team-lifecycle.stale-writer-attempt',
        scopeKind: 'team',
        scopeId: TEST_TEAM_ID,
        schemaVersion: 1,
        semanticRevision: snapshot.lifecycle.revision,
        payloadJson: '{}',
        createdAtIso: '2026-01-01T00:00:00.000Z',
      }),
    });

    expect(result).toEqual({ status: 'stale_generation' });
  });

  it('rejects a widened resolved provider scope before backend execution', async () => {
    const test = harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });
    test.backendRegistry.widenResolvedProviders = true;

    const result = await test.feature.launchTeam(
      launchRequest(test.state, plan),
      createTestContext()
    );

    expect(result.status).toBe('degraded');
    expect(test.backendRegistry.count('launch')).toBe(0);
    expect(test.state.snapshot.currentRun?.lanes[0]?.diagnostic).toBe(
      'runtime-preflight-backend_scope_mismatch'
    );
  });

  it('preserves primary-first admission and later queues the OpenCode side lane', async () => {
    const test = harness();
    const plan = createTestRuntimePlan();
    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());

    expect(test.state.snapshot.currentRun?.lanes.map((lane) => lane.status)).toEqual([
      'starting',
      'queued',
    ]);
    const status = await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(status.status).toBe('current');
    expect(test.backendRegistry.calls.map((call) => `${call.backend}:${call.operation}`)).toEqual([
      'provisioning_cli:preflight',
      'provisioning_cli:launch',
      'provisioning_cli:observe',
      'opencode:preflight',
      'opencode:launch',
    ]);
    expect(test.state.snapshot.currentRun?.lanes.map((lane) => lane.status)).toEqual([
      'ready',
      'starting',
    ]);
  });

  it('keeps a successful primary lane while reporting a deterministic degraded side lane', async () => {
    const test = harness();
    const plan = createTestRuntimePlan();
    test.backendRegistry.script('opencode', parseLaneId('secondary:opencode:reviewer'), 'launch', {
      status: 'rejected',
      reason: 'unavailable',
    });
    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());

    const status = await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(status.status).toBe('current');
    if (status.status === 'current') expect(status.run.status).toBe('degraded');
    expect(test.state.snapshot.currentRun?.lanes.map((lane) => lane.status)).toEqual([
      'ready',
      'failed',
    ]);
  });

  it('replays an identical launch and rejects the same key with changed intent', async () => {
    const test = harness();
    const plan = createTestRuntimePlan();
    const request = launchRequest(test.state, plan);
    const first = await test.feature.launchTeam(request, createTestContext());
    const launchCalls = test.backendRegistry.count('launch');
    const barrierCalls = test.externalWriterBarrier.calls;

    const replay = await test.feature.launchTeam(request, createTestContext());
    const conflict = await test.feature.launchTeam(
      {
        ...request,
        commandId: 'command_launch_changed',
        plan: createTestRuntimePlan({ runCharacter: '9' }),
      },
      createTestContext()
    );

    expect(first.status).toBe('accepted');
    expect(replay.status).toBe('replayed');
    expect(conflict).toEqual({ status: 'rejected', reason: 'idempotency_conflict' });
    expect(test.backendRegistry.count('launch')).toBe(launchCalls);
    expect(test.externalWriterBarrier.calls).toBe(barrierCalls);
    expect(test.state.snapshot.currentRun?.plan).toBe(plan);
  });

  it('replays the immutable claim-bound projection after the live snapshot mutates', async () => {
    const test = harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });
    const request = launchRequest(test.state, plan);
    await test.feature.launchTeam(request, createTestContext());
    await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_stop_after_launch_claim',
        idempotencyKey: 'stop_after_launch_claim_key',
        expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
        mode: 'immediate',
      },
      createTestContext()
    );
    expect(test.state.snapshot.currentRun?.status).toBe('stopped');
    const loadCalls = test.state.loadCalls;

    const replay = await test.feature.launchTeam(request, createTestContext());

    expect(replay.status).toBe('replayed');
    if (replay.status === 'replayed') {
      expect(replay.run).toMatchObject({
        runId: plan.runId,
        generation: plan.generation,
        revision: 1,
        status: 'accepted',
        lanes: [expect.objectContaining({ status: 'queued' })],
      });
      expect(Object.isFrozen(replay.run)).toBe(true);
      expect(Object.isFrozen(replay.run.lanes)).toBe(true);
    }
    expect(test.state.loadCalls).toBe(loadCalls);
    expect(test.state.snapshot.currentRun?.status).toBe('stopped');
  });

  it('preserves the originally claimed generation when its replay follows a newer launch', async () => {
    const test = harness();
    const firstPlan = createTestRuntimePlan({ topology: 'primary' });
    const firstRequest = launchRequest(test.state, firstPlan);
    await test.feature.launchTeam(firstRequest, createTestContext());
    const firstStopRequest = {
      schemaVersion: 1 as const,
      teamId: TEST_TEAM_ID,
      commandId: 'command_stop_generation_one',
      idempotencyKey: 'stop_generation_one_key',
      expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
      runRef: { runId: firstPlan.runId, generation: firstPlan.generation },
      mode: 'graceful' as const,
    };
    await test.feature.stopTeam(firstStopRequest, createTestContext());
    const secondPlan = createTestRuntimePlan({
      generation: 2,
      runCharacter: '2',
      topology: 'primary',
    });
    await test.feature.launchTeam(
      launchRequest(test.state, secondPlan, {
        commandId: 'command_launch_generation_two',
        idempotencyKey: 'launch_generation_two_key',
      }),
      createTestContext()
    );

    const replay = await test.feature.launchTeam(firstRequest, createTestContext());
    const stopReplay = await test.feature.stopTeam(firstStopRequest, createTestContext());

    expect(replay.status).toBe('replayed');
    if (replay.status === 'replayed') {
      expect(replay.run.generation).toBe(1);
      expect(replay.run.runId).toBe(firstPlan.runId);
    }
    expect(stopReplay.status).toBe('replayed');
    if (stopReplay.status === 'replayed') {
      expect(stopReplay.run?.generation).toBe(1);
      expect(stopReplay.run?.runId).toBe(firstPlan.runId);
    }
    expect(test.state.snapshot.currentRun?.generation).toBe(2);
  });

  it('returns external_writer_busy without allocating a run or advancing the epoch', async () => {
    const test = harness();
    test.externalWriterBarrier.status = 'busy';
    const plan = createTestRuntimePlan();

    const result = await test.feature.launchTeam(
      launchRequest(test.state, plan),
      createTestContext()
    );

    expect(result).toEqual({ status: 'rejected', reason: 'external_writer_busy' });
    expect(test.state.snapshot.lifecycle.currentRunRef).toBeNull();
    expect(test.state.snapshot.currentRun).toBeNull();
    expect(test.state.snapshot.lifecycle.fileWriterEpoch).toBe(0);
    expect(test.backendRegistry.count('launch')).toBe(0);
  });

  it('cancels queued lanes without starting them and drains only the started lane', async () => {
    const test = harness();
    const plan = createTestRuntimePlan();
    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());

    const result = await test.feature.cancelProvisioning(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_cancel_fixture',
        idempotencyKey: 'cancel_fixture_key',
        expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(result.status).toBe('cancelled');
    expect(test.state.snapshot.currentRun?.lanes.map((lane) => lane.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect(test.backendRegistry.count('stop', 'provisioning_cli')).toBe(1);
    expect(test.backendRegistry.count('stop', 'opencode')).toBe(0);
    expect(test.backendRegistry.count('launch', 'opencode')).toBe(0);

    const terminalStop = {
      schemaVersion: 1 as const,
      teamId: TEST_TEAM_ID,
      commandId: 'command_terminal_stop',
      idempotencyKey: 'terminal_stop_key',
      expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
      runRef: { runId: plan.runId, generation: plan.generation },
      mode: 'graceful' as const,
    };
    expect(await test.feature.stopTeam(terminalStop, createTestContext())).toMatchObject({
      status: 'stopped',
    });
    expect(await test.feature.stopTeam(terminalStop, createTestContext())).toMatchObject({
      status: 'replayed',
    });
    expect(
      await test.feature.stopTeam(
        { ...terminalStop, commandId: 'command_terminal_stop_changed', mode: 'immediate' },
        createTestContext()
      )
    ).toEqual({ status: 'rejected', reason: 'idempotency_conflict' });
  });

  it('never reports partial stop ambiguity as success', async () => {
    const test = harness();
    const plan = createTestRuntimePlan();
    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());
    await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );
    test.backendRegistry.script('opencode', parseLaneId('secondary:opencode:reviewer'), 'stop', {
      status: 'operator_required',
    });

    const result = await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_stop_fixture',
        idempotencyKey: 'stop_fixture_key',
        expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
        mode: 'graceful',
      },
      createTestContext()
    );

    expect(result.status).toBe('operator_required');
    expect(result.status).not.toBe('stopped');
    expect(test.state.snapshot.currentRun?.status).toBe('operator_required');
    expect(test.backendRegistry.count('stop', 'provisioning_cli')).toBe(1);
    expect(test.backendRegistry.count('stop', 'opencode')).toBe(1);
  });

  it('keeps operator-required stop ambiguity fail-closed when status observes ready', async () => {
    const test = harness();
    const plan = createTestRuntimePlan();
    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());
    await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );
    const sideLaneId = parseLaneId('secondary:opencode:reviewer');
    test.backendRegistry.script('opencode', sideLaneId, 'stop', {
      status: 'operator_required',
    });
    const stop = await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_ambiguous_stop_status_fixture',
        idempotencyKey: 'ambiguous_stop_status_fixture_key',
        expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
        mode: 'immediate',
      },
      createTestContext()
    );
    expect(stop.status).toBe('operator_required');
    expect(test.state.snapshot.currentRun).toMatchObject({
      status: 'operator_required',
      activeIntent: 'stop',
      lanes: [
        { laneId: parseLaneId('primary'), status: 'stopped' },
        { laneId: sideLaneId, status: 'operator_required' },
      ],
    });
    const observationsBeforePoll = test.backendRegistry.count('observe', 'opencode');
    test.backendRegistry.script('opencode', sideLaneId, 'observe', { status: 'ready' });

    const status = await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(test.backendRegistry.count('observe', 'opencode')).toBe(observationsBeforePoll + 1);
    expect(status).toMatchObject({
      status: 'current',
      run: {
        status: 'operator_required',
        lanes: [
          { laneId: parseLaneId('primary'), status: 'stopped' },
          { laneId: sideLaneId, status: 'operator_required' },
        ],
      },
    });
    expect(test.state.snapshot.currentRun?.activeIntent).toBe('stop');
    expect(test.state.snapshot.currentRun?.drainMode).toBe('immediate');
  });

  it('fences commands to the exact current generation', async () => {
    const test = harness();
    const plan = createTestRuntimePlan();
    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());
    const expectedRevision = test.state.snapshot.lifecycle.revision;
    test.state.forceCurrentRunRef(`run_${'8'.repeat(32)}`, 2);

    const result = await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_stale_stop',
        idempotencyKey: 'stale_stop_key',
        expectedLifecycleRevision: expectedRevision + 1,
        runRef: { runId: plan.runId, generation: plan.generation },
        mode: 'immediate',
      },
      createTestContext()
    );

    expect(result).toEqual({ status: 'rejected', reason: 'stale_generation' });
    expect(test.backendRegistry.count('stop')).toBe(0);
  });
});
