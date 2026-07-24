import {
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseMainProcessIdentityRef,
  parseOwnedProcessRef,
  parseOwningProcessIdentityRef,
  parseProcessControllerInstanceId,
  parseSpawnNonce,
  PROCESS_OWNER_ATTESTATION_VERSION,
  PROCESS_SUPERVISION_MAX_FRAME_BYTES,
  PROCESS_SUPERVISION_MAX_STATUS_STREAM_BYTES,
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  ProcessSupervisionCancellationError,
  ProcessSupervisionProtocolError,
  ProcessSupervisionTimeoutError,
} from '@features/team-runtime-control/contracts/processSupervision';
import {
  type CompositeRuntimePlanHash,
  parseExecutionUnitId,
  parseRuntimeBinaryId,
  type Sha256Hash,
} from '@features/team-runtime-control/contracts/runtimePlan';
import {
  createProcessSupervisionDeadline,
  type MonotonicClockPort,
} from '@features/team-runtime-control/core/application/process-supervision';
import {
  commitProcessOwnership,
  computeCanonicalArgvDigest,
  computeCanonicalPolicyDigest,
  createSpawnIntent,
  initializeProcessOwnershipState,
  spawnNonceDigest,
} from '@features/team-runtime-control/core/domain/process-supervision';
import {
  createAnchorStopControlFrame,
  mapAnchorDrainProof,
  mapAnchorReadyProof,
} from '@features/team-runtime-control/main/adapters/output/process-supervision';
import {
  decodeAnchorStatusFrame,
  encodeAnchorControlFrame,
  NodeAnchorControlChannel,
  type NodeAnchorControlSink,
  NodeAnchorStatusDecoder,
  NodeAnchorStatusReader,
  type NodeAnchorStatusSource,
} from '@features/team-runtime-control/main/infrastructure/process-supervision';
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
  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

class RealClock implements MonotonicClockPort {
  now(): number {
    return performance.now();
  }
}

const activeCancellation = (): RuntimeCancellation => ({
  cancellationId: 'active-cancellation-000001' as RuntimeCancellationId,
  isCancellationRequested: () => false,
});

function intentFixture() {
  const argv = ['serve'];
  return createSpawnIntent({
    scope: {
      planRef: {
        teamId: parseTeamId(`team_${'a'.repeat(32)}`),
        runId: parseRunId(`run_${'b'.repeat(32)}`),
        generation: 2,
        planHash: hash('c') as CompositeRuntimePlanHash,
      },
      executionUnitId: parseExecutionUnitId('unit-primary'),
    },
    processRef: parseOwnedProcessRef('process-ref-0000000000000001'),
    spawnNonce: parseSpawnNonce('spawn-nonce-0000000000000001'),
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'d'.repeat(32)}`),
      registrationRevision: 3,
      bindingGeneration: 4,
      mountGeneration: 5,
    },
    binaryBinding: {
      policy: 'registered_exact_binary',
      binaryId: parseRuntimeBinaryId('binary-provider'),
      binaryRevision: 1,
      binaryHash: hash('e'),
    },
    argv,
    callerArgvDigest: computeCanonicalArgvDigest(argv),
    environmentPolicyDigest: computeCanonicalPolicyDigest({ names: ['SAFE'] }),
    relayScopeDigest: computeCanonicalPolicyDigest({ members: ['lead', 'worker'] }),
  });
}

function commonWire(sequence: number) {
  const intent = intentFixture();
  return {
    protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
    sequence,
    processRef: intent.processRef,
    teamId: intent.scope.planRef.teamId,
    runId: intent.scope.planRef.runId,
    generation: intent.scope.planRef.generation,
    planHash: intent.scope.planRef.planHash,
    executionUnitId: intent.scope.executionUnitId,
    spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
    channelRef: 'channel-ref-000000000000001',
  };
}

function readyWire() {
  const intent = intentFixture();
  return {
    ...commonWire(1),
    type: 'ready',
    workspaceBinding: intent.workspaceBinding,
    anchorIdentityRef: 'anchor-identity-00000000001',
    mainProcessIdentityRef: 'main-identity-0000000000001',
  };
}

function ownerAttestation() {
  const intent = intentFixture();
  return Object.freeze({
    attestationVersion: PROCESS_OWNER_ATTESTATION_VERSION,
    processRef: intent.processRef,
    scope: intent.scope,
    workspaceBinding: intent.workspaceBinding,
    spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
    channelRef: parseAnchorChannelRef('channel-ref-000000000000001'),
    owningProcessIdentityRef: parseOwningProcessIdentityRef('owner-identity-0000000000001'),
    anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-00000000001'),
  });
}

function bytes(value: unknown, newline = false): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}${newline ? '\n' : ''}`);
}

describe('anchor protocol infrastructure codecs', () => {
  it('decodes strict exact ready fields and keeps native numeric identities out', () => {
    const frame = decodeAnchorStatusFrame(bytes(readyWire()));

    expect(frame.type).toBe('ready');
    expect(frame.sequence).toBe(1);
    expect(JSON.stringify(frame)).not.toMatch(/\bpid|pgid/i);
    expect(() => decodeAnchorStatusFrame(bytes({ ...readyWire(), pid: 42 }))).toThrow(
      'status-frame-fields'
    );
  });

  it('rejects malformed UTF-8, duplicate keys, unknown fields, and oversized frames', () => {
    expect(() => decodeAnchorStatusFrame(new Uint8Array([0xc3, 0x28]))).toThrow(
      'status-frame-utf8'
    );
    const duplicate = JSON.stringify(readyWire()).replace(
      '"sequence":1',
      '"sequence":1,"sequence":1'
    );
    expect(() => decodeAnchorStatusFrame(new TextEncoder().encode(duplicate))).toThrow(
      'status-frame-duplicate-key'
    );
    expect(() => decodeAnchorStatusFrame(bytes({ ...readyWire(), inheritedEnv: true }))).toThrow(
      'status-frame-fields'
    );
    expect(() =>
      decodeAnchorStatusFrame(new Uint8Array(PROCESS_SUPERVISION_MAX_FRAME_BYTES + 1))
    ).toThrow('status-frame-size');
  });

  it('does not mistake key-like text inside a string for a duplicate object field', () => {
    const frame = decodeAnchorStatusFrame(
      bytes({
        ...commonWire(2),
        type: 'protocol_error',
        reason: 'literal "sequence": text',
      })
    );

    expect(frame).toMatchObject({
      type: 'protocol_error',
      reason: 'literal "sequence": text',
    });
  });

  it('decodes fragmented UTF-8 only after a complete bounded frame', () => {
    const decoder = new NodeAnchorStatusDecoder();
    const frameBytes = bytes(
      {
        ...commonWire(2),
        type: 'unclassified_residual',
        outcome: 'unclassified',
        residuals: ['child-é'],
        reason: 'ambiguous-é',
      },
      true
    );
    const frames = [];
    for (const byte of frameBytes) frames.push(...decoder.push(Uint8Array.of(byte)));
    decoder.finish();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'unclassified_residual',
      reason: 'ambiguous-é',
    });
  });

  it('fails closed on output flood before retaining unbounded bytes', () => {
    const decoder = new NodeAnchorStatusDecoder();
    expect(() =>
      decoder.push(new Uint8Array(PROCESS_SUPERVISION_MAX_STATUS_STREAM_BYTES + 1))
    ).toThrow('status-stream-too-large');

    const oneFrameFlood = new NodeAnchorStatusDecoder();
    expect(() =>
      oneFrameFlood.push(new Uint8Array(PROCESS_SUPERVISION_MAX_FRAME_BYTES + 1))
    ).toThrow('status-frame-too-large');
  });

  it('uses one monotonic deadline across trickled fragments instead of resetting per read', async () => {
    const clock = new FakeClock();
    const wire = bytes(readyWire(), true);
    const remainingTimes: number[] = [];
    let offset = 0;
    const source: NodeAnchorStatusSource = {
      async inspect() {
        return { status: 'live' };
      },
      async read(options) {
        remainingTimes.push(options.remainingTimeMs);
        clock.advance(1);
        return { status: 'chunk', bytes: wire.slice(offset, ++offset) };
      },
    };
    const reader = new NodeAnchorStatusReader(source);

    await expect(
      reader.readReady(createProcessSupervisionDeadline(clock, 5), clock, activeCancellation())
    ).rejects.toBeInstanceOf(ProcessSupervisionTimeoutError);
    expect(remainingTimes).toEqual([5, 4, 3, 2, 1]);
  });

  it('fails closed before I/O when the monotonic clock moves behind the deadline origin', async () => {
    const clock = new FakeClock();
    clock.value = 10;
    const deadline = createProcessSupervisionDeadline(clock, 100);
    clock.value = 9;
    let reads = 0;
    const reader = new NodeAnchorStatusReader({
      async inspect() {
        return { status: 'live' };
      },
      async read() {
        reads += 1;
        return { status: 'chunk', bytes: bytes(readyWire(), true) };
      },
    });

    await expect(reader.readReady(deadline, clock, activeCancellation())).rejects.toBeInstanceOf(
      ProcessSupervisionTimeoutError
    );
    expect(reads).toBe(0);
  });

  it('types a hung status effect and cancellation without waiting forever', async () => {
    const source: NodeAnchorStatusSource = {
      async inspect() {
        return { status: 'live' };
      },
      async read() {
        return await new Promise<never>(() => undefined);
      },
    };
    const reader = new NodeAnchorStatusReader(source);
    const clock = new RealClock();
    await expect(
      reader.readReady(createProcessSupervisionDeadline(clock, 8), clock, activeCancellation())
    ).rejects.toBeInstanceOf(ProcessSupervisionTimeoutError);

    const cancelled: RuntimeCancellation = {
      cancellationId: 'cancelled-operation-00001' as RuntimeCancellationId,
      isCancellationRequested: () => true,
    };
    await expect(
      reader.readReady(createProcessSupervisionDeadline(clock, 20), clock, cancelled)
    ).rejects.toBeInstanceOf(ProcessSupervisionCancellationError);
  });

  it('rejects empty chunks and cross-stream status injection before accepting drain', async () => {
    const clock = new FakeClock();
    const emptyReader = new NodeAnchorStatusReader({
      async inspect() {
        return { status: 'live' };
      },
      async read() {
        return { status: 'chunk', bytes: new Uint8Array() };
      },
    });
    await expect(
      emptyReader.readReady(
        createProcessSupervisionDeadline(clock, 20),
        clock,
        activeCancellation()
      )
    ).rejects.toThrow('status-chunk-empty');

    const injectedDrain = bytes(
      {
        ...commonWire(2),
        planHash: hash('f'),
        type: 'drained',
        outcome: 'drained',
        residuals: [],
      },
      true
    );
    const chunks = [bytes(readyWire(), true), injectedDrain];
    const reader = new NodeAnchorStatusReader({
      async inspect() {
        return { status: 'live' };
      },
      async read() {
        return { status: 'chunk', bytes: chunks.shift()! };
      },
    });
    await reader.readReady(
      createProcessSupervisionDeadline(clock, 20),
      clock,
      activeCancellation()
    );
    await expect(
      reader.readDrain(createProcessSupervisionDeadline(clock, 20), clock, activeCancellation())
    ).rejects.toThrow('status-ownership-mismatch');
  });

  it('does not accept a terminal frame until the exclusive status stream reaches EOF', async () => {
    const clock = new FakeClock();
    const chunks = [
      bytes(readyWire(), true),
      bytes({ ...commonWire(2), type: 'drained', outcome: 'drained', residuals: [] }, true),
    ];
    let releaseEof: (() => void) | undefined;
    const eofGate = new Promise<void>((resolve) => {
      releaseEof = resolve;
    });
    const reader = new NodeAnchorStatusReader({
      async inspect() {
        return { status: 'live' };
      },
      async read() {
        const chunk = chunks.shift();
        if (chunk) return { status: 'chunk' as const, bytes: chunk };
        await eofGate;
        return { status: 'eof' as const };
      },
    });
    const deadline = createProcessSupervisionDeadline(clock, 100);
    await reader.readReady(deadline, clock, activeCancellation());

    let settled = false;
    const drain = reader.readDrain(deadline, clock, activeCancellation()).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseEof?.();
    await expect(drain).resolves.toMatchObject({ type: 'drained', sequence: 2 });
  });

  it('rejects any decoded status after a terminal frame even when EOF follows', async () => {
    const clock = new FakeClock();
    const chunks = [
      bytes(readyWire(), true),
      new Uint8Array([
        ...bytes({ ...commonWire(2), type: 'drained', outcome: 'drained', residuals: [] }, true),
        ...bytes({ ...commonWire(3), type: 'main_exit', outcome: 'success' }, true),
      ]),
    ];
    const reader = new NodeAnchorStatusReader({
      async inspect() {
        return { status: 'live' };
      },
      async read() {
        const chunk = chunks.shift();
        return chunk ? { status: 'chunk' as const, bytes: chunk } : { status: 'eof' as const };
      },
    });
    const deadline = createProcessSupervisionDeadline(clock, 100);
    await reader.readReady(deadline, clock, activeCancellation());

    await expect(reader.readDrain(deadline, clock, activeCancellation())).rejects.toThrow(
      'status-frame-after-terminal'
    );
  });

  it('propagates remaining time to control write and close under the same deadline', async () => {
    const clock = new FakeClock();
    const remaining: number[] = [];
    const sink: NodeAnchorControlSink = {
      async write(_frame, options) {
        remaining.push(options.remainingTimeMs);
        clock.advance(40);
      },
      async close(options) {
        remaining.push(options.remainingTimeMs);
        clock.advance(10);
      },
    };
    const channel = new NodeAnchorControlChannel('channel-ref-000000000000001', sink);
    const intent = intentFixture();
    const ownershipResult = commitProcessOwnership(initializeProcessOwnershipState(intent), {
      processRef: intent.processRef,
      scope: intent.scope,
      workspaceBinding: intent.workspaceBinding,
      spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
      controllerInstanceId: parseProcessControllerInstanceId('controller-instance-00000001'),
      ownerAttestation: ownerAttestation(),
      mainProcessIdentityRef: parseMainProcessIdentityRef('main-identity-0000000000001'),
      statusSequence: 1,
    });
    const ownership =
      ownershipResult.status === 'accepted' && 'ownership' in ownershipResult.next
        ? ownershipResult.next.ownership
        : undefined;
    if (!ownership) {
      throw new Error('expected ownership fixture');
    }
    const frame = createAnchorStopControlFrame(ownership, 'graceful', 25);
    const deadline = createProcessSupervisionDeadline(clock, 100);
    await channel.writeStop(frame, deadline, clock, activeCancellation());
    await channel.close(deadline, clock, activeCancellation());

    expect(remaining).toEqual([100, 60]);
    const encoded = new TextDecoder().decode(encodeAnchorControlFrame(frame));
    expect(encoded).not.toMatch(/\bpid|pgid|environment|shell/i);
  });

  it('types a hung pipe close and does not infer drain', async () => {
    const sink: NodeAnchorControlSink = {
      async write() {},
      async close() {
        return await new Promise<never>(() => undefined);
      },
    };
    const clock = new RealClock();
    const channel = new NodeAnchorControlChannel('channel-ref-000000000000001', sink);
    await expect(
      channel.close(createProcessSupervisionDeadline(clock, 8), clock, activeCancellation())
    ).rejects.toBeInstanceOf(ProcessSupervisionTimeoutError);
  });

  it('types a hung control write under the same bounded effect contract', async () => {
    const sink: NodeAnchorControlSink = {
      async write() {
        return await new Promise<never>(() => undefined);
      },
      async close() {},
    };
    const clock = new RealClock();
    const channel = new NodeAnchorControlChannel('channel-ref-000000000000001', sink);
    const intent = intentFixture();
    const ownership = commitProcessOwnership(initializeProcessOwnershipState(intent), {
      processRef: intent.processRef,
      scope: intent.scope,
      workspaceBinding: intent.workspaceBinding,
      spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
      controllerInstanceId: parseProcessControllerInstanceId('controller-instance-00000001'),
      ownerAttestation: ownerAttestation(),
      mainProcessIdentityRef: parseMainProcessIdentityRef('main-identity-0000000000001'),
      statusSequence: 1,
    });
    if (ownership.status !== 'accepted' || !('ownership' in ownership.next)) {
      throw new Error('expected ownership fixture');
    }
    const record = ownership.next.ownership;
    if (!record) throw new Error('expected ownership record');
    await expect(
      channel.writeStop(
        createAnchorStopControlFrame(record, 'immediate', 0),
        createProcessSupervisionDeadline(clock, 8),
        clock,
        activeCancellation()
      )
    ).rejects.toBeInstanceOf(ProcessSupervisionTimeoutError);
  });
});

describe('anchor protocol adapter mappings', () => {
  it('maps only exact nonce/workspace/order ready and drain evidence', () => {
    const intent = intentFixture();
    const frame = decodeAnchorStatusFrame(bytes(readyWire()));
    if (frame.type !== 'ready') throw new Error('expected ready');
    const proof = mapAnchorReadyProof(
      intent,
      parseProcessControllerInstanceId('controller-instance-00000001'),
      parseAnchorChannelRef('channel-ref-000000000000001'),
      ownerAttestation(),
      frame
    );
    expect(proof).not.toBeNull();
    expect(Object.isFrozen(proof?.ownerAttestation)).toBe(true);
    expect(
      mapAnchorReadyProof(
        intent,
        parseProcessControllerInstanceId('controller-instance-00000001'),
        parseAnchorChannelRef('channel-ref-000000000000001'),
        { ...ownerAttestation(), argvDigest: intent.argvDigest },
        frame
      )
    ).toBeNull();
    expect(
      mapAnchorReadyProof(
        intent,
        parseProcessControllerInstanceId('controller-instance-00000001'),
        parseAnchorChannelRef('channel-ref-000000000000099'),
        ownerAttestation(),
        frame
      )
    ).toBeNull();
    if (!proof) throw new Error('expected proof');
    const committed = commitProcessOwnership(initializeProcessOwnershipState(intent), proof);
    const ownership =
      committed.status === 'accepted' && 'ownership' in committed.next
        ? committed.next.ownership
        : undefined;
    if (!ownership) {
      throw new Error('expected commit');
    }
    const drained = decodeAnchorStatusFrame(
      bytes({
        ...commonWire(2),
        type: 'drained',
        outcome: 'drained',
        residuals: [],
      })
    );
    if (drained.type !== 'drained') throw new Error('expected drain');
    const ownedProcessEof = {
      processRef: ownership.processRef,
      ownerAttestation: ownership.ownerAttestation,
      observed: true as const,
    };
    expect(mapAnchorDrainProof(ownership, drained, ownedProcessEof)).toMatchObject({
      outcome: 'drained',
      statusSequence: 2,
    });

    const replayed = { ...drained, sequence: 1 };
    expect(mapAnchorDrainProof(ownership, replayed, ownedProcessEof)).toBeNull();
  });

  it('surfaces protocol failures with typed errors', () => {
    expect(() => decodeAnchorStatusFrame(bytes({ type: 'ready' }))).toThrow(
      ProcessSupervisionProtocolError
    );
  });
});
