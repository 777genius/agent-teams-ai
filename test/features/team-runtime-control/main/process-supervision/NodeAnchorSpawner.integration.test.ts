import { type ChildProcess, spawn as spawnChildProcess } from 'node:child_process';
import { mkdir, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  parseAnchorChannelRef,
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  type ProcessOwnerAttestation,
} from '@features/team-runtime-control/contracts/processSupervision';
import {
  createProcessSupervisionDeadline,
  type MonotonicClockPort,
} from '@features/team-runtime-control/core/application/process-supervision';
import {
  NodeAnchorControlChannel,
  NodeAnchorStatusReader,
} from '@features/team-runtime-control/main/infrastructure/process-supervision';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildProcessAnchorFixture,
  createProcessAnchorSpawnHarness,
  type ProcessAnchorFixture,
  type ProcessAnchorSpawnHarness,
  readFakeRuntimeMarkerEvents,
} from './buildProcessAnchorFixture';

import type { RuntimeCancellation } from '@features/team-runtime-control/core/application/ports';
import type {
  AnchorSpawnRequest,
  AnchorSpawnResult,
} from '@features/team-runtime-control/main/adapters/output/process-supervision';

type SpawnedAnchor = Extract<AnchorSpawnResult, { status: 'spawned' }>;

const clock: MonotonicClockPort = { now: () => performance.now() };

describe.skipIf(process.platform !== 'linux')('NodeAnchorSpawner integration', () => {
  let fixture: ProcessAnchorFixture;
  let harness: ProcessAnchorSpawnHarness;
  let spawned: SpawnedAnchor[];

  beforeEach(async () => {
    fixture = await buildProcessAnchorFixture();
    harness = await createProcessAnchorSpawnHarness(fixture);
    spawned = [];
  }, 30_000);

  afterEach(async () => {
    for (const anchor of spawned) {
      await anchor.controlSink
        .close({ remainingTimeMs: 2_000, cancellation: harness.cancellation })
        .catch(() => undefined);
      await anchor.owningProcess
        .waitForEof({
          attestation: anchor.ownerAttestation,
          remainingTimeMs: 6_000,
          cancellation: harness.cancellation,
        })
        .catch(() => undefined);
    }
    await fixture.dispose();
  }, 15_000);

  it('bootstraps a protocol-unaware admitted provider with isolated launch material', async () => {
    const request = harness.request('normal');
    const anchor = await spawn(request);
    const status = new NodeAnchorStatusReader(anchor.statusSource);
    const control = new NodeAnchorControlChannel(anchor.channelRef, anchor.controlSink);
    const deadline = createProcessSupervisionDeadline(clock, 8_000);

    const ready = await status.readReady(deadline, clock, harness.cancellation);
    expect(ready).toMatchObject({
      protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
      type: 'ready',
      sequence: 1,
      processRef: request.intent.processRef,
      channelRef: anchor.channelRef,
      workspaceBinding: request.intent.workspaceBinding,
      anchorIdentityRef: anchor.ownerAttestation.anchorIdentityRef,
    });
    await waitForFakeRuntimeMarkerEvent(fixture, 'normal', 'started');

    await control.writeStop(
      stopFrame(request, 'graceful', 150),
      deadline,
      clock,
      harness.cancellation
    );
    const terminal = await status.readDrain(deadline, clock, harness.cancellation);
    expect(terminal).toMatchObject({ type: 'drained', outcome: 'drained', residuals: [] });
    await expectOwnerEof(anchor, harness.cancellation);

    const events = await readFakeRuntimeMarkerEvents(fixture);
    const runtimeStart = events.find(
      (event) => event.role === 'normal' && event.event === 'started'
    );
    expect(runtimeStart).toMatchObject({
      cwd: fixture.workdirPath,
      environmentNames: ['FAKE_ALLOWED'],
      descriptors: [
        { descriptor: 0, target: '/dev/null' },
        { descriptor: 1, target: '/dev/null' },
        { descriptor: 2, target: '/dev/null' },
      ],
    });
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'normal', event: 'term' })])
    );
  }, 15_000);

  it('attests only the exact boot-local ChildProcess and observes its close EOF', async () => {
    const request = harness.request('normal');
    const anchor = await spawn(request);
    const status = new NodeAnchorStatusReader(anchor.statusSource);
    const control = new NodeAnchorControlChannel(anchor.channelRef, anchor.controlSink);
    const deadline = createProcessSupervisionDeadline(clock, 8_000);
    await status.readReady(deadline, clock, harness.cancellation);

    const mismatched = {
      ...anchor.ownerAttestation,
      channelRef: parseAnchorChannelRef('anchor-channel:mismatched-attestation'),
    } as ProcessOwnerAttestation;
    await expect(
      anchor.owningProcess.inspect({
        attestation: mismatched,
        remainingTimeMs: 1_000,
        cancellation: harness.cancellation,
      })
    ).resolves.toEqual({ status: 'mismatch' });
    await expect(
      anchor.owningProcess.inspect({
        attestation: anchor.ownerAttestation,
        remainingTimeMs: 1_000,
        cancellation: harness.cancellation,
      })
    ).resolves.toMatchObject({ status: 'live' });

    await control.writeStop(
      stopFrame(request, 'immediate', 0),
      deadline,
      clock,
      harness.cancellation
    );
    await status.readDrain(deadline, clock, harness.cancellation);
    await expectOwnerEof(anchor, harness.cancellation);
    await expect(
      anchor.owningProcess.inspect({
        attestation: anchor.ownerAttestation,
        remainingTimeMs: 1_000,
        cancellation: harness.cancellation,
      })
    ).resolves.toMatchObject({ status: 'eof' });
  }, 15_000);

  it.each(['directory-replacement', 'symlink-swap'] as const)(
    'rejects a deterministic pre-open registered-root %s',
    async (replacement) => {
      const request = harness.request('normal');
      await withReplacedRegisteredRoot(fixture, replacement, async () => {
        await expect(
          harness.spawner.spawn(request, {
            remainingTimeMs: 2_000,
            cancellation: harness.cancellation,
          })
        ).resolves.toEqual({ status: 'unavailable' });
      });
    },
    10_000
  );

  it('rejects registered-root mount evidence that does not match the opened descriptor', async () => {
    const mismatchedHarness = await createProcessAnchorSpawnHarness(fixture, {
      registeredRootEvidence: Object.freeze({
        ...harness.registeredRootEvidence,
        mountId: harness.registeredRootEvidence.mountId + 1n,
      }),
    });
    await expect(
      mismatchedHarness.spawner.spawn(mismatchedHarness.request('normal'), {
        remainingTimeMs: 2_000,
        cancellation: mismatchedHarness.cancellation,
      })
    ).resolves.toEqual({ status: 'unavailable' });
  }, 10_000);

  it('reaps the exact spawned child before returning a timeout result', async () => {
    let deadlineExpired = false;
    let observedChild: ChildProcess | undefined;
    let closeObserved = false;
    const spawner = harness.createSpawner({
      monotonicNow: () => (deadlineExpired ? 10_000 : 0),
      spawnProcess(command, args, options) {
        const child = spawnChildProcess(command, args, options);
        observedChild = child;
        child.once('close', () => {
          closeObserved = true;
        });
        deadlineExpired = true;
        return child;
      },
    });

    await expect(
      spawner.spawn(harness.request('normal'), {
        remainingTimeMs: 5_000,
        cancellation: harness.cancellation,
      })
    ).resolves.toEqual({ status: 'timed_out' });
    expect(observedChild).toBeDefined();
    expect(closeObserved).toBe(true);
    expect(observedChild?.stdin?.destroyed).toBe(true);
    expect(observedChild?.stdout?.destroyed).toBe(true);
    expect(observedChild?.stdio[3]?.destroyed).toBe(true);
  }, 10_000);

  it('reaps the exact spawned child before returning a cancellation result', async () => {
    let cancelled = false;
    let observedChild: ChildProcess | undefined;
    let closeObserved = false;
    const cancellation: RuntimeCancellation = Object.freeze({
      cancellationId:
        'process-anchor-cancellation-cleanup' as RuntimeCancellation['cancellationId'],
      isCancellationRequested: () => cancelled,
    });
    const spawner = harness.createSpawner({
      spawnProcess(command, args, options) {
        const child = spawnChildProcess(command, args, options);
        observedChild = child;
        child.once('close', () => {
          closeObserved = true;
        });
        cancelled = true;
        return child;
      },
    });

    await expect(
      spawner.spawn(harness.request('normal'), {
        remainingTimeMs: 2_000,
        cancellation,
      })
    ).resolves.toEqual({ status: 'cancelled' });
    expect(observedChild).toBeDefined();
    expect(closeObserved).toBe(true);
  }, 10_000);

  async function spawn(request: AnchorSpawnRequest): Promise<SpawnedAnchor> {
    const result = await harness.spawner.spawn(request, {
      remainingTimeMs: 8_000,
      cancellation: harness.cancellation,
    });
    expect(result.status).toBe('spawned');
    if (result.status !== 'spawned') throw new Error(`anchor-spawn-${result.status}`);
    spawned.push(result);
    return result;
  }
});

async function withReplacedRegisteredRoot(
  fixture: ProcessAnchorFixture,
  replacement: 'directory-replacement' | 'symlink-swap',
  effect: () => Promise<void>
): Promise<void> {
  const savedPath = path.join(fixture.sandboxPath, 'registered-workdir-saved');
  const substitutePath = path.join(fixture.sandboxPath, 'registered-workdir-substitute');
  await rename(fixture.workdirPath, savedPath);
  try {
    if (replacement === 'directory-replacement') {
      await mkdir(fixture.workdirPath, { mode: 0o700 });
    } else {
      await mkdir(substitutePath, { mode: 0o700 });
      await symlink(substitutePath, fixture.workdirPath, 'dir');
    }
    await effect();
  } finally {
    await rm(fixture.workdirPath, { recursive: true, force: true });
    if (replacement === 'symlink-swap') {
      await rm(substitutePath, { recursive: true, force: true });
    }
    await rename(savedPath, fixture.workdirPath);
  }
}

function stopFrame(request: AnchorSpawnRequest, mode: 'graceful' | 'immediate', graceMs: number) {
  return Object.freeze({
    protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
    type: 'stop' as const,
    sequence: 1,
    processRef: request.intent.processRef,
    planRef: request.intent.scope.planRef,
    executionUnitId: request.intent.scope.executionUnitId,
    mode,
    graceMs,
  });
}

async function expectOwnerEof(
  anchor: SpawnedAnchor,
  cancellation: RuntimeCancellation
): Promise<void> {
  await expect(
    anchor.owningProcess.waitForEof({
      attestation: anchor.ownerAttestation,
      remainingTimeMs: 6_000,
      cancellation,
    })
  ).resolves.toMatchObject({ status: 'eof', ownerAttestation: anchor.ownerAttestation });
}

async function waitForFakeRuntimeMarkerEvent(
  fixture: ProcessAnchorFixture,
  role: string,
  event: string
): Promise<void> {
  const expiresAt = performance.now() + 3_000;
  do {
    const events = await readFakeRuntimeMarkerEvents(fixture);
    if (events.some((entry) => entry.role === role && entry.event === event)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < expiresAt);
  throw new Error(`fake-runtime-marker-timeout:${role}:${event}`);
}
