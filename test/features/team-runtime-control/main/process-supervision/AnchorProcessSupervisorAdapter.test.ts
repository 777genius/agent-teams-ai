import {
  type AnchorChannelRef,
  type OwnedProcessRef,
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseOwnedProcessRef,
  parseOwningProcessIdentityRef,
  parseProcessControllerInstanceId,
  parseSpawnNonce,
  PROCESS_OWNER_ATTESTATION_VERSION,
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
} from '@features/team-runtime-control/contracts/processSupervision';
import {
  type CompositeRuntimePlanHash,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  type ProcessExecutionUnit,
  type Sha256Hash,
} from '@features/team-runtime-control/contracts/runtimePlan';
import {
  computeCanonicalArgvDigest,
  type ProcessOwnershipState,
  spawnNonceDigest,
} from '@features/team-runtime-control/core/domain/process-supervision';
import {
  AnchorProcessSupervisorAdapter,
  type AnchorSpawnPort,
  type AnchorSpawnRequest,
  type AttestedOwningProcessPort,
} from '@features/team-runtime-control/main/adapters/output/process-supervision';
import { parseRunId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type {
  ResolvedEnvironmentAuthorityRef,
  ResolvedExecutableAuthorityRef,
  ResolvedWorkdirAuthorityRef,
  RuntimeCancellation,
  RuntimeCancellationId,
  WorkspaceExecutionGrantId,
} from '@features/team-runtime-control/core/application/ports';
import type {
  MonotonicClockPort,
  ProcessIdentityFactoryPort,
  ProcessOwnershipCompareAndSwapRequest,
  ProcessOwnershipCompareAndSwapResult,
  ProcessOwnershipLoadResult,
  ProcessOwnershipStoreContext,
  ProcessOwnershipStorePort,
} from '@features/team-runtime-control/core/application/process-supervision';
import type {
  NodeAnchorControlSink,
  NodeAnchorStatusSource,
} from '@features/team-runtime-control/main/infrastructure/process-supervision';

const hash = (character: string): Sha256Hash => `sha256:${character.repeat(64)}`;

class FakeClock implements MonotonicClockPort {
  value = 0;
  now(): number {
    return this.value;
  }
  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

class RealClock implements MonotonicClockPort {
  now(): number {
    return performance.now();
  }
}

class FakeStore implements ProcessOwnershipStorePort {
  state: ProcessOwnershipState | undefined;
  readonly events: string[] = [];
  loads = 0;
  writes = 0;
  readonly deadlines: number[] = [];
  onOperation: (() => void) | undefined;
  onStoppingApplied: (() => void) | undefined;

  async load(
    _scope: unknown,
    context: ProcessOwnershipStoreContext
  ): Promise<ProcessOwnershipLoadResult> {
    await Promise.resolve();
    this.deadlines.push(context.deadline.expiresAt);
    this.onOperation?.();
    this.loads += 1;
    return this.state ? { status: 'found', state: this.state } : { status: 'missing' };
  }

  async loadByProcessRef(
    processRef: OwnedProcessRef,
    context: ProcessOwnershipStoreContext
  ): Promise<ProcessOwnershipLoadResult> {
    await Promise.resolve();
    this.deadlines.push(context.deadline.expiresAt);
    this.onOperation?.();
    this.loads += 1;
    return this.state?.intent.processRef === processRef
      ? { status: 'found', state: this.state }
      : { status: 'missing' };
  }

  async compareAndSwap(
    request: ProcessOwnershipCompareAndSwapRequest
  ): Promise<ProcessOwnershipCompareAndSwapResult> {
    await Promise.resolve();
    this.deadlines.push(request.context.deadline.expiresAt);
    this.onOperation?.();
    this.writes += 1;
    const actualRevision = this.state?.revision ?? null;
    if (actualRevision !== request.expectedRevision) return { status: 'conflict' };
    this.state = request.next;
    if (request.next.phase === 'spawn_intent') this.events.push('intent-persisted');
    if (request.next.phase === 'stopping') this.onStoppingApplied?.();
    return { status: 'applied', state: request.next };
  }
}

class FakeIdentities implements ProcessIdentityFactoryPort {
  calls = 0;
  createProcessRef(): OwnedProcessRef {
    this.calls += 1;
    return parseOwnedProcessRef('process-ref-0000000000000001');
  }
  createSpawnNonce() {
    this.calls += 1;
    return parseSpawnNonce('spawn-nonce-0000000000000001');
  }
}

class RotatingIdentities implements ProcessIdentityFactoryPort {
  private generation = 1;

  createProcessRef(): OwnedProcessRef {
    return parseOwnedProcessRef(`process-ref-${String(this.generation).padStart(16, '0')}`);
  }

  createSpawnNonce() {
    const nonce = parseSpawnNonce(`spawn-nonce-${String(this.generation).padStart(16, '0')}`);
    this.generation += 1;
    return nonce;
  }
}

class FakeControlSink implements NodeAnchorControlSink {
  readonly writes: { bytes: Uint8Array; remainingTimeMs: number }[] = [];
  readonly closes: number[] = [];

  constructor(
    private readonly clock: FakeClock | RealClock,
    private readonly advanceWriteMs = 0,
    private readonly advanceCloseMs = 0
  ) {}

  async write(bytes: Uint8Array, options: { readonly remainingTimeMs: number }): Promise<void> {
    await Promise.resolve();
    this.writes.push({ bytes, remainingTimeMs: options.remainingTimeMs });
    if (this.clock instanceof FakeClock) this.clock.advance(this.advanceWriteMs);
  }

  async close(options: { readonly remainingTimeMs: number }): Promise<void> {
    await Promise.resolve();
    this.closes.push(options.remainingTimeMs);
    if (this.clock instanceof FakeClock) this.clock.advance(this.advanceCloseMs);
  }
}

class FakeStatusSource implements NodeAnchorStatusSource {
  readonly remainingTimes: number[] = [];
  inspectionStatus: 'live' | 'eof' | 'unavailable' = 'live';

  constructor(
    private readonly chunks: Uint8Array[],
    private readonly clock: FakeClock | RealClock,
    private readonly advanceReadMs = 0
  ) {}

  async inspect(options: { readonly remainingTimeMs: number }) {
    await Promise.resolve();
    this.remainingTimes.push(options.remainingTimeMs);
    return { status: this.inspectionStatus };
  }

  async read(options: { readonly remainingTimeMs: number }) {
    await Promise.resolve();
    this.remainingTimes.push(options.remainingTimeMs);
    if (this.clock instanceof FakeClock) this.clock.advance(this.advanceReadMs);
    const bytes = this.chunks.shift();
    return bytes
      ? ({ status: 'chunk' as const, bytes } as const)
      : ({ status: 'eof' as const } as const);
  }
}

class FakeOwningProcess implements AttestedOwningProcessPort {
  readonly inspectRemainingTimes: number[] = [];
  readonly eofRemainingTimes: number[] = [];
  inspectionStatus: 'live' | 'eof' | 'mismatch' | 'unavailable' = 'live';
  eofStatus: 'eof' | 'mismatch' | 'unavailable' = 'eof';
  forgeInspectionAttestation = false;
  waitForEofGate: Promise<void> | undefined;

  async inspect(options: {
    readonly attestation: Parameters<AttestedOwningProcessPort['inspect']>[0]['attestation'];
    readonly remainingTimeMs: number;
  }) {
    await Promise.resolve();
    this.inspectRemainingTimes.push(options.remainingTimeMs);
    return this.inspectionStatus === 'live' || this.inspectionStatus === 'eof'
      ? {
          status: this.inspectionStatus,
          ownerAttestation: this.forgeInspectionAttestation
            ? {
                ...options.attestation,
                anchorIdentityRef: parseAnchorIdentityRef('forged-anchor-identity-00001'),
              }
            : options.attestation,
        }
      : { status: this.inspectionStatus };
  }

  async waitForEof(options: {
    readonly attestation: Parameters<AttestedOwningProcessPort['waitForEof']>[0]['attestation'];
    readonly remainingTimeMs: number;
  }) {
    this.eofRemainingTimes.push(options.remainingTimeMs);
    await this.waitForEofGate;
    return this.eofStatus === 'eof'
      ? { status: 'eof' as const, ownerAttestation: options.attestation }
      : { status: this.eofStatus };
  }
}

class FakeSpawner implements AnchorSpawnPort {
  calls = 0;
  readonly requests: AnchorSpawnRequest[] = [];
  readonly remainingTimes: number[] = [];
  sink?: FakeControlSink;
  source?: FakeStatusSource;
  owner?: FakeOwningProcess;
  hang = false;
  advanceWriteMs = 0;
  advanceReadMs = 0;
  advanceCloseMs = 0;
  advanceSpawnMs = 0;
  ownerAnchorIdentityRef = parseAnchorIdentityRef('anchor-identity-00000000001');
  readonly fakeReusedNativePid = 42_424;

  constructor(
    private readonly store: FakeStore,
    private readonly clock: FakeClock | RealClock,
    private readonly channelRef: AnchorChannelRef = parseAnchorChannelRef(
      'channel-ref-000000000000001'
    )
  ) {}

  async spawn(request: AnchorSpawnRequest, options: { readonly remainingTimeMs: number }) {
    this.calls += 1;
    this.requests.push(request);
    this.remainingTimes.push(options.remainingTimeMs);
    this.store.events.push('spawn-called');
    if (this.hang) return await new Promise<never>(() => undefined);
    if (this.clock instanceof FakeClock) this.clock.advance(this.advanceSpawnMs);

    this.sink = new FakeControlSink(this.clock, this.advanceWriteMs, this.advanceCloseMs);
    const common = wireCommon(request, this.channelRef);
    const ready = encodeFrame({
      ...common,
      type: 'ready',
      sequence: 1,
      workspaceBinding: request.intent.workspaceBinding,
      anchorIdentityRef: 'anchor-identity-00000000001',
      mainProcessIdentityRef: 'main-identity-0000000000001',
    });
    const drained = encodeFrame({
      ...common,
      type: 'drained',
      sequence: 2,
      outcome: 'drained',
      residuals: [],
    });
    this.source = new FakeStatusSource([ready, drained], this.clock, this.advanceReadMs);
    this.owner = new FakeOwningProcess();
    const ownerAttestation = Object.freeze({
      attestationVersion: PROCESS_OWNER_ATTESTATION_VERSION,
      processRef: request.intent.processRef,
      scope: request.intent.scope,
      workspaceBinding: request.intent.workspaceBinding,
      spawnNonceDigest: spawnNonceDigest(request.intent.spawnNonce),
      channelRef: this.channelRef,
      owningProcessIdentityRef: parseOwningProcessIdentityRef('owner-identity-0000000000001'),
      anchorIdentityRef: this.ownerAnchorIdentityRef,
    });
    return {
      status: 'spawned' as const,
      channelRef: this.channelRef,
      controlSink: this.sink,
      statusSource: this.source,
      ownerAttestation,
      owningProcess: this.owner,
      fakeReusedNativePid: this.fakeReusedNativePid,
    };
  }
}

function wireCommon(request: AnchorSpawnRequest, channelRef: AnchorChannelRef) {
  return {
    protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
    processRef: request.intent.processRef,
    teamId: request.intent.scope.planRef.teamId,
    runId: request.intent.scope.planRef.runId,
    generation: request.intent.scope.planRef.generation,
    planHash: request.intent.scope.planRef.planHash,
    executionUnitId: request.intent.scope.executionUnitId,
    spawnNonceDigest: spawnNonceDigest(request.intent.spawnNonce),
    channelRef,
  };
}

function encodeFrame(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

const activeCancellation = (): RuntimeCancellation => ({
  cancellationId: 'active-cancellation-000001' as RuntimeCancellationId,
  isCancellationRequested: () => false,
});

function executionFixture(argvHash?: Sha256Hash) {
  const argv = ['serve', '--exact'];
  const workspaceBinding = {
    workspaceId: parseWorkspaceId(`workspace_${'e'.repeat(32)}`),
    registrationRevision: 2,
    bindingGeneration: 3,
    mountGeneration: 4,
  };
  const executionUnit: ProcessExecutionUnit = {
    executionUnitId: parseExecutionUnitId('unit-primary'),
    backendBinding: {
      backend: 'provisioning_cli',
      bindingId: parseRuntimeBackendBindingId('backend-provisioning'),
      bindingRevision: 1,
    },
    laneId: parseLaneId('primary'),
    memberIds: [],
    binaryPolicy: {
      policy: 'registered_exact_binary',
      binaryId: parseRuntimeBinaryId('binary-provider'),
      binaryRevision: 2,
      binaryHash: hash('b'),
    },
    environmentPolicy: {
      policy: 'explicit_allowlist',
      variables: [{ name: 'SAFE_RUNTIME_ID', provenance: 'runtime_metadata' }],
    },
    credentialExposureSet: { secretRefs: [] },
    credentialIsolation: 'shared_execution_unit',
    resourcePolicy: {
      maxRuntimeMs: 10_000,
      gracefulStopMs: 25,
      maxOutputBytes: 100_000,
      maxProcessCount: 2,
    },
  };
  const planRef = {
    teamId: parseTeamId(`team_${'a'.repeat(32)}`),
    runId: parseRunId(`run_${'b'.repeat(32)}`),
    generation: 5,
    planHash: hash('c') as CompositeRuntimePlanHash,
  };
  const launchSpec = {
    planRef,
    executionUnitId: executionUnit.executionUnitId,
    backend: executionUnit.backendBinding.backend,
    argvAuthority: {
      executableRef: 'executable-authority-0001' as ResolvedExecutableAuthorityRef,
      binaryPolicy: executionUnit.binaryPolicy,
      argv,
      argvHash: argvHash ?? computeCanonicalArgvDigest(argv),
    },
    workdirAuthority: {
      workdirRef: 'workdir-authority-000001' as ResolvedWorkdirAuthorityRef,
      grant: {
        grantId: 'workspace-grant-0000001' as WorkspaceExecutionGrantId,
        ...workspaceBinding,
        permission: 'execute_process' as const,
      },
    },
    environmentAuthority: {
      environmentRef: 'environment-authority-01' as ResolvedEnvironmentAuthorityRef,
      policy: executionUnit.environmentPolicy,
    },
    resourcePolicy: executionUnit.resourcePolicy,
  };
  return { executionUnit, launchSpec, cancellation: activeCancellation() };
}

function createAdapter(
  store: FakeStore,
  identities: ProcessIdentityFactoryPort,
  spawner: FakeSpawner,
  clock: MonotonicClockPort,
  controller = 'controller-instance-00000001',
  launchTimeoutMs = 100
) {
  return new AnchorProcessSupervisorAdapter({
    store,
    identities,
    spawner,
    clock,
    controllerInstanceId: parseProcessControllerInstanceId(controller),
    launchTimeoutMs,
    stopTimeoutMs: 100,
    recoveryTimeoutMs: 100,
  });
}

describe('AnchorProcessSupervisorAdapter', () => {
  it('persists intent before spawn and passes only direct, non-inheriting launch authority', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const identities = new FakeIdentities();
    const spawner = new FakeSpawner(store, clock);
    store.onOperation = () => clock.advance(5);
    const adapter = createAdapter(store, identities, spawner, clock);
    const fixture = executionFixture();

    const started = await adapter.start(fixture);

    expect(started).toEqual({
      status: 'started',
      processRef: 'process-ref-0000000000000001',
    });
    expect(store.events.slice(0, 2)).toEqual(['intent-persisted', 'spawn-called']);
    expect(spawner.remainingTimes).toEqual([90]);
    expect(spawner.requests[0]).toMatchObject({
      shell: false,
      inheritParentEnvironment: false,
      closeUndeclaredDescriptors: true,
      argv: ['serve', '--exact'],
      resourcePolicy: { maxOutputBytes: 100_000 },
    });
    expect(JSON.stringify(store.state)).not.toContain('serve');
    expect(JSON.stringify(store.state)).not.toContain('workspace-grant');
    expect(JSON.stringify(spawner.requests[0])).not.toContain('process.env');
    expect(JSON.stringify(spawner.requests[0])).not.toContain('cwd');
    if (store.state?.phase !== 'owned') throw new Error('expected durable ownership');
    expect(Object.isFrozen(store.state.ownership.ownerAttestation)).toBe(true);
    expect(JSON.stringify(store.state.ownership)).not.toContain('argvDigest');
  });

  it('retains the first durable spawn identity across a repeated start request', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, new RotatingIdentities(), spawner, clock);
    const fixture = executionFixture();

    const first = await adapter.start(fixture);
    const repeated = await adapter.start(fixture);

    expect(first).toEqual({
      status: 'started',
      processRef: 'process-ref-0000000000000001',
    });
    expect(repeated).toEqual({
      status: 'already_started',
      processRef: 'process-ref-0000000000000001',
    });
    expect(spawner.calls).toBe(1);
    expect(store.state?.intent.processRef).toBe('process-ref-0000000000000001');
  });

  it('rejects child ready evidence that is not bound to the immutable spawn-owner attestation', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    spawner.ownerAnchorIdentityRef = parseAnchorIdentityRef('forged-anchor-identity-00001');
    const adapter = createAdapter(store, new FakeIdentities(), spawner, clock);

    const result = await adapter.start(executionFixture());

    expect(result).toEqual({ status: 'rejected', reason: 'unavailable' });
    expect(store.state?.phase).toBe('unclassified_residual');
    expect(store.state && 'ownership' in store.state).toBe(false);
  });

  it('rejects argv forgery before IDs, store, or spawn effects', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const identities = new FakeIdentities();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, identities, spawner, clock);

    const result = await adapter.start(executionFixture(hash('f')));

    expect(result).toEqual({ status: 'rejected', reason: 'not_owned' });
    expect(identities.calls).toBe(0);
    expect(store.loads).toBe(0);
    expect(store.writes).toBe(0);
    expect(spawner.calls).toBe(0);
  });

  it('uses one decreasing stop deadline across control write, fragmented drain, and close', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const identities = new FakeIdentities();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, identities, spawner, clock);
    const fixture = executionFixture();
    const started = await adapter.start(fixture);
    if (started.status !== 'started') throw new Error('expected fake start');
    if (!spawner.source || !spawner.sink || !spawner.owner) {
      throw new Error('missing fake channel');
    }

    spawner.advanceWriteMs = 10;
    spawner.advanceReadMs = 20;
    spawner.advanceCloseMs = 5;
    // Existing fakes capture their configured advances, so apply them directly for this stop.
    const sink = spawner.sink;
    const source = spawner.source;
    const owner = spawner.owner;
    const originalWrite = sink.write.bind(sink);
    sink.write = async (bytes, options) => {
      await originalWrite(bytes, options);
      clock.advance(10);
    };
    const originalRead = source.read.bind(source);
    source.read = async (options) => {
      const result = await originalRead(options);
      clock.advance(20);
      return result;
    };

    const stopped = await adapter.stop({
      planRef: fixture.launchSpec.planRef,
      executionUnitId: fixture.executionUnit.executionUnitId,
      processRef: started.processRef,
      mode: 'graceful',
      cancellation: activeCancellation(),
    });

    expect(stopped).toEqual({ status: 'drained' });
    expect(sink.writes[0]?.remainingTimeMs).toBe(100);
    expect(source.remainingTimes.slice(-2)).toEqual([90, 70]);
    expect(owner.eofRemainingTimes).toEqual([50]);
    expect(sink.closes[0]).toBe(50);
    const controlText = new TextDecoder().decode(sink.writes[0]?.bytes);
    expect(controlText).toContain('"type":"stop"');
    expect(JSON.parse(controlText)).toMatchObject({ graceMs: 25 });
    expect(controlText).not.toMatch(/\bpid|pgid|shell|environment/i);
  });

  it('uses one bounded persistence grace when the stop deadline expires after its durable marker', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, new FakeIdentities(), spawner, clock);
    const fixture = executionFixture();
    const started = await adapter.start(fixture);
    if (started.status !== 'started' || !spawner.sink) throw new Error('expected fake start');
    const originalWrite = spawner.sink.write.bind(spawner.sink);
    spawner.sink.write = async (frame, options) => {
      await originalWrite(frame, options);
      clock.advance(101);
    };

    const outcome = await adapter.stop({
      planRef: fixture.launchSpec.planRef,
      executionUnitId: fixture.executionUnit.executionUnitId,
      processRef: started.processRef,
      mode: 'graceful',
      cancellation: activeCancellation(),
    });

    expect(outcome).toEqual({ status: 'unclassified_residual' });
    expect(spawner.sink.writes).toHaveLength(1);
    expect(store.state?.phase).toBe('unclassified_residual');
    expect(new Set(store.deadlines)).toEqual(new Set([100, 201]));
  });

  it('types a hung spawn as unavailable and terminalizes intent within a bounded persistence grace', async () => {
    const store = new FakeStore();
    const clock = new RealClock();
    const identities = new FakeIdentities();
    const spawner = new FakeSpawner(store, clock);
    spawner.hang = true;
    const adapter = createAdapter(store, identities, spawner, clock, undefined, 8);

    const outcome = await adapter.start(executionFixture());

    expect(outcome).toEqual({ status: 'rejected', reason: 'unavailable' });
    expect(store.events.slice(0, 2)).toEqual(['intent-persisted', 'spawn-called']);
    expect(store.state?.phase).toBe('unclassified_residual');
    expect(store.state?.intent.processRef).toBe('process-ref-0000000000000001');
    expect(new Set(store.deadlines).size).toBe(2);
  });

  it('deterministically persists fail-closed state after the launch deadline expires', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    spawner.advanceSpawnMs = 11;
    const adapter = createAdapter(store, new FakeIdentities(), spawner, clock, undefined, 10);

    const outcome = await adapter.start(executionFixture());

    expect(outcome).toEqual({ status: 'rejected', reason: 'unavailable' });
    expect(store.state?.phase).toBe('unclassified_residual');
    expect(new Set(store.deadlines)).toEqual(new Set([10, 111]));
  });

  it('does not adopt a prior controller channel after restart or fake PID reuse', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const firstSpawner = new FakeSpawner(store, clock);
    const first = createAdapter(store, new FakeIdentities(), firstSpawner, clock);
    const fixture = executionFixture();
    const started = await first.start(fixture);
    if (started.status !== 'started') throw new Error('expected fake start');

    const replacementSpawner = new FakeSpawner(store, clock);
    const replacement = createAdapter(
      store,
      new FakeIdentities(),
      replacementSpawner,
      clock,
      'controller-instance-00000002'
    );
    const recovered = await replacement.recover({
      planRef: fixture.launchSpec.planRef,
      executionUnit: fixture.executionUnit,
      cancellation: activeCancellation(),
    });

    expect(recovered).toEqual({ status: 'operator_required' });
    expect(replacementSpawner.calls).toBe(0);
    expect(replacementSpawner.fakeReusedNativePid).toBe(firstSpawner.fakeReusedNativePid);
    expect(store.state?.phase).toBe('unclassified_residual');
  });

  it('does not report ready or recovered after the attested owning process reaches EOF', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, new FakeIdentities(), spawner, clock);
    const fixture = executionFixture();
    const started = await adapter.start(fixture);
    if (started.status !== 'started' || !spawner.owner) throw new Error('expected fake start');
    spawner.owner.inspectionStatus = 'eof';

    const observed = await adapter.observe({
      planRef: fixture.launchSpec.planRef,
      executionUnitId: fixture.executionUnit.executionUnitId,
      processRef: started.processRef,
    });
    const recovered = await adapter.recover({
      planRef: fixture.launchSpec.planRef,
      executionUnit: fixture.executionUnit,
      cancellation: activeCancellation(),
    });

    expect(observed).toEqual({ status: 'unclassified_residual' });
    expect(recovered).toEqual({ status: 'operator_required' });
    expect(store.state?.phase).toBe('unclassified_residual');
  });

  it('does not report ready or recovered when the exclusive anchor status channel is EOF', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, new FakeIdentities(), spawner, clock);
    const fixture = executionFixture();
    const started = await adapter.start(fixture);
    if (started.status !== 'started' || !spawner.source || !spawner.owner) {
      throw new Error('expected fake start');
    }
    spawner.source.inspectionStatus = 'eof';

    const observed = await adapter.observe({
      planRef: fixture.launchSpec.planRef,
      executionUnitId: fixture.executionUnit.executionUnitId,
      processRef: started.processRef,
    });
    const recovered = await adapter.recover({
      planRef: fixture.launchSpec.planRef,
      executionUnit: fixture.executionUnit,
      cancellation: activeCancellation(),
    });

    expect(observed).toEqual({ status: 'unclassified_residual' });
    expect(recovered).toEqual({ status: 'operator_required' });
    expect(spawner.owner.inspectRemainingTimes).toHaveLength(0);
    expect(store.state?.phase).toBe('unclassified_residual');
  });

  it('does not accept a live inspection with a changed owner-attestation identity', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, new FakeIdentities(), spawner, clock);
    const fixture = executionFixture();
    const started = await adapter.start(fixture);
    if (started.status !== 'started' || !spawner.owner) throw new Error('expected fake start');
    spawner.owner.forgeInspectionAttestation = true;

    const observed = await adapter.observe({
      planRef: fixture.launchSpec.planRef,
      executionUnitId: fixture.executionUnit.executionUnitId,
      processRef: started.processRef,
    });
    const recovered = await adapter.recover({
      planRef: fixture.launchSpec.planRef,
      executionUnit: fixture.executionUnit,
      cancellation: activeCancellation(),
    });

    expect(observed).toEqual({ status: 'unclassified_residual' });
    expect(recovered).toEqual({ status: 'operator_required' });
    expect(store.state?.phase).toBe('unclassified_residual');
  });

  it('does not emit another stop frame while the durable owner is already stopping', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, new FakeIdentities(), spawner, clock);
    const fixture = executionFixture();
    const started = await adapter.start(fixture);
    if (started.status !== 'started' || !spawner.owner || !spawner.sink) {
      throw new Error('expected fake start');
    }
    let releaseOwnerEof: (() => void) | undefined;
    spawner.owner.waitForEofGate = new Promise<void>((resolve) => {
      releaseOwnerEof = resolve;
    });
    let acknowledgeStopping: (() => void) | undefined;
    const stoppingApplied = new Promise<void>((resolve) => {
      acknowledgeStopping = resolve;
    });
    store.onStoppingApplied = () => acknowledgeStopping?.();
    const stopRequest = {
      planRef: fixture.launchSpec.planRef,
      executionUnitId: fixture.executionUnit.executionUnitId,
      processRef: started.processRef,
      mode: 'graceful' as const,
      cancellation: activeCancellation(),
    };

    const firstStop = adapter.stop(stopRequest);
    await stoppingApplied;
    const repeatedStop = await adapter.stop(stopRequest);
    releaseOwnerEof?.();

    expect(repeatedStop).toEqual({ status: 'unclassified_residual' });
    await expect(firstStop).resolves.toEqual({ status: 'drained' });
    expect(spawner.sink.writes).toHaveLength(1);
  });

  it('does not accept typed drain before independently attested owning-process EOF', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, new FakeIdentities(), spawner, clock);
    const fixture = executionFixture();
    const started = await adapter.start(fixture);
    if (started.status !== 'started' || !spawner.owner) throw new Error('expected fake start');
    let releaseOwnerEof: (() => void) | undefined;
    spawner.owner.waitForEofGate = new Promise<void>((resolve) => {
      releaseOwnerEof = resolve;
    });
    let acknowledgeStopping: (() => void) | undefined;
    const stoppingApplied = new Promise<void>((resolve) => {
      acknowledgeStopping = resolve;
    });
    store.onStoppingApplied = () => acknowledgeStopping?.();

    let settled = false;
    const stopped = adapter
      .stop({
        planRef: fixture.launchSpec.planRef,
        executionUnitId: fixture.executionUnit.executionUnitId,
        processRef: started.processRef,
        mode: 'graceful',
        cancellation: activeCancellation(),
      })
      .finally(() => {
        settled = true;
      });
    await stoppingApplied;
    expect(settled).toBe(false);
    expect(store.state?.phase).toBe('stopping');
    releaseOwnerEof?.();

    await expect(stopped).resolves.toEqual({ status: 'drained' });
    expect(store.state?.phase).toBe('drained');
  });

  it('fences stop before control output when plan or execution unit differs', async () => {
    const store = new FakeStore();
    const clock = new FakeClock();
    const spawner = new FakeSpawner(store, clock);
    const adapter = createAdapter(store, new FakeIdentities(), spawner, clock);
    const fixture = executionFixture();
    const started = await adapter.start(fixture);
    if (started.status !== 'started' || !spawner.sink) throw new Error('expected fake start');

    const stopped = await adapter.stop({
      planRef: { ...fixture.launchSpec.planRef, generation: 6 },
      executionUnitId: parseExecutionUnitId('unit-reused'),
      processRef: started.processRef,
      mode: 'immediate',
      cancellation: activeCancellation(),
    });

    expect(stopped).toEqual({ status: 'unclassified_residual' });
    expect(spawner.sink.writes).toHaveLength(0);
  });
});
