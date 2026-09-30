import { type ChildProcess, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  ProcessSupervisionProtocolError,
} from '@features/team-runtime-control/contracts/processSupervision';
import {
  createProcessSupervisionDeadline,
  type MonotonicClockPort,
} from '@features/team-runtime-control/core/application/process-supervision';
import {
  type AnchorStatusFrame,
  NodeAnchorControlChannel,
  NodeAnchorStatusDecoder,
  NodeAnchorStatusReader,
  type NodeAnchorStatusSource,
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

interface RunningAnchor {
  readonly request: AnchorSpawnRequest;
  readonly anchor: SpawnedAnchor;
  readonly source: RecordingStatusSource;
  readonly status: NodeAnchorStatusReader;
  readonly control: NodeAnchorControlChannel;
}

const clock: MonotonicClockPort = { now: () => performance.now() };

describe.skipIf(process.platform !== 'linux')('process anchor Linux safe lifecycle E2E', () => {
  let fixture: ProcessAnchorFixture;
  let harness: ProcessAnchorSpawnHarness;
  let anchors: SpawnedAnchor[];
  let fixtureProcesses: ChildProcess[];

  beforeEach(async () => {
    fixture = await buildProcessAnchorFixture();
    harness = await createProcessAnchorSpawnHarness(fixture);
    anchors = [];
    fixtureProcesses = [];
  }, 30_000);

  afterEach(async () => {
    for (const child of fixtureProcesses) await stopFixtureProcess(child);
    for (const anchor of anchors) {
      await anchor.controlSink
        .close({ remainingTimeMs: 2_000, cancellation: harness.cancellation })
        .catch(() => undefined);
      await anchor.owningProcess
        .waitForEof({
          attestation: anchor.ownerAttestation,
          remainingTimeMs: 7_000,
          cancellation: harness.cancellation,
        })
        .catch(() => undefined);
    }
    await fixture.dispose();
  }, 20_000);

  it('launches only in the marker-owned sandbox, attests the owner, and drains on TERM', async () => {
    const running = await launch('normal');
    await expect(
      running.anchor.owningProcess.inspect({
        attestation: running.anchor.ownerAttestation,
        remainingTimeMs: 1_000,
        cancellation: harness.cancellation,
      })
    ).resolves.toMatchObject({
      status: 'live',
      ownerAttestation: running.anchor.ownerAttestation,
    });

    const terminal = await stopAndDrain(running, 'graceful', 150);
    expect(terminal).toMatchObject({ type: 'drained', outcome: 'drained', residuals: [] });
    await expectOwnerEof(running.anchor, harness.cancellation);

    const frames = running.source.frames();
    expect(escalationModes(frames)).toEqual(['term']);
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'main_exit', outcome: 'success' }),
        expect.objectContaining({ type: 'drained', outcome: 'drained' }),
      ])
    );
    expect(await readFakeRuntimeMarkerEvents(fixture)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'normal', event: 'started', cwd: fixture.workdirPath }),
        expect.objectContaining({ role: 'normal', event: 'term' }),
      ])
    );
  }, 15_000);

  it('escalates an ignored TERM through pidfd KILL and proves drain', async () => {
    const running = await launch('ignore-term');
    const terminal = await stopAndDrain(running, 'graceful', 50);
    expect(terminal).toMatchObject({ type: 'drained', outcome: 'drained', residuals: [] });
    await expectOwnerEof(running.anchor, harness.cancellation);

    expect(escalationModes(running.source.frames())).toEqual(['term', 'kill']);
    expect(await readFakeRuntimeMarkerEvents(fixture)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'ignore-term', event: 'started' }),
        expect.objectContaining({ role: 'ignore-term', event: 'term' }),
      ])
    );
  }, 15_000);

  it('adopts and drains a double-forked descendant as a subreaper', async () => {
    const running = await launch('double-fork');
    await waitForMarkerEvent('double-grandchild', 'started');

    const terminal = await stopAndDrain(running, 'graceful', 150);
    expect(terminal).toMatchObject({ type: 'drained', outcome: 'drained', residuals: [] });
    await expectOwnerEof(running.anchor, harness.cancellation);

    expect(await readFakeRuntimeMarkerEvents(fixture)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'double-fork', event: 'started' }),
        expect.objectContaining({ role: 'double-middle', event: 'started' }),
        expect.objectContaining({ role: 'double-grandchild', event: 'started' }),
        expect.objectContaining({ role: 'double-grandchild', event: 'term' }),
      ])
    );
  }, 15_000);

  it('treats controller control-pipe EOF as a bounded graceful drain request', async () => {
    const running = await launch('normal');
    await running.anchor.controlSink.close({
      remainingTimeMs: 2_000,
      cancellation: harness.cancellation,
    });

    const terminal = await running.status.readDrain(deadline(), clock, harness.cancellation);
    expect(terminal).toMatchObject({ type: 'drained', outcome: 'drained', residuals: [] });
    await expectOwnerEof(running.anchor, harness.cancellation);
    expect(escalationModes(running.source.frames())).toEqual(['term']);
  }, 15_000);

  it('drains an adopted survivor when the provider main process crashes', async () => {
    const running = await launch('main-crash');
    const terminal = await running.status.readDrain(deadline(), clock, harness.cancellation);
    expect(terminal).toMatchObject({ type: 'drained', outcome: 'drained', residuals: [] });
    await expectOwnerEof(running.anchor, harness.cancellation);

    const frames = running.source.frames();
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'main_exit', outcome: 'failure' }),
        expect.objectContaining({ type: 'drained', outcome: 'drained' }),
      ])
    );
    expect(await readFakeRuntimeMarkerEvents(fixture)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'main-crash', event: 'main-crash' }),
        expect.objectContaining({ role: 'crash-survivor', event: 'started' }),
        expect.objectContaining({ role: 'crash-survivor', event: 'term' }),
      ])
    );
  }, 15_000);

  it('fails closed as unclassified when a descendant escapes the owned process group', async () => {
    const running = await launch('escape');
    await waitForMarkerEvent('escape-grandchild', 'started');

    const terminal = await stopAndDrain(running, 'graceful', 50);
    expect(terminal).toMatchObject({
      type: 'unclassified_residual',
      outcome: 'unclassified',
      residuals: expect.arrayContaining(['escaped_group']),
      reason: 'owned-tree-not-provably-drained',
    });
    await expectOwnerEof(running.anchor, harness.cancellation);
    expect(await readFakeRuntimeMarkerEvents(fixture)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'escape-grandchild', event: 'started' }),
        expect.objectContaining({ role: 'escape-grandchild', event: 'bounded-exit' }),
      ])
    );
  }, 15_000);

  it('accepts an exact repeated stop without creating a second lifecycle effect', async () => {
    const running = await launch('ignore-term');
    const frame = stopFrame(running.request, 'graceful', 150);
    const operationDeadline = deadline();
    await running.control.writeStop(frame, operationDeadline, clock, harness.cancellation);
    await running.control.writeStop(frame, operationDeadline, clock, harness.cancellation);

    const terminal = await running.status.readDrain(operationDeadline, clock, harness.cancellation);
    expect(terminal).toMatchObject({ type: 'drained', outcome: 'drained', residuals: [] });
    await expectOwnerEof(running.anchor, harness.cancellation);
    expect(escalationModes(running.source.frames())).toEqual(['term', 'kill']);
  }, 15_000);

  it('does not signal an unrelated marker-owned process in the same sandbox', async () => {
    const unrelated = spawn(
      process.execPath,
      [fixture.fakeRuntimePath, 'unrelated', fixture.runtimeMarkerPath, fixture.sandboxPath],
      {
        cwd: fixture.sandboxPath,
        env: { FAKE_ALLOWED: 'unrelated-fixture' },
        shell: false,
        detached: false,
        stdio: 'ignore',
      }
    );
    fixtureProcesses.push(unrelated);
    await waitForMarkerEvent('unrelated', 'started');

    const running = await launch('normal');
    const terminal = await stopAndDrain(running, 'graceful', 150);
    expect(terminal).toMatchObject({ type: 'drained', outcome: 'drained' });
    await expectOwnerEof(running.anchor, harness.cancellation);

    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
    expect(
      (await readFakeRuntimeMarkerEvents(fixture)).some(
        (event) => event.role === 'unrelated' && event.event === 'term'
      )
    ).toBe(false);
    await stopFixtureProcess(unrelated);
    expect(await readFakeRuntimeMarkerEvents(fixture)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'unrelated', event: 'term' })])
    );
  }, 15_000);

  it.each(['malformed', 'mismatched'] as const)(
    'fails closed and drains on a %s native control frame',
    async (failureMode) => {
      const running = await launch('ignore-term');
      await running.anchor.controlSink.write(invalidControl(failureMode, running.request), {
        remainingTimeMs: 2_000,
        cancellation: harness.cancellation,
      });

      await expect(
        running.status.readDrain(deadline(), clock, harness.cancellation)
      ).rejects.toEqual(
        expect.objectContaining<Partial<ProcessSupervisionProtocolError>>({
          code: 'process-supervision-protocol-error',
          reason: 'anchor:invalid-control-frame',
        })
      );
      await expectOwnerEof(running.anchor, harness.cancellation);
      await running.source.captureToEof(harness.cancellation);

      const frames = running.source.frames();
      expect(escalationModes(frames)).toEqual(['term', 'kill']);
      expect(frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'protocol_error', reason: 'invalid-control-frame' }),
          expect.objectContaining({ type: 'escalation', mode: 'term' }),
          expect.objectContaining({ type: 'escalation', mode: 'kill' }),
        ])
      );
      expect(frames.some((frame) => frame.type === 'drained')).toBe(false);
    },
    15_000
  );

  async function launch(mode: string): Promise<RunningAnchor> {
    const request = harness.request(mode);
    const result = await harness.spawner.spawn(request, {
      remainingTimeMs: 8_000,
      cancellation: harness.cancellation,
    });
    expect(result.status).toBe('spawned');
    if (result.status !== 'spawned') throw new Error(`anchor-spawn-${result.status}`);
    anchors.push(result);
    const source = new RecordingStatusSource(result.statusSource);
    const status = new NodeAnchorStatusReader(source);
    const control = new NodeAnchorControlChannel(result.channelRef, result.controlSink);
    const ready = await status.readReady(deadline(), clock, harness.cancellation);
    expect(ready).toMatchObject({
      protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
      type: 'ready',
      sequence: 1,
      processRef: request.intent.processRef,
      channelRef: result.channelRef,
      workspaceBinding: request.intent.workspaceBinding,
      anchorIdentityRef: result.ownerAttestation.anchorIdentityRef,
    });
    await waitForMarkerEvent(mode, 'started');
    return { request, anchor: result, source, status, control };
  }

  async function stopAndDrain(
    running: RunningAnchor,
    mode: 'graceful' | 'immediate',
    graceMs: number
  ) {
    const operationDeadline = deadline();
    await running.control.writeStop(
      stopFrame(running.request, mode, graceMs),
      operationDeadline,
      clock,
      harness.cancellation
    );
    return await running.status.readDrain(operationDeadline, clock, harness.cancellation);
  }

  async function waitForMarkerEvent(role: string, event: string): Promise<void> {
    const expiresAt = performance.now() + 3_000;
    do {
      const events = await readFakeRuntimeMarkerEvents(fixture);
      if (events.some((entry) => entry.role === role && entry.event === event)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (performance.now() < expiresAt);
    throw new Error(`fake-runtime-marker-timeout:${role}:${event}`);
  }
});

class RecordingStatusSource implements NodeAnchorStatusSource {
  private readonly chunks: Uint8Array[] = [];

  constructor(private readonly source: NodeAnchorStatusSource) {}

  async inspect(options: Parameters<NodeAnchorStatusSource['inspect']>[0]) {
    return await this.source.inspect(options);
  }

  async read(options: Parameters<NodeAnchorStatusSource['read']>[0]) {
    const result = await this.source.read(options);
    if (result.status === 'chunk') this.chunks.push(result.bytes.slice());
    return result;
  }

  async captureToEof(cancellation: RuntimeCancellation): Promise<void> {
    for (;;) {
      const result = await this.read({ remainingTimeMs: 2_000, cancellation });
      if (result.status === 'eof') return;
    }
  }

  frames(): readonly AnchorStatusFrame[] {
    const decoder = new NodeAnchorStatusDecoder();
    const frames = this.chunks.flatMap((chunk) => decoder.push(chunk));
    decoder.finish();
    return frames;
  }
}

function deadline() {
  return createProcessSupervisionDeadline(clock, 8_000);
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

function invalidControl(
  failureMode: 'malformed' | 'mismatched',
  request: AnchorSpawnRequest
): Uint8Array {
  if (failureMode === 'malformed') return new TextEncoder().encode('{"protocolVersion":1}\n');
  return new TextEncoder().encode(
    `${JSON.stringify({
      protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
      type: 'stop',
      sequence: 1,
      processRef: 'process-ref:mismatched-control',
      teamId: request.intent.scope.planRef.teamId,
      runId: request.intent.scope.planRef.runId,
      generation: request.intent.scope.planRef.generation,
      planHash: request.intent.scope.planRef.planHash,
      executionUnitId: request.intent.scope.executionUnitId,
      mode: 'immediate',
      graceMs: 0,
    })}\n`
  );
}

function escalationModes(frames: readonly AnchorStatusFrame[]): readonly string[] {
  return frames.flatMap((frame) => (frame.type === 'escalation' ? [frame.mode] : []));
}

async function expectOwnerEof(
  anchor: SpawnedAnchor,
  cancellation: RuntimeCancellation
): Promise<void> {
  await expect(
    anchor.owningProcess.waitForEof({
      attestation: anchor.ownerAttestation,
      remainingTimeMs: 7_000,
      cancellation,
    })
  ).resolves.toMatchObject({ status: 'eof', ownerAttestation: anchor.ownerAttestation });
}

async function stopFixtureProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('fixture-process-close-timeout')), 2_000);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
