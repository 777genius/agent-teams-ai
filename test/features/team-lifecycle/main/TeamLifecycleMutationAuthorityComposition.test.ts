import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ApplicationCommandLedgerStatus,
  ApplicationCommandRunner,
} from '@features/application-command-ledger';
import {
  InternalStorageApplicationCommandLedgerStore,
  NodeApplicationCommandHasher,
} from '@features/application-command-ledger/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import {
  type LifecycleExecutionBackendRegistryPort,
  LifecycleLaneCoordinator,
  type LifecycleLaneExecutionScope,
  type LifecycleResolvedLaneBackend,
} from '@features/team-lifecycle';
import { createTeamLifecycleCommandFeature } from '@features/team-lifecycle/main';
import {
  ApplicationCommandLedgerLaneExecutionMutationAuthority,
  LANE_EXECUTION_MUTATION_NAMESPACE,
} from '@features/team-runtime-control/main/adapters/output/backends';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';
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
} from '../core/fixtures/FakeTeamLifecycleCommandState';

import type {
  LaneExecutionMutationAuthority,
  LaneExecutionMutationAuthorityRequest,
  LaneExecutionRef,
  LaneExecutionScope,
} from '@features/team-runtime-control/core/application/backends';

describe('team lifecycle mutation authority composition', () => {
  const cores: InternalStorageWorkerCore[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const core of cores.splice(0)) core.close();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  it('admits one distinct completed stop after a completed launch', async () => {
    const test = await harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });

    const launched = await test.feature.launchTeam(
      launchRequest(test.state, plan),
      createTestContext()
    );
    if (test.authorityErrors[0]) throw test.authorityErrors[0];
    expect(launched).toMatchObject({ status: 'accepted' });
    await expect(
      test.feature.stopTeam(
        {
          schemaVersion: 1,
          teamId: TEST_TEAM_ID,
          commandId: 'command_stop_after_completed_launch',
          idempotencyKey: 'stop_after_completed_launch_key',
          expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
          runRef: { runId: plan.runId, generation: plan.generation },
          mode: 'graceful',
        },
        createTestContext()
      )
    ).resolves.toMatchObject({ status: 'stopped' });

    const launch = test.state.snapshot.laneEffects.find((effect) => effect.kind === 'launch');
    const drain = test.state.snapshot.laneEffects.find((effect) => effect.kind === 'drain');
    expect(launch?.operationId).toMatch(/^launch:/);
    expect(drain?.operationId).toMatch(/^drain:/);
    expect(drain?.operationId).not.toBe(launch?.operationId);
    expect(drain?.causalPredecessor).toMatchObject({
      runRef: launch?.runRef,
      kind: 'launch',
      laneId: launch?.laneId,
      operationId: launch?.operationId,
    });
    expect(test.provider.count('launch')).toBe(1);
    expect(test.provider.count('stop')).toBe(1);
    expect(new Set(test.provider.operationIds).size).toBe(2);
    await expect(test.mutationRecords(plan)).resolves.toEqual([
      expect.objectContaining({ status: ApplicationCommandLedgerStatus.Completed }),
      expect.objectContaining({ status: ApplicationCommandLedgerStatus.Completed }),
    ]);
  });

  it('admits one distinct completed recover after a completed launch', async () => {
    const test = await harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });

    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());
    await expect(
      test.feature.recoverTeamRun(
        {
          schemaVersion: 1,
          teamId: TEST_TEAM_ID,
          commandId: 'command_recover_after_completed_launch',
          idempotencyKey: 'recover_after_completed_launch_key',
          expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
          runRef: { runId: plan.runId, generation: plan.generation },
        },
        createTestContext()
      )
    ).resolves.toMatchObject({ status: 'recovering' });

    const launch = test.state.snapshot.laneEffects.find((effect) => effect.kind === 'launch');
    const recover = test.state.snapshot.laneEffects.findLast((effect) => effect.kind === 'recover');
    expect(recover?.operationId).toMatch(/^recover:/);
    expect(recover?.operationId).not.toBe(launch?.operationId);
    expect(recover?.causalPredecessor).toMatchObject({
      operationId: launch?.operationId,
    });
    expect(test.provider.count('recover')).toBe(1);
    expect(new Set(test.provider.operationIds).size).toBe(2);
    await expect(test.mutationRecords(plan)).resolves.toHaveLength(2);
  });

  it('replays one immutable launch tuple after two settlement crashes and readiness changes', async () => {
    const test = await harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });
    test.state.failNextEffectCompletion = true;

    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());
    expect(test.provider.count('launch')).toBe(1);
    expect(test.state.snapshot.laneEffects[0]).toMatchObject({
      kind: 'launch',
      state: 'attempting',
      leaseFence: 1,
      providerMutations: {
        launch: {
          effectKind: 'launch',
          operationId: expect.stringMatching(/^launch:/),
          lease: { fence: 1 },
          readiness: {
            bindingRevision: 1,
            providerRevisions: expect.arrayContaining([
              expect.objectContaining({ capabilityRevision: 1 }),
            ]),
          },
        },
      },
    });
    const immutableLaunchMutation = test.state.snapshot.laneEffects[0]?.providerMutations.launch;
    test.provider.script('provisioning_cli', plan.lanes[0]!.laneId, 'preflight', {
      status: 'ready',
      readiness: {
        ...immutableLaunchMutation?.readiness,
        bindingRevision: 2,
        providerRevisions: [{ providerId: 'anthropic', capabilityRevision: 2 }],
      },
    });

    test.state.expireLaneEffectLeases();
    test.state.failNextEffectCompletion = true;
    await test.feature.recoverTeamRun(
      recoverRequest(test.state, plan, 'launch_settlement_crash_1'),
      createTestContext()
    );
    expect(test.provider.count('launch')).toBe(1);
    expect(test.provider.count('recover')).toBe(0);
    expect(test.provider.count('preflight')).toBe(1);
    expect(test.state.snapshot.laneEffects[0]).toMatchObject({
      state: 'attempting',
      leaseFence: 2,
      providerMutations: {
        launch: {
          lease: { fence: 1 },
        },
      },
    });
    expect(test.state.snapshot.laneEffects[0]?.providerMutations.launch).toBe(
      immutableLaunchMutation
    );
    expect(test.state.failedEffectSettlement?.expectedLease.fence).toBe(2);
    test.state.expireLaneEffectLeases();
    await test.feature.recoverTeamRun(
      recoverRequest(test.state, plan, 'launch_settlement_crash_2'),
      createTestContext()
    );

    expect(test.provider.count('launch')).toBe(1);
    expect(test.provider.count('recover')).toBe(0);
    expect(test.provider.count('preflight')).toBe(1);
    expect(test.provider.leaseFences).toEqual([1]);
    expect(new Set(test.provider.operationIds).size).toBe(1);
    expect(test.state.snapshot.laneEffects[0]).toMatchObject({
      state: 'observed_succeeded',
      leaseFence: 3,
      lease: null,
      providerMutations: {
        launch: {
          lease: { fence: 1 },
          readiness: immutableLaunchMutation?.readiness,
        },
      },
      evidence: {
        kind: 'launch_receipt',
        disposition: 'launched',
        leaseFence: 3,
      },
    });
    await expect(test.mutationRecords(plan)).resolves.toEqual([
      expect.objectContaining({
        commandId: immutableLaunchMutation?.operationId,
        status: ApplicationCommandLedgerStatus.Completed,
      }),
    ]);
  });

  it('replays one immutable stop tuple after two settlement crashes and lease expiries', async () => {
    const test = await harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });
    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());
    test.state.failNextEffectCompletion = true;

    await test.feature.stopTeam(
      {
        schemaVersion: 1,
        teamId: TEST_TEAM_ID,
        commandId: 'command_stop_with_settlement_crashes',
        idempotencyKey: 'stop_with_settlement_crashes_key',
        expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
        runRef: { runId: plan.runId, generation: plan.generation },
        mode: 'graceful',
      },
      createTestContext()
    );
    const drain = test.state.snapshot.laneEffects.find((effect) => effect.kind === 'drain');
    const immutableStopMutation = drain?.providerMutations.stop;
    expect(drain).toMatchObject({
      state: 'attempting',
      leaseFence: 2,
      providerMutations: {
        stop: {
          effectKind: 'stop',
          operationId: expect.stringMatching(/^drain:/),
          lease: { fence: 2 },
          mode: 'graceful',
        },
      },
    });

    test.state.expireLaneEffectLeases();
    test.state.failNextEffectCompletion = true;
    await test.feature.recoverTeamRun(
      recoverRequest(test.state, plan, 'stop_settlement_crash_1'),
      createTestContext()
    );
    expect(test.provider.count('stop')).toBe(1);
    expect(test.provider.count('recover')).toBe(0);
    expect(
      test.state.snapshot.laneEffects.find((effect) => effect.kind === 'drain')?.providerMutations
        .stop
    ).toBe(immutableStopMutation);
    expect(test.state.failedEffectSettlement?.expectedLease.fence).toBe(3);

    test.state.expireLaneEffectLeases();
    await test.feature.recoverTeamRun(
      recoverRequest(test.state, plan, 'stop_settlement_crash_2'),
      createTestContext()
    );

    expect(test.provider.count('stop')).toBe(1);
    expect(test.provider.count('recover')).toBe(0);
    expect(test.provider.leaseFences).toEqual([1, 2]);
    expect(test.state.snapshot.laneEffects.find((effect) => effect.kind === 'drain')).toMatchObject(
      {
        state: 'observed_succeeded',
        leaseFence: 4,
        lease: null,
        providerMutations: {
          stop: {
            lease: { fence: 2 },
            executionRef: immutableStopMutation?.executionRef,
            mode: immutableStopMutation?.mode,
          },
        },
        evidence: {
          kind: 'drain_receipt',
          disposition: 'stopped',
          leaseFence: 4,
        },
      }
    );
    await expect(test.mutationRecords(plan)).resolves.toEqual([
      expect.objectContaining({ status: ApplicationCommandLedgerStatus.Completed }),
      expect.objectContaining({
        commandId: immutableStopMutation?.operationId,
        status: ApplicationCommandLedgerStatus.Completed,
      }),
    ]);
  });

  it('rejects persisted provider mutation scope and backend mismatches before provider execution', async () => {
    const test = await harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });
    await test.feature.launchTeam(launchRequest(test.state, plan), createTestContext());
    const run = test.state.snapshot.currentRun;
    const mutation = test.state.snapshot.laneEffects[0]?.providerMutations.launch;
    if (!run || !mutation) throw new TypeError('expected persisted launch mutation');
    const providerCalls = test.provider.count('launch');

    const backendMismatch = Object.freeze({
      ...mutation,
      backend: 'opencode' as const,
    });
    await expect(
      test.workflowDependencies.lanes.launch(
        run,
        plan.lanes[0]!.laneId,
        backendMismatch,
        createTestContext().cancellation
      )
    ).resolves.toEqual({
      status: 'rejected',
      diagnostic: 'runtime-launch-provider_mutation_mismatch',
    });

    const scopeMismatch = Object.freeze({
      ...mutation,
      scope: Object.freeze({
        ...mutation.scope,
        requiredProviderIds: Object.freeze([
          ...mutation.scope.requiredProviderIds,
          'gemini' as const,
        ]),
      }),
    });
    await expect(
      test.workflowDependencies.lanes.launch(
        run,
        plan.lanes[0]!.laneId,
        scopeMismatch,
        createTestContext().cancellation
      )
    ).resolves.toEqual({
      status: 'rejected',
      diagnostic: 'runtime-launch-provider_mutation_mismatch',
    });
    expect(test.provider.count('launch')).toBe(providerCalls);
  });

  it.each([
    ['ambiguous', { status: 'operator_required' }],
    ['malformed', { status: 'launched' }],
  ] as const)('blocks a higher-fenced recover after an %s launch result', async (_name, result) => {
    const test = await harness();
    const plan = createTestRuntimePlan({ topology: 'primary' });
    test.provider.script('provisioning_cli', plan.lanes[0]!.laneId, 'launch', result);

    await expect(
      test.feature.launchTeam(launchRequest(test.state, plan), createTestContext())
    ).resolves.toMatchObject({ status: 'operator_required' });
    expect(test.provider.count('launch')).toBe(1);
    expect(test.state.snapshot.laneEffects[0]).toMatchObject({
      kind: 'launch',
      state: 'ambiguous',
      leaseFence: 1,
    });

    await expect(
      test.feature.recoverTeamRun(
        {
          schemaVersion: 1,
          teamId: TEST_TEAM_ID,
          commandId: `command_recover_after_${_name}_launch`,
          idempotencyKey: `recover_after_${_name}_launch_key`,
          expectedLifecycleRevision: test.state.snapshot.lifecycle.revision,
          runRef: { runId: plan.runId, generation: plan.generation },
        },
        createTestContext()
      )
    ).resolves.toMatchObject({ status: 'operator_required' });

    expect(test.provider.count('recover')).toBe(0);
    expect(
      test.state.snapshot.laneEffects.findLast((effect) => effect.kind === 'recover')
    ).toMatchObject({
      state: 'ambiguous',
      leaseFence: 2,
    });
    await expect(test.mutationRecords(plan)).resolves.toEqual([
      expect.objectContaining({
        status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
      }),
    ]);
  });

  async function harness() {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'team-lifecycle-mutation-authority-')
    );
    temporaryDirectories.push(temporaryDirectory);
    const core = new InternalStorageWorkerCore({
      databasePath: path.join(temporaryDirectory, 'storage', 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    cores.push(core);
    const ledger = new InternalStorageApplicationCommandLedgerStore(new InProcessGateway(core));
    const lifecycleClock = createTestClock();
    const runner = new ApplicationCommandRunner({
      ledger,
      hasher: new NodeApplicationCommandHasher(),
      clock: () => new Date(lifecycleClock.nowIso()),
    });
    const authority = new ApplicationCommandLedgerLaneExecutionMutationAuthority(runner);
    const provider = new FakeLifecycleBackendRegistry();
    const authorityErrors: unknown[] = [];
    const backendRegistry = ledgerBackedRegistry(provider, authority, (error) =>
      authorityErrors.push(error)
    );
    const state = new FakeTeamLifecycleCommandState();
    const ids = createTestIds();
    const fingerprint = new FakeTeamLifecycleFingerprint();
    const legacyRuntime = new FakeLegacyRuntimeDrain();
    const workflowDependencies = {
      state,
      lanes: new LifecycleLaneCoordinator(backendRegistry),
      clock: lifecycleClock,
      ids,
      fingerprint,
      legacyRuntime,
    };
    const feature = createTeamLifecycleCommandFeature({
      state,
      fingerprint,
      externalWriterBarrier: new FakeExternalWriterBarrier(),
      deadlines: new FakeLifecycleDeadline(),
      provisioningPreflight: new FakeProvisioningPreflight(),
      backendRegistry,
      legacyRuntime,
      clock: lifecycleClock,
      ids,
    });
    return {
      feature,
      provider,
      state,
      workflowDependencies,
      authorityErrors,
      mutationRecords: (plan: ReturnType<typeof createTestRuntimePlan>) =>
        ledger.listByScope({
          namespace: LANE_EXECUTION_MUTATION_NAMESPACE,
          scopeKey: [plan.teamId, plan.runId, String(plan.generation)].join(':'),
        }),
    };
  }
});

function launchRequest(
  state: FakeTeamLifecycleCommandState,
  plan: ReturnType<typeof createTestRuntimePlan>
) {
  return {
    schemaVersion: 1 as const,
    teamId: TEST_TEAM_ID,
    commandId: 'command_launch_with_real_mutation_ledger',
    idempotencyKey: 'launch_with_real_mutation_ledger_key',
    expectedLifecycleRevision: state.snapshot.lifecycle.revision,
    expectedCurrentRunRef: state.snapshot.lifecycle.currentRunRef,
    plan,
  };
}

function recoverRequest(
  state: FakeTeamLifecycleCommandState,
  plan: ReturnType<typeof createTestRuntimePlan>,
  suffix: string
) {
  return {
    schemaVersion: 1 as const,
    teamId: TEST_TEAM_ID,
    commandId: `command_recover_${suffix}`,
    idempotencyKey: `recover_${suffix}_key`,
    expectedLifecycleRevision: state.snapshot.lifecycle.revision,
    runRef: { runId: plan.runId, generation: plan.generation },
  };
}

function ledgerBackedRegistry(
  delegate: FakeLifecycleBackendRegistry,
  authority: LaneExecutionMutationAuthority,
  onError: (error: unknown) => void
): LifecycleExecutionBackendRegistryPort {
  return {
    resolve(plan, laneId) {
      const resolved = delegate.resolve(plan, laneId);
      if (resolved.status === 'rejected') return resolved;
      const backend = resolved.backend;
      const guarded: LifecycleResolvedLaneBackend = {
        backend: backend.backend,
        preflight: (request) => backend.preflight(request),
        observe: (request) => backend.observe(request),
        launch: (request) =>
          guardedMutation(
            authority,
            {
              backend: backend.backend,
              effectKind: 'launch',
              operationId: request.operationId,
              effectLease: request.effectLease,
              payload: {
                effectKind: 'launch',
                scope: laneExecutionScope(request.scope),
                readiness: request.readiness,
              },
            },
            () => backend.launch(request),
            { status: 'operator_required' },
            onError
          ),
        stop: (request) =>
          guardedMutation(
            authority,
            {
              backend: backend.backend,
              effectKind: 'stop',
              operationId: request.operationId,
              effectLease: request.effectLease,
              payload: {
                effectKind: 'stop',
                scope: laneExecutionScope(request.scope),
                executionRef: request.executionRef as LaneExecutionRef,
                mode: request.mode,
              },
            },
            () => backend.stop(request),
            { status: 'operator_required' },
            onError
          ),
        recover: (request) =>
          guardedMutation(
            authority,
            {
              backend: backend.backend,
              effectKind: 'recover',
              operationId: request.operationId,
              effectLease: request.effectLease,
              payload: {
                effectKind: 'recover',
                scope: laneExecutionScope(request.scope),
              },
            },
            () => backend.recover(request),
            { status: 'operator_required' },
            onError
          ),
      };
      return { ...resolved, backend: guarded };
    },
  };
}

async function guardedMutation<TResult>(
  authority: LaneExecutionMutationAuthority,
  request: LaneExecutionMutationAuthorityRequest,
  effect: () => Promise<TResult>,
  operatorRequired: TResult,
  onError: (error: unknown) => void
): Promise<TResult> {
  try {
    return await authority.execute(request, effect);
  } catch (error) {
    onError(error);
    return operatorRequired;
  }
}

function laneExecutionScope(scope: LifecycleLaneExecutionScope): LaneExecutionScope {
  return scope;
}
