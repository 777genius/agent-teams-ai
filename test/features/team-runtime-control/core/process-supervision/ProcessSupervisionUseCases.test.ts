import {
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseMainProcessIdentityRef,
  parseOwnedProcessRef,
  parseOwningProcessIdentityRef,
  parseProcessControllerInstanceId,
  parseSpawnNonce,
  PROCESS_OWNER_ATTESTATION_VERSION,
  type ProcessOwnershipScope,
} from '@features/team-runtime-control/contracts/processSupervision';
import {
  type CompositeRuntimePlanHash,
  parseExecutionUnitId,
  parseRuntimeBinaryId,
  type Sha256Hash,
} from '@features/team-runtime-control/contracts/runtimePlan';
import {
  CommitProcessOwnership,
  createProcessSupervisionDeadline,
  CreateSpawnIntent,
  type LiveProcessChannelInspection,
  type MonotonicClockPort,
  type OwnedProcessControlPort,
  type ProcessOwnershipCompareAndSwapRequest,
  type ProcessOwnershipCompareAndSwapResult,
  type ProcessOwnershipLoadResult,
  type ProcessOwnershipStoreContext,
  type ProcessOwnershipStorePort,
  RecoverProcessOwnership,
  StopOwnedProcess,
  type StopOwnedProcessEffectResult,
} from '@features/team-runtime-control/core/application/process-supervision';
import {
  beginOwnedProcessStop,
  computeCanonicalArgvDigest,
  computeCanonicalPolicyDigest,
  createSpawnIntent,
  initializeProcessOwnershipState,
  type ProcessOwnershipState,
  spawnNonceDigest,
} from '@features/team-runtime-control/core/domain/process-supervision';
import { parseRunId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type {
  RuntimeCancellation,
  RuntimeCancellationId,
} from '@features/team-runtime-control/core/application/ports';

const hash = (character: string): Sha256Hash => `sha256:${character.repeat(64)}`;

class FakeClock implements MonotonicClockPort {
  value = 0;
  now(): number {
    return this.value;
  }
}

class RealClock implements MonotonicClockPort {
  now(): number {
    return performance.now();
  }
}

const activeCancellation = (): RuntimeCancellation => ({
  cancellationId: 'cancel-active-000000001' as RuntimeCancellationId,
  isCancellationRequested: () => false,
});

function scope(suffix = 'a'): ProcessOwnershipScope {
  return {
    planRef: {
      teamId: parseTeamId(`team_${suffix.repeat(32)}`),
      runId: parseRunId(`run_${suffix.repeat(32)}`),
      generation: 1,
      planHash: hash(suffix) as CompositeRuntimePlanHash,
    },
    executionUnitId: parseExecutionUnitId(`unit-${suffix}`),
  };
}

function createRequest(
  context: ProcessOwnershipStoreContext,
  digest = computeCanonicalArgvDigest(['run'])
) {
  return {
    scope: scope(),
    processRef: parseOwnedProcessRef('process-ref-0000000000000001'),
    spawnNonce: parseSpawnNonce('spawn-nonce-0000000000000001'),
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
      registrationRevision: 1,
      bindingGeneration: 2,
      mountGeneration: 3,
    },
    binaryBinding: {
      policy: 'registered_exact_binary' as const,
      binaryId: parseRuntimeBinaryId('binary-safe'),
      binaryRevision: 1,
      binaryHash: hash('c'),
    },
    argv: ['run'],
    callerArgvDigest: digest,
    environmentPolicyDigest: computeCanonicalPolicyDigest({ names: ['SAFE'] }),
    relayScopeDigest: computeCanonicalPolicyDigest({ members: ['first', 'second'] }),
    context,
  };
}

class FakeStore implements ProcessOwnershipStorePort {
  state: ProcessOwnershipState | undefined;
  loads = 0;
  writes = 0;
  casResults: ('applied' | 'conflict' | 'unavailable')[] = [];
  unavailableLoad = false;
  onConflictApplyDesired = false;

  async load(): Promise<ProcessOwnershipLoadResult> {
    await Promise.resolve();
    this.loads += 1;
    if (this.unavailableLoad) return { status: 'unavailable' };
    return this.state ? { status: 'found', state: this.state } : { status: 'missing' };
  }

  async loadByProcessRef(): Promise<ProcessOwnershipLoadResult> {
    return await this.load();
  }

  async compareAndSwap(
    request: ProcessOwnershipCompareAndSwapRequest
  ): Promise<ProcessOwnershipCompareAndSwapResult> {
    await Promise.resolve();
    this.writes += 1;
    const scripted = this.casResults.shift();
    if (scripted === 'unavailable') return { status: 'unavailable' };
    if (scripted === 'conflict') {
      if (this.onConflictApplyDesired) this.state = request.next;
      return { status: 'conflict' };
    }
    const actualRevision = this.state?.revision ?? null;
    if (actualRevision !== request.expectedRevision) return { status: 'conflict' };
    this.state = request.next;
    return { status: 'applied', state: request.next };
  }
}

class FakeControl implements OwnedProcessControlPort {
  inspections = 0;
  stops = 0;
  inspection: LiveProcessChannelInspection = { status: 'live' };
  stopResult: StopOwnedProcessEffectResult = { status: 'timed_out' };

  async inspectLiveChannel(): Promise<LiveProcessChannelInspection> {
    await Promise.resolve();
    this.inspections += 1;
    return this.inspection;
  }

  async stopAndDrain(): Promise<StopOwnedProcessEffectResult> {
    await Promise.resolve();
    this.stops += 1;
    return this.stopResult;
  }
}

function context(clock = new FakeClock()): ProcessOwnershipStoreContext {
  return {
    deadline: createProcessSupervisionDeadline(clock, 100),
    clock,
    cancellation: activeCancellation(),
  };
}

async function committedState(store: FakeStore, clock: FakeClock) {
  const create = new CreateSpawnIntent(store);
  const created = await create.execute(createRequest(context(clock)));
  if (created.status === 'rejected') throw new Error('unexpected create rejection');
  const intent = created.state.intent;
  const proof = {
    processRef: intent.processRef,
    scope: intent.scope,
    workspaceBinding: intent.workspaceBinding,
    spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
    controllerInstanceId: parseProcessControllerInstanceId('controller-instance-00000001'),
    ownerAttestation: Object.freeze({
      attestationVersion: PROCESS_OWNER_ATTESTATION_VERSION,
      processRef: intent.processRef,
      scope: intent.scope,
      workspaceBinding: intent.workspaceBinding,
      spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
      channelRef: parseAnchorChannelRef('channel-ref-000000000000001'),
      owningProcessIdentityRef: parseOwningProcessIdentityRef('owner-identity-0000000000001'),
      anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-00000000001'),
    }),
    mainProcessIdentityRef: parseMainProcessIdentityRef('main-identity-0000000000001'),
    statusSequence: 1 as const,
  };
  const committed = await new CommitProcessOwnership(store).execute({
    scope: intent.scope,
    proof,
    context: context(clock),
  });
  if (committed.status === 'rejected') throw new Error('unexpected commit rejection');
  return committed.state;
}

describe('process supervision application use cases', () => {
  it('rejects forged argv before any durable read or CAS', async () => {
    const store = new FakeStore();
    const outcome = await new CreateSpawnIntent(store).execute(createRequest(context(), hash('f')));

    expect(outcome).toEqual({ status: 'rejected', reason: 'argv_digest_mismatch' });
    expect(store.loads).toBe(0);
    expect(store.writes).toBe(0);
  });

  it('bounds CAS conflicts and reconciles an exact concurrent durable intent', async () => {
    const store = new FakeStore();
    store.casResults = ['conflict'];
    store.onConflictApplyDesired = true;
    const outcome = await new CreateSpawnIntent(store).execute(createRequest(context()));

    expect(outcome.status).toBe('already_created');
    expect(store.loads).toBe(2);
    expect(store.writes).toBe(1);

    const alwaysConflict = new FakeStore();
    alwaysConflict.casResults = ['conflict', 'conflict', 'conflict'];
    const exhausted = await new CreateSpawnIntent(alwaysConflict).execute(createRequest(context()));
    expect(exhausted).toEqual({ status: 'rejected', reason: 'concurrency_conflict' });
    expect(alwaysConflict.writes).toBe(3);
  });

  it('returns explicit store-unavailable for load and every CAS stage', async () => {
    const loadFailure = new FakeStore();
    loadFailure.unavailableLoad = true;
    expect(await new CreateSpawnIntent(loadFailure).execute(createRequest(context()))).toEqual({
      status: 'rejected',
      reason: 'store_unavailable',
    });

    const casFailure = new FakeStore();
    casFailure.casResults = ['unavailable'];
    expect(await new CreateSpawnIntent(casFailure).execute(createRequest(context()))).toEqual({
      status: 'rejected',
      reason: 'store_unavailable',
    });
  });

  it('does not adopt an owned record after its exact live channel is lost', async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    await committedState(store, clock);
    const control = new FakeControl();
    control.inspection = { status: 'lost' };

    const recovered = await new RecoverProcessOwnership(store, control, clock).execute({
      ...scope(),
      timeoutMs: 100,
      cancellation: activeCancellation(),
    });

    expect(recovered).toEqual({ status: 'operator_required' });
    expect(control.inspections).toBe(1);
    expect(store.state?.phase).toBe('unclassified_residual');
  });

  it('does not report recovery when channel inspection crosses the end-to-end deadline', async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    await committedState(store, clock);
    const control = new FakeControl();
    control.inspectLiveChannel = async () => {
      await Promise.resolve();
      control.inspections += 1;
      clock.value = 101;
      return { status: 'live' };
    };

    const recovered = await new RecoverProcessOwnership(store, control, clock).execute({
      ...scope(),
      timeoutMs: 100,
      cancellation: activeCancellation(),
    });

    expect(recovered).toEqual({ status: 'operator_required' });
    expect(control.inspections).toBe(1);
    expect(store.state?.phase).toBe('unclassified_residual');
  });

  it('fences a reused identity by exact plan/unit/ref before any stop effect', async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const state = await committedState(store, clock);
    const control = new FakeControl();
    const ownership = state.ownership;

    const outcome = await new StopOwnedProcess(store, control, clock).execute({
      ...scope('d'),
      processRef: ownership.processRef,
      mode: 'immediate',
      timeoutMs: 100,
      cancellation: activeCancellation(),
    });

    expect(outcome).toEqual({ status: 'rejected', reason: 'ownership_conflict' });
    expect(control.stops).toBe(0);
  });

  it('fails closed when a marked stop effect times out instead of retrying or falling back', async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const state = await committedState(store, clock);
    const control = new FakeControl();
    control.stopResult = { status: 'timed_out' };

    const outcome = await new StopOwnedProcess(store, control, clock).execute({
      ...scope(),
      processRef: state.intent.processRef,
      mode: 'graceful',
      timeoutMs: 100,
      cancellation: activeCancellation(),
    });

    expect(outcome).toEqual({ status: 'unclassified_residual' });
    expect(control.stops).toBe(1);
    expect(store.state?.phase).toBe('unclassified_residual');
  });

  it('never emits a second stop effect from an already-stopping durable state', async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const state = await committedState(store, clock);
    const transition = beginOwnedProcessStop(state, {
      ...scope(),
      processRef: state.intent.processRef,
    });
    if (transition.status !== 'accepted' || transition.next.phase !== 'stopping') {
      throw new Error('expected stopping fixture');
    }
    store.state = transition.next;
    const control = new FakeControl();

    const outcome = await new StopOwnedProcess(store, control, clock).execute({
      ...scope(),
      processRef: state.intent.processRef,
      mode: 'immediate',
      timeoutMs: 100,
      cancellation: activeCancellation(),
    });

    expect(outcome).toEqual({ status: 'already_stopping' });
    expect(control.stops).toBe(0);
    expect(store.state).toBe(transition.next);
  });

  it('never reports a stopping owner as recovered even when its attested channel is live', async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const state = await committedState(store, clock);
    const transition = beginOwnedProcessStop(state, {
      ...scope(),
      processRef: state.intent.processRef,
    });
    if (transition.status !== 'accepted' || transition.next.phase !== 'stopping') {
      throw new Error('expected stopping fixture');
    }
    store.state = transition.next;
    const control = new FakeControl();

    const outcome = await new RecoverProcessOwnership(store, control, clock).execute({
      ...scope(),
      timeoutMs: 100,
      cancellation: activeCancellation(),
    });

    expect(outcome).toEqual({ status: 'operator_required' });
    expect(control.inspections).toBe(1);
    expect(store.state).toBe(transition.next);
  });

  it('times out a hung ownership store under the original absolute deadline', async () => {
    const clock = new RealClock();
    const store = new FakeStore();
    store.load = async () => await new Promise<never>(() => undefined);
    const deadline = createProcessSupervisionDeadline(clock, 8);

    const outcome = await new CreateSpawnIntent(store).execute(
      createRequest({ deadline, clock, cancellation: activeCancellation() })
    );

    expect(outcome).toEqual({ status: 'rejected', reason: 'timed_out' });
    expect(store.writes).toBe(0);
  });

  it('reloads and reconciles a CAS conflict after typed drain evidence', async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const state = await committedState(store, clock);
    const control = new FakeControl();
    control.stopResult = {
      status: 'drained',
      proof: {
        processRef: state.ownership.processRef,
        scope: state.ownership.scope,
        spawnNonceDigest: state.ownership.spawnNonceDigest,
        ownerAttestation: state.ownership.ownerAttestation,
        ownedProcessEof: {
          processRef: state.ownership.processRef,
          ownerAttestation: state.ownership.ownerAttestation,
          observed: true,
        },
        statusSequence: 2,
        outcome: 'drained',
        residuals: [],
      },
    };
    store.casResults = ['applied', 'conflict'];
    store.onConflictApplyDesired = true;

    const outcome = await new StopOwnedProcess(store, control, clock).execute({
      ...scope(),
      processRef: state.intent.processRef,
      mode: 'graceful',
      timeoutMs: 100,
      cancellation: activeCancellation(),
    });

    expect(outcome).toEqual({ status: 'drained' });
    expect(store.state?.phase).toBe('drained');
  });

  it('persists fail-closed state when the stop-marker CAS outcome is unavailable', async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const state = await committedState(store, clock);
    const control = new FakeControl();
    store.casResults = ['unavailable'];

    const outcome = await new StopOwnedProcess(store, control, clock).execute({
      ...scope(),
      processRef: state.intent.processRef,
      mode: 'immediate',
      timeoutMs: 100,
      cancellation: activeCancellation(),
    });

    expect(outcome).toEqual({ status: 'unclassified_residual' });
    expect(control.stops).toBe(0);
    expect(store.state?.phase).toBe('unclassified_residual');
  });

  it('does not infer ownership from a pending durable intent during restart recovery', async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.state = initializeProcessOwnershipState(createSpawnIntent(createRequest(context(clock))));
    const control = new FakeControl();

    const outcome = await new RecoverProcessOwnership(store, control, clock).execute({
      ...scope(),
      timeoutMs: 100,
      cancellation: activeCancellation(),
    });

    expect(outcome).toEqual({ status: 'operator_required' });
    expect(control.inspections).toBe(0);
    expect(store.state.phase).toBe('unclassified_residual');
  });
});
