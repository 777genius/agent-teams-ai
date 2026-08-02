import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';

import {
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseMainProcessIdentityRef,
  parseOwningProcessIdentityRef,
  parseProcessOwnerAttestation,
  PROCESS_OWNER_ATTESTATION_VERSION,
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  type ProcessOwnerAttestation,
} from '../../../contracts/processSupervision';
import { spawnNonceDigest } from '../../../core/domain/process-supervision';

import {
  type MaterializedNodeAnchorLaunch,
  NodeAnchorLaunchMaterializer,
} from './NodeAnchorLaunchMaterializer';
import { NodeAttestedOwningProcess } from './NodeAttestedOwningProcess';

import type { RuntimeCancellation } from '../../../core/application/ports';
import type {
  AnchorSpawnPort,
  AnchorSpawnRequest,
  AnchorSpawnResult,
} from '../../adapters/output/process-supervision/AnchorProcessSupervisorAdapter';
import type { NodeAnchorControlSink } from './NodeAnchorControlChannel';
import type { NodeAnchorStatusSource } from './NodeAnchorStatusDecoder';

export const NODE_ANCHOR_MAX_LAUNCH_FRAME_BYTES = 512 * 1_024;
const NODE_ANCHOR_GRACEFUL_CLEANUP_MS = 1_000;
const NODE_ANCHOR_FORCED_CLEANUP_MS = 5_000;

export type NodeAnchorSpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

export interface NodeAnchorSpawnerOptions {
  readonly anchorExecutablePath: string;
  readonly neutralWorkingDirectory: string;
  readonly materializer: NodeAnchorLaunchMaterializer;
  readonly maxLaunchFrameBytes?: number;
  readonly spawnProcess?: NodeAnchorSpawnProcess;
  readonly monotonicNow?: () => number;
}

interface AnchorLaunchWireFrame {
  readonly protocolVersion: typeof PROCESS_SUPERVISION_PROTOCOL_VERSION;
  readonly processRef: string;
  readonly teamId: string;
  readonly runId: string;
  readonly generation: number;
  readonly planHash: string;
  readonly executionUnitId: string;
  readonly spawnNonceDigest: string;
  readonly channelRef: string;
  readonly workspaceBinding: {
    readonly workspaceId: string;
    readonly registrationRevision: number;
    readonly bindingGeneration: number;
    readonly mountGeneration: number;
  };
  readonly anchorIdentityRef: string;
  readonly mainProcessIdentityRef: string;
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly workdirPath: string;
  readonly environment: readonly Readonly<{ name: string; value: string }>[];
  readonly maxRuntimeMs: number;
  readonly gracefulStopMs: number;
  readonly maxProcessCount: number;
}

/** Linux Node implementation of the adapter-owned AnchorSpawnPort. */
export class NodeAnchorSpawner implements AnchorSpawnPort {
  private readonly maxLaunchFrameBytes: number;
  private readonly spawnProcess: NodeAnchorSpawnProcess;
  private readonly monotonicNow: () => number;

  constructor(private readonly options: NodeAnchorSpawnerOptions) {
    this.maxLaunchFrameBytes = options.maxLaunchFrameBytes ?? NODE_ANCHOR_MAX_LAUNCH_FRAME_BYTES;
    this.spawnProcess =
      options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    if (
      !Number.isSafeInteger(this.maxLaunchFrameBytes) ||
      this.maxLaunchFrameBytes < 1 ||
      this.maxLaunchFrameBytes > NODE_ANCHOR_MAX_LAUNCH_FRAME_BYTES
    ) {
      throw new TypeError('node-anchor-launch-frame-limit-invalid');
    }
  }

  async spawn(
    request: AnchorSpawnRequest,
    options: {
      readonly remainingTimeMs: number;
      readonly cancellation: RuntimeCancellation;
    }
  ): Promise<AnchorSpawnResult> {
    if (process.platform !== 'linux') return { status: 'unavailable' };
    if (!hasBudget(options.remainingTimeMs)) return { status: 'timed_out' };
    if (isCancelled(options.cancellation)) return { status: 'cancelled' };

    const deadline = createNodeAnchorDeadline(options.remainingTimeMs, this.monotonicNow);
    let materialized: MaterializedNodeAnchorLaunch | undefined;
    let child: ChildProcess | undefined;
    let childClose: Promise<void> | undefined;
    let control: Writable | null | undefined;
    let status: Readable | null | undefined;
    let launch: Writable | null | undefined;
    try {
      const materialization = this.options.materializer.materialize(request);
      try {
        materialized = await runWithinDeadline(materialization, deadline, options.cancellation);
      } catch (error) {
        void materialization.then(
          async (lateMaterialization) => await lateMaterialization.close().catch(() => undefined),
          () => undefined
        );
        throw error;
      }

      const [anchorExecutablePath, neutralWorkingDirectory] = await runWithinBudget(
        Promise.all([
          resolveRegularFile(this.options.anchorExecutablePath),
          resolveDirectory(this.options.neutralWorkingDirectory),
        ]),
        remainingNodeAnchorTime(deadline),
        options.cancellation
      );
      const channelRef = parseAnchorChannelRef(`anchor-channel:${randomUUID()}`);
      const anchorIdentityRef = parseAnchorIdentityRef(`anchor-identity:${randomUUID()}`);
      const owningProcessIdentityRef = parseOwningProcessIdentityRef(
        `owning-process:${randomUUID()}`
      );
      const mainProcessIdentityRef = parseMainProcessIdentityRef(`main-process:${randomUUID()}`);
      const nonceDigest = spawnNonceDigest(request.intent.spawnNonce);
      const launchFrame: AnchorLaunchWireFrame = Object.freeze({
        protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
        processRef: request.intent.processRef,
        teamId: request.intent.scope.planRef.teamId,
        runId: request.intent.scope.planRef.runId,
        generation: request.intent.scope.planRef.generation,
        planHash: request.intent.scope.planRef.planHash,
        executionUnitId: request.intent.scope.executionUnitId,
        spawnNonceDigest: nonceDigest,
        channelRef,
        workspaceBinding: request.intent.workspaceBinding,
        anchorIdentityRef,
        mainProcessIdentityRef,
        executablePath: materialized.executablePath,
        argv: materialized.argv,
        workdirPath: materialized.workdirPath,
        environment: materialized.environment,
        maxRuntimeMs: request.resourcePolicy.maxRuntimeMs,
        gracefulStopMs: request.resourcePolicy.gracefulStopMs,
        maxProcessCount: request.resourcePolicy.maxProcessCount,
      });
      const launchBytes = encodeLaunchFrame(launchFrame, this.maxLaunchFrameBytes);
      requireActiveDeadline(deadline, options.cancellation);

      child = this.spawnProcess(anchorExecutablePath, [], {
        cwd: neutralWorkingDirectory,
        env: {},
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: [
          'pipe',
          'pipe',
          'ignore',
          'pipe',
          materialized.executableDescriptor,
          materialized.workdirDescriptor,
        ],
      });
      childClose = observeChildClose(child);
      control = child.stdin;
      status = child.stdout;
      launch = child.stdio[3] as Writable | null;
      if (
        !(control instanceof Writable) ||
        !(status instanceof Readable) ||
        !(launch instanceof Writable)
      ) {
        throw new NodeAnchorUnavailableError('node-anchor-stdio-unavailable');
      }

      await runWithinDeadline(waitForSpawn(child), deadline, options.cancellation);
      const descriptorClose = materialized.close();
      materialized = undefined;
      await runWithinDeadline(descriptorClose, deadline, options.cancellation);
      const ownerAttestation = createOwnerAttestation({
        request,
        channelRef,
        anchorIdentityRef,
        owningProcessIdentityRef,
        nonceDigest,
      });
      const owningProcess = new NodeAttestedOwningProcess(child, ownerAttestation);
      await runWithinDeadline(endWithBytes(launch, launchBytes), deadline, options.cancellation);

      return {
        status: 'spawned',
        channelRef,
        controlSink: new NodeWritableAnchorControlSink(control),
        statusSource: new NodeReadableAnchorStatusSource(status),
        ownerAttestation,
        owningProcess,
      };
    } catch (error) {
      await materialized?.close().catch(() => undefined);
      if (child) {
        await terminateAndReapAnchor(child, childClose!, control, status, launch);
      }
      if (error instanceof NodeAnchorCancelledError || isCancelled(options.cancellation)) {
        return { status: 'cancelled' };
      }
      if (error instanceof NodeAnchorTimeoutError) return { status: 'timed_out' };
      return { status: 'unavailable' };
    }
  }
}

class NodeWritableAnchorControlSink implements NodeAnchorControlSink {
  private closed = false;

  constructor(private readonly stream: Writable) {}

  async write(
    bytes: Uint8Array,
    options: { readonly remainingTimeMs: number; readonly cancellation: RuntimeCancellation }
  ): Promise<void> {
    if (this.closed) throw new Error('node-anchor-control-closed');
    await runWithinBudget(
      writeBytes(this.stream, bytes),
      options.remainingTimeMs,
      options.cancellation
    );
  }

  async close(options: {
    readonly remainingTimeMs: number;
    readonly cancellation: RuntimeCancellation;
  }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await runWithinBudget(endStream(this.stream), options.remainingTimeMs, options.cancellation);
  }
}

class NodeReadableAnchorStatusSource implements NodeAnchorStatusSource {
  constructor(private readonly stream: Readable) {}

  async inspect(options: {
    readonly remainingTimeMs: number;
    readonly cancellation: RuntimeCancellation;
  }): Promise<{ readonly status: 'live' | 'eof' | 'unavailable' }> {
    if (!hasBudget(options.remainingTimeMs) || isCancelled(options.cancellation)) {
      return { status: 'unavailable' };
    }
    if (this.stream.errored) return { status: 'unavailable' };
    return this.stream.readableEnded || this.stream.destroyed
      ? { status: 'eof' }
      : { status: 'live' };
  }

  async read(options: {
    readonly remainingTimeMs: number;
    readonly cancellation: RuntimeCancellation;
  }): Promise<
    { readonly status: 'chunk'; readonly bytes: Uint8Array } | { readonly status: 'eof' }
  > {
    return await runWithinBudget(
      readChunk(this.stream),
      options.remainingTimeMs,
      options.cancellation
    );
  }
}

function createOwnerAttestation(input: {
  readonly request: AnchorSpawnRequest;
  readonly channelRef: ReturnType<typeof parseAnchorChannelRef>;
  readonly anchorIdentityRef: ReturnType<typeof parseAnchorIdentityRef>;
  readonly owningProcessIdentityRef: ReturnType<typeof parseOwningProcessIdentityRef>;
  readonly nonceDigest: ReturnType<typeof spawnNonceDigest>;
}): ProcessOwnerAttestation {
  return parseProcessOwnerAttestation({
    attestationVersion: PROCESS_OWNER_ATTESTATION_VERSION,
    processRef: input.request.intent.processRef,
    scope: input.request.intent.scope,
    workspaceBinding: input.request.intent.workspaceBinding,
    spawnNonceDigest: input.nonceDigest,
    channelRef: input.channelRef,
    owningProcessIdentityRef: input.owningProcessIdentityRef,
    anchorIdentityRef: input.anchorIdentityRef,
  });
}

function encodeLaunchFrame(frame: AnchorLaunchWireFrame, maximumBytes: number): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
  if (bytes.byteLength > maximumBytes) throw new TypeError('node-anchor-launch-frame-too-large');
  return bytes;
}

async function resolveRegularFile(value: string): Promise<string> {
  const resolved = await resolveAbsolute(value);
  if (!(await lstat(resolved)).isFile()) throw new TypeError('node-anchor-executable-not-file');
  return resolved;
}

async function resolveDirectory(value: string): Promise<string> {
  const resolved = await resolveAbsolute(value);
  if (!(await lstat(resolved)).isDirectory()) throw new TypeError('node-anchor-cwd-not-directory');
  return resolved;
}

async function resolveAbsolute(value: string): Promise<string> {
  if (!path.isAbsolute(value) || value.includes('\u0000')) {
    throw new TypeError('node-anchor-path-invalid');
  }
  return await realpath(value);
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function endWithBytes(stream: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    stream.once('error', onError);
    stream.end(bytes, () => {
      stream.off('error', onError);
      resolve();
    });
  });
}

function writeBytes(stream: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    stream.once('error', onError);
    stream.write(bytes, (error?: Error | null) => {
      stream.off('error', onError);
      if (error) reject(error);
      else resolve();
    });
  });
}

function endStream(stream: Writable): Promise<void> {
  if (stream.writableEnded || stream.destroyed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    stream.once('error', onError);
    stream.end(() => {
      stream.off('error', onError);
      resolve();
    });
  });
}

function readChunk(
  stream: Readable
): Promise<{ readonly status: 'chunk'; readonly bytes: Uint8Array } | { readonly status: 'eof' }> {
  const immediate = stream.read() as Buffer | null;
  if (immediate) return Promise.resolve({ status: 'chunk', bytes: new Uint8Array(immediate) });
  if (stream.readableEnded || stream.destroyed) return Promise.resolve({ status: 'eof' });

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const onReadable = (): void => {
      const chunk = stream.read() as Buffer | null;
      if (!chunk) return;
      cleanup();
      resolve({ status: 'chunk', bytes: new Uint8Array(chunk) });
    };
    const onEnd = (): void => {
      cleanup();
      resolve({ status: 'eof' });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    stream.once('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

class NodeAnchorTimeoutError extends Error {}
class NodeAnchorCancelledError extends Error {}
class NodeAnchorUnavailableError extends Error {}

interface NodeAnchorDeadline {
  readonly expiresAt: number;
  readonly now: () => number;
}

function createNodeAnchorDeadline(remainingTimeMs: number, now: () => number): NodeAnchorDeadline {
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new NodeAnchorTimeoutError();
  return Object.freeze({ expiresAt: startedAt + remainingTimeMs, now });
}

function remainingNodeAnchorTime(deadline: NodeAnchorDeadline): number {
  const remaining = deadline.expiresAt - deadline.now();
  if (!hasBudget(remaining)) throw new NodeAnchorTimeoutError();
  return remaining;
}

function requireActiveDeadline(
  deadline: NodeAnchorDeadline,
  cancellation: RuntimeCancellation
): void {
  if (isCancelled(cancellation)) throw new NodeAnchorCancelledError();
  remainingNodeAnchorTime(deadline);
}

async function runWithinDeadline<T>(
  effect: Promise<T>,
  deadline: NodeAnchorDeadline,
  cancellation: RuntimeCancellation
): Promise<T> {
  return await runWithinBudget(effect, remainingNodeAnchorTime(deadline), cancellation);
}

async function terminateAndReapAnchor(
  child: ChildProcess,
  childClose: Promise<void>,
  control: Writable | null | undefined,
  status: Readable | null | undefined,
  launch: Writable | null | undefined
): Promise<void> {
  if (launch instanceof Writable && !launch.destroyed) launch.destroy();
  if (status instanceof Readable && !status.destroyed) status.resume();
  if (control instanceof Writable && !control.destroyed && !control.writableEnded) control.end();
  if (await waitForChildClose(childClose, NODE_ANCHOR_GRACEFUL_CLEANUP_MS)) return;

  if (!child.killed) child.kill('SIGKILL');
  if (!(await waitForChildClose(childClose, NODE_ANCHOR_FORCED_CLEANUP_MS))) {
    throw new NodeAnchorUnavailableError('node-anchor-cleanup-timeout');
  }
}

function observeChildClose(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => child.once('close', () => resolve()));
}

async function waitForChildClose(childClose: Promise<void>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => settle(false), timeoutMs);
    void childClose.then(
      () => settle(true),
      () => settle(false)
    );
  });
}

async function runWithinBudget<T>(
  effect: Promise<T>,
  remainingTimeMs: number,
  cancellation: RuntimeCancellation
): Promise<T> {
  if (!hasBudget(remainingTimeMs)) throw new NodeAnchorTimeoutError();
  if (isCancelled(cancellation)) throw new NodeAnchorCancelledError();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancellationPoll);
      callback();
    };
    const timeout = setTimeout(
      () => settle(() => reject(new NodeAnchorTimeoutError())),
      Math.min(Math.ceil(remainingTimeMs), 2_147_483_647)
    );
    const cancellationPoll = setInterval(
      () => {
        if (isCancelled(cancellation)) settle(() => reject(new NodeAnchorCancelledError()));
      },
      Math.min(5, Math.max(1, Math.ceil(remainingTimeMs)))
    );
    void effect.then(
      (value) =>
        isCancelled(cancellation)
          ? settle(() => reject(new NodeAnchorCancelledError()))
          : settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error))
    );
  });
}

function hasBudget(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isCancelled(cancellation: RuntimeCancellation): boolean {
  try {
    return cancellation.isCancellationRequested();
  } catch {
    return true;
  }
}
