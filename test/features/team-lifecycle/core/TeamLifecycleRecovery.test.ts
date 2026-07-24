import {
  applyLifecycleLaneObservation,
  createLegacyRuntimeCutover,
  createTeamLifecycle,
} from '@features/team-lifecycle';
import { createTeamLifecycleCommandFeature } from '@features/team-lifecycle/main';
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
  TEST_DEPLOYMENT_ID,
  TEST_TEAM_ID,
} from './fixtures/FakeTeamLifecycleCommandState';

function harness(state: FakeTeamLifecycleCommandState) {
  const backendRegistry = new FakeLifecycleBackendRegistry();
  const legacyRuntime = new FakeLegacyRuntimeDrain();
  const feature = createTeamLifecycleCommandFeature({
    state,
    fingerprint: new FakeTeamLifecycleFingerprint(),
    externalWriterBarrier: new FakeExternalWriterBarrier(),
    deadlines: new FakeLifecycleDeadline(),
    provisioningPreflight: new FakeProvisioningPreflight(),
    backendRegistry,
    legacyRuntime,
    clock: createTestClock(),
    ids: createTestIds(),
  });
  return { backendRegistry, feature, legacyRuntime, state };
}

function launchRequest(state: FakeTeamLifecycleCommandState, plan = createTestRuntimePlan()) {
  return {
    schemaVersion: 1 as const,
    teamId: TEST_TEAM_ID,
    commandId: 'command_launch_recovery',
    idempotencyKey: 'launch_recovery_key',
    expectedLifecycleRevision: state.snapshot.lifecycle.revision,
    expectedCurrentRunRef: state.snapshot.lifecycle.currentRunRef,
    plan,
  };
}

describe('team lifecycle recovery and cutover', () => {
  it('terminalizes cancel and stop when acceptance crashed before every lane effect', async () => {
    for (const intent of ['cancel', 'stop'] as const) {
      const state = new FakeTeamLifecycleCommandState();
      const test = harness(state);
      const plan = createTestRuntimePlan({ topology: 'primary' });
      state.failNextEffectClaim = true;
      await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
      expect(test.backendRegistry.count('launch')).toBe(0);

      const result =
        intent === 'cancel'
          ? await test.feature.cancelProvisioning(
              {
                schemaVersion: 1,
                teamId: TEST_TEAM_ID,
                commandId: 'command_cancel_zero_effects',
                idempotencyKey: 'cancel_zero_effects_key',
                expectedLifecycleRevision: state.snapshot.lifecycle.revision,
                runRef: { runId: plan.runId, generation: plan.generation },
              },
              createTestContext()
            )
          : await test.feature.stopTeam(
              {
                schemaVersion: 1,
                teamId: TEST_TEAM_ID,
                commandId: 'command_stop_zero_effects',
                idempotencyKey: 'stop_zero_effects_key',
                expectedLifecycleRevision: state.snapshot.lifecycle.revision,
                runRef: { runId: plan.runId, generation: plan.generation },
                mode: 'immediate',
              },
              createTestContext()
            );

      expect(result.status).toBe(intent === 'cancel' ? 'cancelled' : 'stopped');
      expect(state.snapshot.currentRun?.status).toBe(intent === 'cancel' ? 'cancelled' : 'stopped');
      expect(test.backendRegistry.count('stop')).toBe(0);

      if (intent === 'cancel') {
        const recovery = await test.feature.recoverTeamRun(
          {
            schemaVersion: 1,
            teamId: TEST_TEAM_ID,
            commandId: 'command_recover_cancelled_zero_effects',
            idempotencyKey: 'recover_cancelled_zero_effects_key',
            expectedLifecycleRevision: state.snapshot.lifecycle.revision,
            runRef: { runId: plan.runId, generation: plan.generation },
          },
          createTestContext()
        );
        expect(recovery).toEqual({ status: 'rejected', reason: 'terminal_run' });
      }
    }
  });

  it('rejects a stale launch claim after cancel terminalizes the run', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    let cancelStatus: string | null = null;
    state.beforeNextEffectClaim = async (claim) => {
      expect(state.snapshot.currentRun?.lanes[0]?.status).toBe('queued');
      expect(claim.expectedRunRevision).toBe(state.snapshot.currentRun?.revision);
      expect(claim.expectedRunIntent).toBeNull();
      expect(claim.expectedLaneStatus).toBe('queued');
      expect(claim.nextRun.lanes[0]?.status).toBe('launching');
      cancelStatus = (
        await test.feature.cancelProvisioning(
          {
            schemaVersion: 1,
            teamId: TEST_TEAM_ID,
            commandId: 'command_cancel_before_launch_claim',
            idempotencyKey: 'cancel_before_launch_claim_key',
            expectedLifecycleRevision: state.snapshot.lifecycle.revision,
            runRef: { runId: plan.runId, generation: plan.generation },
          },
          createTestContext()
        )
      ).status;
    };

    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());

    expect(cancelStatus).toBe('cancelled');
    expect(state.snapshot.currentRun?.status).toBe('cancelled');
    expect(state.snapshot.laneEffects[0]).toMatchObject({
      kind: 'launch',
      state: 'not_started',
      attempt: 0,
      leaseFence: 0,
      lease: null,
    });
    expect(test.backendRegistry.count('launch')).toBe(0);
  });

  it('same-key replay returns the claim projection without resuming a pre-effect crash', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    const request = launchRequest(state, plan);
    state.failNextEffectClaim = true;

    await test.feature.launchTeam(request, createTestContext());
    expect(test.backendRegistry.count('launch')).toBe(0);
    const replay = await test.feature.launchTeam(request, createTestContext());

    expect(replay.status).toBe('replayed');
    expect(test.backendRegistry.count('launch')).toBe(0);
    expect(state.snapshot.laneEffects[0]).toMatchObject({
      kind: 'launch',
      state: 'not_started',
      attempt: 0,
      leaseFence: 0,
    });
  });

  it('reconciles a mid-launch crash under an explicit recovery fence', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    const request = launchRequest(state, plan);
    state.failNextEffectCompletion = true;

    await test.feature.launchTeam(request, createTestContext());
    const staleSettlement = state.failedEffectSettlement;
    const immutableLaunchMutation = state.snapshot.laneEffects[0]?.providerMutations.launch;
    expect(test.backendRegistry.count('launch')).toBe(1);
    expect(state.snapshot.laneEffects[0]).toMatchObject({
      state: 'attempting',
      leaseFence: 1,
    });

    state.expireLaneEffectLeases();
    const recovery = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_mid_launch',
        idempotencyKey: 'recover_mid_launch_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(recovery.status).toBe('recovering');
    expect(test.backendRegistry.count('launch')).toBe(1);
    expect(test.backendRegistry.count('recover')).toBe(0);
    expect(test.backendRegistry.mutationAuthorityCount('launch')).toBe(2);
    expect(test.backendRegistry.count('preflight')).toBe(1);
    expect(new Set(test.backendRegistry.operationIds).size).toBe(1);
    expect(test.backendRegistry.leaseFences).toEqual([1]);
    const launchAuthorityCalls = test.backendRegistry.mutationAuthorityCalls.filter(
      (call) => call.operation === 'launch'
    );
    expect(launchAuthorityCalls).toHaveLength(2);
    expect(launchAuthorityCalls[1]?.requestJson).toBe(launchAuthorityCalls[0]?.requestJson);
    expect(state.snapshot.laneEffects.find((effect) => effect.kind === 'launch')).toMatchObject({
      state: 'observed_succeeded',
      leaseFence: 2,
      lease: null,
      providerMutations: {
        launch: immutableLaunchMutation,
      },
      evidence: {
        kind: 'launch_receipt',
        disposition: 'launched',
        leaseFence: 2,
      },
    });
    expect(state.snapshot.laneEffects.find((effect) => effect.kind === 'recover')).toBeUndefined();
    expect(
      state.snapshot.laneEffects.find((effect) => effect.kind === 'launch')?.providerMutations
        .launch
    ).toBe(immutableLaunchMutation);
    expect(staleSettlement).not.toBeNull();
    if (staleSettlement) {
      expect(await state.settleLaneEffect(staleSettlement)).toEqual({
        status: 'stale_lease',
      });
    }
  });

  it('fences a mid-launch writer before cancel reconciles and drains the exact effect', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    state.failNextEffectCompletion = true;

    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
    const staleSettlement = state.failedEffectSettlement;
    expect(test.backendRegistry.count('launch')).toBe(1);
    expect(state.snapshot.laneEffects[0]).toMatchObject({
      kind: 'launch',
      state: 'attempting',
      leaseFence: 1,
    });

    const cancelled = await test.feature.cancelProvisioning(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_cancel_mid_launch',
        idempotencyKey: 'cancel_mid_launch_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(cancelled.status).toBe('cancelled');
    expect(test.backendRegistry.count('launch')).toBe(1);
    expect(test.backendRegistry.count('recover')).toBe(1);
    expect(test.backendRegistry.count('stop')).toBe(1);
    expect(new Set(test.backendRegistry.operationIds).size).toBe(3);
    expect(test.backendRegistry.leaseFences).toEqual([1, 2, 3]);
    expect(state.snapshot.currentRun?.status).toBe('cancelled');
    expect(state.snapshot.laneEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'launch',
          state: 'ambiguous',
          lease: null,
        }),
        expect.objectContaining({
          kind: 'drain',
          state: 'observed_succeeded',
          leaseFence: 3,
        }),
      ])
    );
    const launchEffect = state.snapshot.laneEffects.find((effect) => effect.kind === 'launch');
    const drainEffect = state.snapshot.laneEffects.find((effect) => effect.kind === 'drain');
    expect(drainEffect?.operationId).not.toBe(launchEffect?.operationId);
    expect(drainEffect?.causalPredecessor).toMatchObject({
      runRef: launchEffect?.runRef,
      kind: 'launch',
      laneId: launchEffect?.laneId,
      operationId: launchEffect?.operationId,
    });
    expect(staleSettlement).not.toBeNull();
    if (staleSettlement) {
      expect(await state.settleLaneEffect(staleSettlement)).toEqual({
        status: 'stale_lease',
      });
    }
  });

  it('reconciles a mid-stop crash without issuing a duplicate stop', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
    const request = {
      schemaVersion: 1 as const,
      teamId: TEST_TEAM_ID,
      commandId: 'command_stop_mid_effect',
      idempotencyKey: 'stop_mid_effect_key',
      expectedLifecycleRevision: state.snapshot.lifecycle.revision,
      runRef: { runId: plan.runId, generation: plan.generation },
      mode: 'graceful' as const,
    };
    state.failNextEffectCompletion = true;

    const stopped = await test.feature.stopTeam(request, createTestContext());
    expect(stopped.status).toBe('recovering');
    expect(test.backendRegistry.count('stop')).toBe(1);
    const immutableStopMutation = state.snapshot.laneEffects.find(
      (effect) => effect.kind === 'drain'
    )?.providerMutations.stop;
    state.expireLaneEffectLeases();

    const recovery = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_mid_stop',
        idempotencyKey: 'recover_mid_stop_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );
    const replay = await test.feature.stopTeam(request, createTestContext());

    expect(recovery.status).toBe('recovered');
    expect(replay.status).toBe('replayed');
    if (replay.status === 'replayed') expect(replay.run?.status).toBe('stopping');
    expect(test.backendRegistry.count('stop')).toBe(1);
    expect(test.backendRegistry.count('recover')).toBe(0);
    expect(test.backendRegistry.mutationAuthorityCount('stop')).toBe(2);
    expect(new Set(test.backendRegistry.operationIds).size).toBe(2);
    expect(test.backendRegistry.leaseFences).toEqual([1, 2]);
    const stopAuthorityCalls = test.backendRegistry.mutationAuthorityCalls.filter(
      (call) => call.operation === 'stop'
    );
    expect(stopAuthorityCalls).toHaveLength(2);
    expect(stopAuthorityCalls[1]?.requestJson).toBe(stopAuthorityCalls[0]?.requestJson);
    expect(state.snapshot.laneEffects.find((effect) => effect.kind === 'drain')).toMatchObject({
      state: 'observed_succeeded',
      leaseFence: 3,
      lease: null,
      providerMutations: {
        stop: immutableStopMutation,
      },
      evidence: {
        kind: 'drain_receipt',
        disposition: 'stopped',
        leaseFence: 3,
      },
    });
    expect(state.snapshot.laneEffects.find((effect) => effect.kind === 'recover')).toBeUndefined();
    expect(
      state.snapshot.laneEffects.find((effect) => effect.kind === 'drain')?.providerMutations.stop
    ).toBe(immutableStopMutation);
    expect(state.snapshot.currentRun?.status).toBe('stopped');
  });

  it('keeps explicit recovery admissible after an unknown exit cannot settle a failed drain', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
    state.failNextEffectCompletion = true;

    const stopped = await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_stop_before_unknown_exit',
        idempotencyKey: 'stop_before_unknown_exit_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
        mode: 'graceful',
      },
      createTestContext()
    );

    expect(stopped.status).toBe('recovering');
    expect(state.snapshot.currentRun?.status).toBe('stopping');
    const drainFence = state.snapshot.laneEffects.find(
      (effect) => effect.kind === 'drain'
    )?.leaseFence;
    expect(drainFence).toBe(2);
    expect(state.snapshot.laneEffects.find((effect) => effect.kind === 'drain')).toMatchObject({
      state: 'attempting',
      leaseFence: drainFence,
    });

    test.backendRegistry.script('provisioning_cli', parseLaneId('primary'), 'observe', {
      status: 'exited',
      outcome: 'unknown',
    });
    const status = await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(status.status).toBe('current');
    if (status.status === 'current') expect(status.run.status).toBe('operator_required');
    expect(state.snapshot.currentRun?.lanes[0]).toMatchObject({
      status: 'operator_required',
      diagnostic: 'runtime-exited-unknown-during-stop-without-conclusive-effect-evidence',
    });
    expect(state.snapshot.laneEffects.find((effect) => effect.kind === 'drain')).toMatchObject({
      state: 'ambiguous',
      lease: null,
      evidence: {
        kind: 'ambiguous_evidence',
        leaseFence: drainFence,
        diagnostic: 'runtime-exited-unknown-during-stop-without-conclusive-effect-evidence',
      },
    });

    const recovery = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_after_unknown_exit',
        idempotencyKey: 'recover_after_unknown_exit_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(recovery.status).toBe('recovered');
    expect(state.snapshot.currentRun?.status).toBe('stopped');
    expect(state.snapshot.laneEffects.some((effect) => effect.state === 'attempting')).toBe(false);
    const settledDrain = state.snapshot.laneEffects.find((effect) => effect.kind === 'drain');
    const settledRecovery = state.snapshot.laneEffects.find((effect) => effect.kind === 'recover');
    expect(settledDrain).toMatchObject({
      state: 'observed_absent',
      leaseFence: drainFence,
      lease: null,
      evidence: {
        kind: 'causal_absence_evidence',
        effectKind: 'drain',
        proof: 'recovery_not_started',
        operationId: settledDrain?.operationId,
        leaseFence: drainFence,
        provingOperationId: settledRecovery?.operationId,
        provingLeaseFence: settledRecovery?.leaseFence,
      },
    });
    expect(state.snapshot.laneEffects.find((effect) => effect.kind === 'recover')).toMatchObject({
      state: 'observed_succeeded',
      operationId: settledRecovery?.operationId,
      causalPredecessor: {
        runRef: settledDrain?.runRef,
        kind: settledDrain?.kind,
        laneId: settledDrain?.laneId,
        operationId: settledDrain?.operationId,
      },
      evidence: {
        kind: 'recovery_receipt',
        disposition: 'not_started',
      },
    });
    expect(settledRecovery?.operationId).not.toBe(settledDrain?.operationId);
    await expect(
      test.feature.recoverTeamRun(
        {
          schemaVersion: 1,
          teamId: TEST_TEAM_ID,
          commandId: 'command_recover_after_causal_settlement',
          idempotencyKey: 'recover_after_causal_settlement_key',
          expectedLifecycleRevision: state.snapshot.lifecycle.revision,
          runRef: { runId: plan.runId, generation: plan.generation },
        },
        createTestContext()
      )
    ).resolves.toEqual({ status: 'rejected', reason: 'terminal_run' });
  });

  it('refuses terminal derivation until every causal drain and recovery settlement is atomic', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
    state.failNextEffectCompletion = true;
    await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_stop_before_unsettled_recovery',
        idempotencyKey: 'stop_before_unsettled_recovery_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
        mode: 'graceful',
      },
      createTestContext()
    );
    test.backendRegistry.script('provisioning_cli', parseLaneId('primary'), 'observe', {
      status: 'exited',
      outcome: 'unknown',
    });
    await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );
    state.failNextEffectCompletion = true;

    const firstRecovery = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_without_atomic_settlement',
        idempotencyKey: 'recover_without_atomic_settlement_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );
    const failedSettlement = state.failedEffectSettlement;

    expect(firstRecovery.status).toBe('recovering');
    expect(failedSettlement?.causalSettlements).toHaveLength(1);
    if (!failedSettlement) throw new TypeError('expected failed atomic causal settlement');
    expect(
      await state.settleLaneEffect({
        ...failedSettlement,
        causalSettlements: [],
      })
    ).toEqual({ status: 'evidence_conflict' });
    const staleCausal = failedSettlement.causalSettlements[0];
    if (!staleCausal) throw new TypeError('expected causal drain settlement');
    expect(
      await state.settleLaneEffect({
        ...failedSettlement,
        causalSettlements: [
          {
            ...staleCausal,
            operationId: `${staleCausal.operationId}:stale`,
          },
        ],
      })
    ).toEqual({ status: 'evidence_conflict' });
    expect(state.snapshot.currentRun?.status).not.toBe('stopped');
    expect(
      state.snapshot.laneEffects.filter(
        (effect) =>
          (effect.kind === 'drain' || effect.kind === 'recover') &&
          (effect.state === 'attempting' || effect.state === 'ambiguous')
      )
    ).toHaveLength(2);

    state.expireLaneEffectLeases();
    const settledRecovery = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_all_causal_effects',
        idempotencyKey: 'recover_all_causal_effects_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );
    expect(settledRecovery.status).toBe('recovered');
    expect(state.snapshot.currentRun?.status).toBe('stopped');
    expect(
      state.snapshot.laneEffects
        .filter((effect) => effect.kind === 'drain' || effect.kind === 'recover')
        .every(
          (effect) => effect.state === 'observed_succeeded' || effect.state === 'observed_absent'
        )
    ).toBe(true);
  });

  it('rejects ambiguous evidence as absence and retains an ambiguous recovery result', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    const request = launchRequest(state, plan);
    test.backendRegistry.script('provisioning_cli', parseLaneId('primary'), 'launch', {
      status: 'operator_required',
    });
    state.failNextEffectCompletion = true;
    await test.feature.launchTeam(request, createTestContext());
    const failedSettlement = state.failedEffectSettlement;
    expect(failedSettlement).not.toBeNull();
    if (!failedSettlement) throw new TypeError('expected failed lifecycle effect settlement');
    const evidence = failedSettlement.settlement.evidence;
    const inconsistent = {
      ...failedSettlement,
      settlement: {
        state: 'observed_absent',
        evidence: {
          schemaVersion: 1,
          kind: 'ambiguous_evidence',
          operationId: evidence.operationId,
          leaseFence: evidence.leaseFence,
          observedAtIso: evidence.observedAtIso,
          diagnostic: 'runtime-evidence-remains-ambiguous',
        },
      },
    } as unknown as Parameters<typeof state.settleLaneEffect>[0];

    expect(await state.settleLaneEffect(inconsistent)).toEqual({
      status: 'evidence_conflict',
    });
    expect(state.snapshot.laneEffects[0]).toMatchObject({
      state: 'attempting',
      evidence: null,
    });

    expect(await state.settleLaneEffect(failedSettlement)).toMatchObject({
      status: 'committed',
    });
    expect(state.snapshot.laneEffects[0]).toMatchObject({
      state: 'ambiguous',
      evidence: {
        kind: 'ambiguous_evidence',
        leaseFence: 1,
      },
    });

    const recovery = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_ambiguous_evidence',
        idempotencyKey: 'recover_ambiguous_evidence_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(recovery.status).toBe('operator_required');
    expect(test.backendRegistry.count('launch')).toBe(1);
    expect(test.backendRegistry.count('recover')).toBe(0);
    expect(test.backendRegistry.mutationAuthorityCount('recover')).toBe(1);
    expect(state.snapshot.laneEffects.find((effect) => effect.kind === 'recover')).toMatchObject({
      state: 'ambiguous',
      evidence: {
        kind: 'ambiguous_evidence',
        leaseFence: 2,
      },
    });
  });

  it('rejects a valid absence proof paired with a ready next lane projection', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    state.failNextEffectCompletion = true;
    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
    const failedSettlement = state.failedEffectSettlement;
    expect(failedSettlement).not.toBeNull();
    if (!failedSettlement) throw new TypeError('expected failed lifecycle effect settlement');
    const evidence = failedSettlement.settlement.evidence;
    const readyRun = applyLifecycleLaneObservation(
      failedSettlement.nextRun,
      parseLaneId('primary'),
      { status: 'ready' }
    );
    const inconsistent = {
      ...failedSettlement,
      settlement: {
        state: 'observed_absent',
        evidence: {
          schemaVersion: 1,
          kind: 'absence_evidence',
          effectKind: 'launch',
          proof: 'runtime_absence_observed',
          operationId: evidence.operationId,
          leaseFence: evidence.leaseFence,
          observedAtIso: evidence.observedAtIso,
        },
      },
      nextRun: readyRun,
    } as const;

    expect(await state.settleLaneEffect(inconsistent)).toEqual({
      status: 'evidence_conflict',
    });
    expect(state.snapshot.currentRun?.lanes[0]?.status).toBe('launching');
    expect(state.snapshot.laneEffects[0]).toMatchObject({
      state: 'attempting',
      evidence: null,
    });
  });

  it('recovers an accepted crash using only the stored immutable plan', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    state.failNextEffectClaim = true;
    const launch = await test.feature.launchTeam(launchRequest(state, plan), createTestContext());

    expect(launch.status).toBe('accepted');
    expect(test.backendRegistry.count('launch')).toBe(0);
    expect(state.snapshot.currentRun?.status).toBe('accepted');
    expect(state.snapshot.currentRun?.plan).toBe(plan);

    const recovery = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_accepted',
        idempotencyKey: 'recover_accepted_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(recovery.status).toBe('recovering');
    expect(test.backendRegistry.count('recover', 'provisioning_cli')).toBe(1);
    expect(test.backendRegistry.count('launch', 'provisioning_cli')).toBe(1);
    expect(state.snapshot.currentRun?.plan).toBe(plan);
    expect(state.acceptedPlanReferences).toEqual([plan]);

    const status = await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );
    expect(status.status).toBe('current');
    if (status.status === 'current') expect(status.run.status).toBe('ready');
  });

  it('rejects recovery after a terminal run without mutating it', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
    await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_stop_terminal',
        idempotencyKey: 'stop_terminal_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
        mode: 'graceful',
      },
      createTestContext()
    );
    const terminal = state.snapshot.currentRun;
    const outboxCount = state.outbox.length;

    const result = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_terminal',
        idempotencyKey: 'recover_terminal_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(result).toEqual({ status: 'rejected', reason: 'terminal_run' });
    expect(state.snapshot.currentRun).toBe(terminal);
    expect(state.outbox).toHaveLength(outboxCount);
  });

  it('rejects recovery when currentRunRef has advanced to another generation', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan({ topology: 'primary' });
    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
    state.forceCurrentRunRef(`run_${'7'.repeat(32)}`, plan.generation + 1);

    const result = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_stale',
        idempotencyKey: 'recover_stale_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(result).toEqual({ status: 'rejected', reason: 'stale_generation' });
    expect(test.backendRegistry.count('recover')).toBe(0);
  });

  it('recovers queued/running mixed lanes through their stored backend bindings', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan();
    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
    await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    const result = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_mixed',
        idempotencyKey: 'recover_mixed_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(result.status).toBe('recovering');
    expect(test.backendRegistry.count('recover', 'provisioning_cli')).toBe(1);
    expect(test.backendRegistry.count('recover', 'opencode')).toBe(1);
    expect(state.snapshot.currentRun?.plan).toBe(plan);
    expect(test.backendRegistry.count('launch', 'opencode')).toBe(1);
  });

  it('retains an interrupted stop goal and blocks unsafe successor effects', async () => {
    const state = new FakeTeamLifecycleCommandState();
    const test = harness(state);
    const plan = createTestRuntimePlan();
    await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
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
    await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_stop_before_recovery',
        idempotencyKey: 'stop_before_recovery_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
        mode: 'immediate',
      },
      createTestContext()
    );
    const launchCalls = test.backendRegistry.count('launch');

    const recovered = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_recover_interrupted_stop',
        idempotencyKey: 'recover_interrupted_stop_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
      },
      createTestContext()
    );

    expect(recovered.status).toBe('operator_required');
    expect(state.snapshot.currentRun?.status).toBe('operator_required');
    expect(state.snapshot.currentRun?.activeIntent).toBe('stop');
    expect(state.snapshot.currentRun?.drainMode).toBe('immediate');
    expect(test.backendRegistry.count('recover')).toBe(0);
    expect(
      state.snapshot.laneEffects.findLast(
        (effect) =>
          effect.kind === 'recover' && effect.laneId === parseLaneId('secondary:opencode:reviewer')
      )
    ).toMatchObject({
      state: 'ambiguous',
      evidence: {
        kind: 'ambiguous_evidence',
      },
    });
    expect(test.backendRegistry.count('launch')).toBe(launchCalls);
  });

  it('keeps legacy drain read/control-only and cuts over only after verified cleanup', async () => {
    const lifecycle = createTeamLifecycle({
      deploymentId: TEST_DEPLOYMENT_ID,
      teamId: TEST_TEAM_ID,
      fileWriterEpoch: 4,
      cutover: createLegacyRuntimeCutover([{ generation: 7, state: 'active' }]),
    });
    const state = new FakeTeamLifecycleCommandState(lifecycle);
    const test = harness(state);
    const plan = createTestRuntimePlan();

    const prepare = await test.feature.prepareProvisioning(
      { schemaVersion: 1, teamId: TEST_TEAM_ID, inputRevision: 1 },
      createTestContext()
    );
    const launch = await test.feature.launchTeam(launchRequest(state, plan), createTestContext());
    const status = await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: 7 },
      },
      createTestContext()
    );

    expect(prepare).toEqual({ status: 'rejected', reason: 'legacy_drain_active' });
    expect(launch).toEqual({ status: 'rejected', reason: 'legacy_drain_active' });
    expect(status).toMatchObject({ status: 'legacy', generation: 7, lifecycle: 'active' });
    expect(test.backendRegistry.count('launch')).toBe(0);

    test.legacyRuntime.cleanupVerified = false;
    const incomplete = await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_legacy_stop',
        idempotencyKey: 'legacy_stop_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: 7 },
        mode: 'graceful',
      },
      createTestContext()
    );
    expect(incomplete.status).toBe('recovering');
    expect(state.snapshot.lifecycle.cutover.mode).toBe('legacy_drain');

    test.legacyRuntime.cleanupVerified = true;
    const recovered = await test.feature.recoverTeamRun(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_legacy_recover',
        idempotencyKey: 'legacy_recover_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: 7 },
      },
      createTestContext()
    );
    expect(recovered.status).toBe('recovered');
    expect(state.snapshot.lifecycle.cutover.mode).toBe('canonical');
    expect(state.snapshot.lifecycle.lastGeneration).toBe(7);

    const nextPlan = createTestRuntimePlan({ generation: 8, runCharacter: '8' });
    const canonicalLaunch = await test.feature.launchTeam(
      launchRequest(state, nextPlan),
      createTestContext()
    );
    expect(canonicalLaunch.status).toBe('accepted');
    expect(state.snapshot.lifecycle.currentRunRef).toEqual({
      runId: nextPlan.runId,
      generation: 8,
    });
  });

  it('refuses ambiguous legacy candidates instead of selecting the newest generation', async () => {
    const lifecycle = createTeamLifecycle({
      deploymentId: TEST_DEPLOYMENT_ID,
      teamId: TEST_TEAM_ID,
      cutover: createLegacyRuntimeCutover([
        { generation: 8, state: 'active' },
        { generation: 9, state: 'active' },
      ]),
    });
    const state = new FakeTeamLifecycleCommandState(lifecycle);
    const test = harness(state);
    const plan = createTestRuntimePlan();

    const status = await test.feature.getProvisioningStatus(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        runRef: { runId: plan.runId, generation: 9 },
      },
      createTestContext()
    );
    const stop = await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_ambiguous_stop',
        idempotencyKey: 'ambiguous_stop_key',
        expectedLifecycleRevision: state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: 9 },
        mode: 'immediate',
      },
      createTestContext()
    );

    expect(status).toEqual({
      status: 'rejected',
      reason: 'legacy_generation_ambiguous',
    });
    expect(stop).toEqual({
      status: 'rejected',
      reason: 'legacy_generation_ambiguous',
    });
    expect(state.snapshot.lifecycle.cutover.mode).toBe('legacy_drain');
  });
});
