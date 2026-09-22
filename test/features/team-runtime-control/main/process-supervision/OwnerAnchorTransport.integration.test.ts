import { type ChildProcess, spawn as spawnChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';

import {
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  type ProcessOwnerAttestation,
} from '@features/team-runtime-control/contracts/processSupervision';
import {
  createProcessSupervisionDeadline,
  type MonotonicClockPort,
} from '@features/team-runtime-control/core/application/process-supervision';
import {
  NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH,
  NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION,
  NodeAnchorControlChannel,
  NodeAnchorStatusReader,
} from '@features/team-runtime-control/main/infrastructure/process-supervision';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildProcessAnchorFixture,
  createProcessAnchorSpawnHarness,
  type ProcessAnchorFixture,
  type ProcessAnchorSpawnHarness,
} from './buildProcessAnchorFixture';

import type { RuntimeCancellation } from '@features/team-runtime-control/core/application/ports';
import type {
  AnchorSpawnRequest,
  AnchorSpawnResult,
} from '@features/team-runtime-control/main/adapters/output/process-supervision';
import type { NodeAnchorSpawner } from '@features/team-runtime-control/main/infrastructure/process-supervision';

type SpawnedAnchor = Extract<AnchorSpawnResult, { status: 'spawned' }>;

const clock: MonotonicClockPort = { now: () => performance.now() };

describe.skipIf(process.platform !== 'linux')('Owner anchor provider transport integration', () => {
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
      await waitForOwnerEof(anchor, harness.cancellation).catch(() => undefined);
    }
    await fixture.dispose();
  }, 15_000);

  it('maps declared fd6/fd7/fd8 to separated provider streams and preserves provider EOF', async () => {
    const spawner = harness.createSpawner({ providerStdio: 'pipe' });
    const request = harness.request('owner-stdio', [
      '-e',
      providerEchoProgram,
      fixture.sandboxPath,
    ]);
    const anchor = await spawn(spawner, request);
    const transport = spawner.providerStdioFor(request.intent.processRef);
    expect(transport).toMatchObject({
      processRef: request.intent.processRef,
      capabilityVersion: NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION,
      capabilityHash: NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH,
      maxOutputBytes: request.resourcePolicy.maxOutputBytes,
    });
    if (!transport) throw new Error('owner-anchor-provider-stdio-missing');
    expect(transport.stdout).not.toBe(anchor.statusSource);
    expect(transport.stdout.readableHighWaterMark).toBeLessThanOrEqual(
      request.resourcePolicy.maxOutputBytes
    );
    expect(transport.stderr.readableHighWaterMark).toBeLessThanOrEqual(
      request.resourcePolicy.maxOutputBytes
    );

    const status = new NodeAnchorStatusReader(anchor.statusSource);
    const deadline = createProcessSupervisionDeadline(clock, 8_000);
    await expect(status.readReady(deadline, clock, harness.cancellation)).resolves.toMatchObject({
      protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
      type: 'ready',
      processRef: request.intent.processRef,
    });

    const stdout = readToEnd(transport.stdout, request.resourcePolicy.maxOutputBytes);
    const stderr = readToEnd(transport.stderr, request.resourcePolicy.maxOutputBytes);
    transport.stdin.end('provider-input');

    await expect(stdout).resolves.toBe(
      `${JSON.stringify({
        stream: 'stdout',
        input: 'provider-input',
        inheritedSandboxDescriptors: [],
      })}\n`
    );
    await expect(stderr).resolves.toBe('stderr:provider-input\n');
    await expect(status.readDrain(deadline, clock, harness.cancellation)).resolves.toMatchObject({
      type: 'drained',
      outcome: 'drained',
    });
    await waitForOwnerEof(anchor, harness.cancellation);
    expect(spawner.providerStdioFor(request.intent.processRef)).toBeUndefined();
    expect(transport.stdin.destroyed).toBe(true);
    expect(transport.stdout.destroyed).toBe(true);
    expect(transport.stderr.destroyed).toBe(true);
  }, 15_000);

  it('drains terminal raw output for an active subscriber before disposal', async () => {
    const observed: { child?: ChildProcess } = {};
    const spawner = harness.createSpawner({
      providerStdio: 'pipe',
      spawnProcess(command, args, options) {
        const child = spawnChildProcess(command, args, options);
        observed.child = child;
        return child;
      },
    });
    const baseRequest = harness.request('owner-terminal-output', [
      '-e',
      providerTerminalOutputProgram,
    ]);
    const request: AnchorSpawnRequest = {
      ...baseRequest,
      resourcePolicy: { ...baseRequest.resourcePolicy, maxOutputBytes: 1024 * 1024 },
    };
    const anchor = await spawn(spawner, request);
    const transport = spawner.providerStdioFor(request.intent.processRef);
    const child = observed.child;
    if (!transport || !child) throw new Error('owner-anchor-terminal-output-missing');
    const rawStdout = Array.from(child.stdio)[7];
    if (!(rawStdout instanceof Readable)) throw new Error('owner-anchor-raw-stdout-missing');
    const stdout = observeProviderOutput(transport.stdout);
    const status = new NodeAnchorStatusReader(anchor.statusSource);
    const deadline = createProcessSupervisionDeadline(clock, 8_000);
    await expect(status.readReady(deadline, clock, harness.cancellation)).resolves.toMatchObject({
      type: 'ready',
      sequence: 1,
    });
    await stdout.waitForBytes(256 * 1024);

    rawStdout.pause();
    const childExit = new Promise<void>((resolve) => {
      child.once('exit', () => {
        rawStdout.resume();
        resolve();
      });
    });
    transport.stdin.end();
    await expect(status.readDrain(deadline, clock, harness.cancellation)).resolves.toMatchObject({
      type: 'drained',
    });
    await childExit;
    await waitForOwnerEof(anchor, harness.cancellation);
    const result = await stdout.completion;
    expect(result.error).toBeUndefined();
    expect(result.bytes).toEqual(
      Buffer.concat([Buffer.alloc(256 * 1024, 0x70), Buffer.alloc(4 * 1024, 0x74)])
    );
    expect(transport.stdout.destroyed).toBe(true);
  }, 15_000);

  it('closes saturated unread provider ends after an exact stop without mixing bytes into status', async () => {
    const observed: { child?: ChildProcess } = {};
    const spawner = harness.createSpawner({
      providerStdio: 'pipe',
      spawnProcess(command, args, options) {
        const child = spawnChildProcess(command, args, options);
        observed.child = child;
        return child;
      },
    });
    const emissionMarkerPath = path.join(fixture.sandboxPath, 'provider-flood-emitted');
    const baseRequest = harness.request('owner-stop', [
      '-e',
      providerFloodProgram,
      emissionMarkerPath,
    ]);
    // Saturation is separate from budget rejection: allow buffers to fill below the limit.
    const request: AnchorSpawnRequest = {
      ...baseRequest,
      resourcePolicy: { ...baseRequest.resourcePolicy, maxOutputBytes: 1024 * 1024 },
    };
    const anchor = await spawn(spawner, request);
    const transport = spawner.providerStdioFor(request.intent.processRef);
    if (!transport) throw new Error('owner-anchor-provider-stdio-missing');
    const status = new NodeAnchorStatusReader(anchor.statusSource);
    const control = new NodeAnchorControlChannel(anchor.channelRef, anchor.controlSink);
    const deadline = createProcessSupervisionDeadline(clock, 8_000);

    await expect(status.readReady(deadline, clock, harness.cancellation)).resolves.toMatchObject({
      type: 'ready',
      sequence: 1,
    });
    await waitForFileContents(emissionMarkerPath, 'stdout-backpressured');
    expect(transport.stdout.readableLength).toBeGreaterThanOrEqual(
      transport.stdout.readableHighWaterMark
    );
    await control.writeStop(
      stopFrame(request, 'immediate', 0),
      deadline,
      clock,
      harness.cancellation
    );
    await expect(status.readDrain(deadline, clock, harness.cancellation)).resolves.toMatchObject({
      type: 'drained',
      residuals: [],
    });
    await waitForOwnerEof(anchor, harness.cancellation);
    expect(spawner.providerStdioFor(request.intent.processRef)).toBeUndefined();
    expect([transport.stdin, transport.stdout, transport.stderr].every((stream) => stream.destroyed))
      .toBe(true);
    const observedChild = observed.child;
    expect(observedChild).toBeDefined();
    if (!observedChild) throw new Error('owner-anchor-observed-child-missing');
    const observedStdio = Array.from(observedChild.stdio);
    expect(observedStdio[6]?.destroyed).toBe(true);
    expect(observedStdio[7]?.destroyed).toBe(true);
    expect(observedStdio[8]?.destroyed).toBe(true);
  }, 15_000);

  it('bounds cleanup when a real output subscriber stalls at terminal exit', async () => {
    const spawner = harness.createSpawner({ providerStdio: 'pipe' });
    const emissionMarkerPath = path.join(fixture.sandboxPath, 'provider-stalled-emitted');
    const baseRequest = harness.request('owner-stalled', [
      '-e',
      providerTriggeredFloodProgram,
      emissionMarkerPath,
    ]);
    const request: AnchorSpawnRequest = {
      ...baseRequest,
      resourcePolicy: { ...baseRequest.resourcePolicy, maxOutputBytes: 1024 * 1024 },
    };
    const anchor = await spawn(spawner, request);
    const transport = spawner.providerStdioFor(request.intent.processRef);
    if (!transport) throw new Error('owner-anchor-provider-stdio-missing');
    const status = new NodeAnchorStatusReader(anchor.statusSource);
    const control = new NodeAnchorControlChannel(anchor.channelRef, anchor.controlSink);
    const deadline = createProcessSupervisionDeadline(clock, 8_000);
    await expect(status.readReady(deadline, clock, harness.cancellation)).resolves.toMatchObject({
      type: 'ready',
      sequence: 1,
    });

    transport.stdout.on('data', () => undefined);
    transport.stdout.pause();
    transport.stdin.write('flood');
    await waitForFileContents(emissionMarkerPath, 'stdout-backpressured');
    expect(transport.stdout.listenerCount('data')).toBeGreaterThan(0);
    expect(transport.stdout.readableLength).toBeGreaterThanOrEqual(
      transport.stdout.readableHighWaterMark
    );
    await control.writeStop(
      stopFrame(request, 'immediate', 0),
      deadline,
      clock,
      harness.cancellation
    );
    await expect(status.readDrain(deadline, clock, harness.cancellation)).resolves.toMatchObject({
      type: 'drained',
      residuals: [],
    });
    await waitForBoundedOwnerEof(anchor, harness.cancellation, 2_500);
    expect(spawner.providerStdioFor(request.intent.processRef)).toBeUndefined();
    expect([transport.stdin, transport.stdout, transport.stderr].every((stream) => stream.destroyed))
      .toBe(true);
  }, 15_000);

  it.each([
    ['at', false],
    ['over', true],
  ] as const)(
    'enforces the shared stdout/stderr output budget %s its limit',
    async (_boundary, exceedBudget) => {
      const spawner = harness.createSpawner({ providerStdio: 'pipe' });
      const request = harness.request('owner-budget', [
        '-e',
        providerCombinedBudgetProgram,
        exceedBudget ? 'over' : 'at',
      ]);
      const anchor = await spawn(spawner, request);
      const transport = spawner.providerStdioFor(request.intent.processRef);
      if (!transport) throw new Error('owner-anchor-provider-stdio-missing');
      const stdout = observeProviderOutput(transport.stdout);
      const stderr = observeProviderOutput(transport.stderr);
      const status = new NodeAnchorStatusReader(anchor.statusSource);
      const deadline = createProcessSupervisionDeadline(clock, 8_000);
      const halfBudget = request.resourcePolicy.maxOutputBytes / 2;

      await expect(status.readReady(deadline, clock, harness.cancellation)).resolves.toMatchObject({
        type: 'ready',
        sequence: 1,
      });
      await stdout.waitForBytes(halfBudget);
      transport.stdin.write('1');
      await stderr.waitForBytes(halfBudget);
      transport.stdin.write('2');

      await expect(status.readDrain(deadline, clock, harness.cancellation)).resolves.toMatchObject({
        type: 'drained',
      });
      await waitForOwnerEof(anchor, harness.cancellation);
      const [stdoutResult, stderrResult] = await Promise.all([
        stdout.completion,
        stderr.completion,
      ]);
      expect(stdoutResult.bytes.byteLength).toBe(halfBudget);
      expect(stderrResult.bytes.byteLength).toBe(halfBudget);
      expect(stdoutResult.bytes.byteLength + stderrResult.bytes.byteLength).toBe(
        request.resourcePolicy.maxOutputBytes
      );
      expect(stdoutResult.error).toBeUndefined();
      if (exceedBudget) {
        expect(stderrResult.error?.message).toBe('node-anchor-provider-output-limit');
      } else {
        expect(stderrResult.error).toBeUndefined();
      }
      expect(spawner.providerStdioFor(request.intent.processRef)).toBeUndefined();
    },
    15_000
  );

  it('rejects an anchor launch whose private provider-stdio capability hash is incompatible', async () => {
    const spawner = harness.createSpawner({
      providerStdio: 'pipe',
      spawnProcess(command, args, options) {
        const child = spawnChildProcess(command, args, options);
        replaceLaunchWriterWithIncompatibleCapability(child);
        return child;
      },
    });
    const request = harness.request('owner-incompatible');
    const anchor = await spawn(spawner, request);
    const transport = spawner.providerStdioFor(request.intent.processRef);
    expect(transport).toBeDefined();
    const status = new NodeAnchorStatusReader(anchor.statusSource);

    await expect(
      status.readReady(
        createProcessSupervisionDeadline(clock, 3_000),
        clock,
        harness.cancellation
      )
    ).rejects.toThrow('process-supervision-protocol-error:ready-order');
    await waitForOwnerEof(anchor, harness.cancellation);
    expect(spawner.providerStdioFor(request.intent.processRef)).toBeUndefined();
    expect(transport?.stdin.destroyed).toBe(true);
    expect(transport?.stdout.destroyed).toBe(true);
    expect(transport?.stderr.destroyed).toBe(true);
  }, 10_000);

  async function spawn(
    spawner: NodeAnchorSpawner,
    request: AnchorSpawnRequest
  ): Promise<SpawnedAnchor> {
    const result = await spawner.spawn(request, {
      remainingTimeMs: 8_000,
      cancellation: harness.cancellation,
    });
    expect(result.status).toBe('spawned');
    if (result.status !== 'spawned') throw new Error(`anchor-spawn-${result.status}`);
    spawned.push(result);
    return result;
  }
});

const providerEchoProgram = String.raw`
const fs = require('node:fs');
const sandbox = process.argv[1];
const inheritedSandboxDescriptors = [];
for (let descriptor = 3; descriptor < 32; descriptor += 1) {
  try {
    const target = fs.readlinkSync('/proc/self/fd/' + descriptor);
    if (target.includes(sandbox)) inheritedSandboxDescriptors.push({ descriptor, target });
  } catch {}
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ stream: 'stdout', input, inheritedSandboxDescriptors }) + '\n');
  process.stderr.write('stderr:' + input + '\n');
});
`;

const providerTerminalOutputProgram = String.raw`
const fs = require('node:fs');
process.stdout.write(Buffer.alloc(256 * 1024, 0x70));
process.stdin.resume();
process.stdin.once('end', () => fs.writeSync(1, Buffer.alloc(4 * 1024, 0x74)));
`;

const providerFloodProgram = String.raw`
const fs = require('node:fs');
const markerPath = process.argv[1];
const statusShapedProviderBytes = JSON.stringify({ protocolVersion: 1, type: 'drained', sequence: 999 });
const chunk = Buffer.from((statusShapedProviderBytes + '\n').repeat(16));
while (process.stdout.write(chunk)) {}
fs.writeFileSync(markerPath, 'stdout-backpressured');
setInterval(() => {}, 1000);
`;

const providerTriggeredFloodProgram = String.raw`
const fs = require('node:fs');
const markerPath = process.argv[1];
const chunk = Buffer.alloc(4 * 1024, 0x73);
process.stdin.once('data', () => {
  while (process.stdout.write(chunk)) {}
  fs.writeFileSync(markerPath, 'stdout-backpressured');
  setInterval(() => {}, 1000);
});
`;

const providerCombinedBudgetProgram = String.raw`
const boundary = process.argv[1];
const halfBudget = 32 * 1024;
let phase = 0;
process.stderr.on('error', () => {});
process.stdout.write(Buffer.alloc(halfBudget, 0x6f));
process.stdin.on('data', () => {
  if (phase === 0) {
    phase = 1;
    process.stderr.write(Buffer.alloc(halfBudget, 0x65));
    return;
  }
  if (phase === 1) {
    phase = 2;
    if (boundary === 'over') process.stderr.write(Buffer.from('x'));
    process.stdin.destroy();
  }
});
`;

function replaceLaunchWriterWithIncompatibleCapability(child: ChildProcess): void {
  const launch = child.stdio[3];
  if (!(launch instanceof Writable)) throw new Error('owner-anchor-launch-pipe-missing');
  const proxy = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      const incompatible = chunk
        .toString('utf8')
        .replace(NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH, `sha256:${'0'.repeat(64)}`);
      launch.write(incompatible, callback);
    },
    final(callback): void {
      launch.end(callback);
    },
  });
  (child.stdio as unknown as Array<NodeJS.ReadableStream | NodeJS.WritableStream | null>)[3] =
    proxy;
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

async function waitForOwnerEof(
  anchor: SpawnedAnchor,
  cancellation: RuntimeCancellation
): Promise<void> {
  const result = await anchor.owningProcess.waitForEof({
    attestation: anchor.ownerAttestation as ProcessOwnerAttestation,
    remainingTimeMs: 6_000,
    cancellation,
  });
  expect(result).toMatchObject({ status: 'eof', ownerAttestation: anchor.ownerAttestation });
}

async function waitForBoundedOwnerEof(
  anchor: SpawnedAnchor,
  cancellation: RuntimeCancellation,
  maximumMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      waitForOwnerEof(anchor, cancellation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('owner-anchor-provider-cleanup-timeout')),
          maximumMs
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFileContents(filePath: string, expected: string): Promise<void> {
  const expiresAt = performance.now() + 3_000;
  do {
    try {
      if ((await readFile(filePath, 'utf8')) === expected) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < expiresAt);
  throw new Error('owner-anchor-provider-emission-timeout');
}

function observeProviderOutput(stream: Readable): {
  readonly waitForBytes: (minimumBytes: number) => Promise<void>;
  readonly completion: Promise<{ readonly bytes: Buffer; readonly error?: Error }>;
} {
  const chunks: Buffer[] = [];
  let total = 0;
  let streamError: Error | undefined;
  let settle: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  stream.on('data', (chunk: Buffer | Uint8Array) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    total += bytes.byteLength;
  });
  stream.once('error', (error: Error) => {
    streamError = error;
  });
  stream.once('end', () => settle?.());
  stream.once('close', () => settle?.());
  // The spawner explicitly pauses outputs; this observer is an active consumer.
  stream.resume();
  return {
    async waitForBytes(minimumBytes: number): Promise<void> {
      const expiresAt = performance.now() + 3_000;
      while (total < minimumBytes && performance.now() < expiresAt) {
        await Promise.race([
          settled,
          new Promise((resolve) => setTimeout(resolve, 10)),
        ]);
      }
      if (total < minimumBytes) throw new Error('owner-anchor-provider-output-timeout');
    },
    completion: settled.then(() => ({
      bytes: Buffer.concat(chunks),
      ...(streamError ? { error: streamError } : {}),
    })),
  };
}

async function readToEnd(stream: Readable, maximumBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maximumBytes) throw new Error('owner-anchor-provider-output-limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
