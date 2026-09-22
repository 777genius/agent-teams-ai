import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, Transform, Writable } from 'node:stream';

import {
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseMainProcessIdentityRef,
  parseOwningProcessIdentityRef,
  parseProcessOwnerAttestation,
  parseProcessOwnerBinding,
  PROCESS_OWNER_ATTESTATION_VERSION,
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  type ProcessOwnerAttestation,
  type ProcessOwnerBinding,
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
export const NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION = 1 as const;
export const NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH =
  'sha256:8ef0fab620172bdb761af87fc471cb3a1abb46710f148037762cee5d403720b5' as const;
const NODE_ANCHOR_GRACEFUL_CLEANUP_MS = 1_000;
const NODE_ANCHOR_FORCED_CLEANUP_MS = 5_000;
const NODE_ANCHOR_PROVIDER_OUTPUT_FINISH_MS = 1_000;

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
  readonly ownerBinding?: ProcessOwnerBinding;
  /** Opts this spawner into the private fd6/fd7/fd8 provider transport. */
  readonly providerStdio?: 'pipe';
}

/** Boot-local provider pipes. These are never persisted or reconstructed from a process id. */
export interface NodeAnchorProviderStdio {
  readonly processRef: string;
  readonly capabilityVersion: typeof NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION;
  readonly capabilityHash: typeof NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly maxOutputBytes: number;
  close(): void;
}

interface ManagedNodeAnchorProviderStdio extends NodeAnchorProviderStdio {
  finishAfterAnchorExit(): void;
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
    readonly registeredDevice: string;
    readonly registeredInode: string;
    readonly registeredMountId: string;
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
  readonly transportCapabilityVersion?: typeof NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION;
  readonly transportCapabilityHash?: typeof NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH;
  readonly providerStdio?: 'pipe';
}

/** Linux Node implementation of the adapter-owned AnchorSpawnPort. */
export class NodeAnchorSpawner implements AnchorSpawnPort {
  private readonly maxLaunchFrameBytes: number;
  private readonly spawnProcess: NodeAnchorSpawnProcess;
  private readonly monotonicNow: () => number;
  private readonly ownerBinding: ProcessOwnerBinding | undefined;
  private readonly providerStdio = new Map<string, NodeAnchorProviderStdio>();

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
    this.ownerBinding =
      options.ownerBinding === undefined
        ? undefined
        : parseProcessOwnerBinding(options.ownerBinding);
    if (options.providerStdio !== undefined && options.providerStdio !== 'pipe') {
      throw new TypeError('node-anchor-provider-stdio-mode-invalid');
    }
  }

  /** Returns only the live, exact processRef-owned transport from this controller boot. */
  providerStdioFor(processRef: string): NodeAnchorProviderStdio | undefined {
    return this.providerStdio.get(processRef);
  }

  /** Closes and forgets one exact boot-local transport without any PID fallback. */
  closeProviderStdio(processRef: string): void {
    const transport = this.providerStdio.get(processRef);
    if (!transport) return;
    this.providerStdio.delete(processRef);
    transport.close();
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
    let providerStdio: ManagedNodeAnchorProviderStdio | undefined;
    try {
      let materialization: Promise<MaterializedNodeAnchorLaunch> | undefined;
      try {
        materialized = await runWithinDeadline(
          () => {
            materialization = this.options.materializer.materialize(request);
            return materialization;
          },
          deadline,
          options.cancellation
        );
      } catch (error) {
        void materialization?.then(
          async (lateMaterialization) => await lateMaterialization.close().catch(() => undefined),
          () => undefined
        );
        throw error;
      }

      const [anchorExecutablePath, neutralWorkingDirectory] = await runWithinBudget(
        () =>
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
        workspaceBinding: {
          ...request.intent.workspaceBinding,
          registeredDevice: materialized.registeredRootEvidence.device.toString(10),
          registeredInode: materialized.registeredRootEvidence.inode.toString(10),
          registeredMountId: materialized.registeredRootEvidence.mountId.toString(10),
        },
        anchorIdentityRef,
        mainProcessIdentityRef,
        executablePath: materialized.executablePath,
        argv: materialized.argv,
        workdirPath: materialized.workdirPath,
        environment: materialized.environment,
        maxRuntimeMs: request.resourcePolicy.maxRuntimeMs,
        gracefulStopMs: request.resourcePolicy.gracefulStopMs,
        maxProcessCount: request.resourcePolicy.maxProcessCount,
        ...(this.options.providerStdio === 'pipe'
          ? {
              transportCapabilityVersion: NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION,
              transportCapabilityHash: NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH,
              providerStdio: 'pipe' as const,
            }
          : {}),
      });
      const launchBytes = encodeLaunchFrame(launchFrame, this.maxLaunchFrameBytes);
      requireActiveDeadline(deadline, options.cancellation);

      const stdio: SpawnOptions['stdio'] = [
        'pipe',
        'pipe',
        'ignore',
        'pipe',
        materialized.executableDescriptor,
        materialized.workdirDescriptor,
        ...(this.options.providerStdio === 'pipe' ? (['pipe', 'pipe', 'pipe'] as const) : []),
      ];
      child = this.spawnProcess(anchorExecutablePath, [], {
        cwd: neutralWorkingDirectory,
        env: {},
        shell: false,
        detached: false,
        windowsHide: true,
        stdio,
      });
      childClose = observeChildClose(child);
      const childStdio = normalizeChildStdio(child);
      control = child.stdin;
      status = child.stdout;
      const launchPipe = childStdio[3];
      launch = launchPipe instanceof Writable ? launchPipe : undefined;
      if (
        !(control instanceof Writable) ||
        !(status instanceof Readable) ||
        !(launch instanceof Writable)
      ) {
        throw new NodeAnchorUnavailableError('node-anchor-stdio-unavailable');
      }
      if (this.options.providerStdio === 'pipe') {
        const providerInput = childStdio[6];
        const providerOutput = childStdio[7];
        const providerError = childStdio[8];
        if (
          !(providerInput instanceof Writable) ||
          !(providerOutput instanceof Readable) ||
          !(providerError instanceof Readable)
        ) {
          throw new NodeAnchorUnavailableError('node-anchor-provider-stdio-unavailable');
        }
        providerStdio = createProviderStdio(
          request.intent.processRef,
          providerInput,
          providerOutput,
          providerError,
          request.resourcePolicy.maxOutputBytes
        );
        if (this.providerStdio.has(request.intent.processRef)) {
          throw new NodeAnchorUnavailableError('node-anchor-provider-stdio-ref-collision');
        }
        this.providerStdio.set(request.intent.processRef, providerStdio);
        const exactTransport = providerStdio;
        const finishExactTransport = (): void => {
          if (this.providerStdio.get(request.intent.processRef) === exactTransport) {
            this.providerStdio.delete(request.intent.processRef);
          }
          exactTransport.finishAfterAnchorExit();
        };
        // `exit` is intentionally used for transport disposal: unlike `close`, it does not wait
        // for fd7/fd8 to reach EOF through an unread, backpressured destination. Lifecycle status
        // and attested EOF remain separate proofs on fd1 and the ChildProcess `close` event.
        child.once('exit', finishExactTransport);
        child.once('close', finishExactTransport);
      }

      const spawnedChild = child;
      const launchStream = launch;
      await runWithinDeadline(() => waitForSpawn(spawnedChild), deadline, options.cancellation);
      const descriptorClose = materialized.close();
      materialized = undefined;
      await runWithinDeadline(() => descriptorClose, deadline, options.cancellation);
      const ownerAttestation = createOwnerAttestation({
        request,
        channelRef,
        anchorIdentityRef,
        owningProcessIdentityRef,
        nonceDigest,
        ownerBinding: this.ownerBinding,
      });
      const owningProcess = new NodeAttestedOwningProcess(child, ownerAttestation);
      await runWithinDeadline(
        () => endWithBytes(launchStream, launchBytes),
        deadline,
        options.cancellation
      );

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
      if (providerStdio) {
        if (this.providerStdio.get(request.intent.processRef) === providerStdio) {
          this.providerStdio.delete(request.intent.processRef);
        }
        providerStdio.close();
      }
      if (child) {
        destroyChildProviderStdio(child);
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

function normalizeChildStdio(
  child: ChildProcess
): readonly (Readable | Writable | null | undefined)[] {
  return Array.from(child.stdio);
}

function destroyChildProviderStdio(child: ChildProcess): void {
  const stdio = normalizeChildStdio(child);
  for (const descriptor of [6, 7, 8] as const) {
    const stream = stdio[descriptor];
    if ((stream instanceof Readable || stream instanceof Writable) && !stream.destroyed) {
      stream.destroy();
    }
  }
}

function createProviderStdio(
  processRef: string,
  stdin: Writable,
  rawStdout: Readable,
  rawStderr: Readable,
  maxOutputBytes: number
): ManagedNodeAnchorProviderStdio {
  const outputBudget = { remaining: maxOutputBytes };
  const stdout = createBoundedProviderOutput(rawStdout, outputBudget);
  const stderr = createBoundedProviderOutput(rawStderr, outputBudget);
  // These transforms and their kernel pipes stay paused until Owner consumes them. Their fixed
  // high-water marks propagate backpressure, while the shared budget bounds total delivered bytes.
  stdout.pause();
  stderr.pause();
  let closed = false;
  let finishing = false;
  return Object.freeze({
    processRef,
    capabilityVersion: NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION,
    capabilityHash: NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH,
    stdin,
    stdout,
    stderr,
    maxOutputBytes,
    finishAfterAnchorExit(): void {
      if (closed || finishing) return;
      finishing = true;
      if (!stdin.destroyed) stdin.destroy();
      finishProviderOutput(rawStdout, stdout);
      finishProviderOutput(rawStderr, stderr);
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (!stdin.destroyed) stdin.destroy();
      if (!rawStdout.destroyed) rawStdout.destroy();
      if (!rawStderr.destroyed) rawStderr.destroy();
      if (!stdout.destroyed) stdout.destroy();
      if (!stderr.destroyed) stderr.destroy();
    },
  });
}

function finishProviderOutput(source: Readable, output: Transform): void {
  const subscribed =
    output.listenerCount('data') > 0 ||
    output.listenerCount('readable') > 0;
  if (output.destroyed) {
    if (!source.destroyed) source.destroy();
    return;
  }
  if (!subscribed) {
    source.unpipe(output);
    if (!source.destroyed) source.destroy();
    output.destroy();
    return;
  }
  // Keep the pipe intact so an active Owner receives bytes still queued in the raw Node/kernel
  // stream. A subscribed but stalled Owner is still bounded after the exact child exit.
  const timer = setTimeout(() => {
    source.unpipe(output);
    if (!source.destroyed) source.destroy();
    if (!output.destroyed) output.destroy();
  }, NODE_ANCHOR_PROVIDER_OUTPUT_FINISH_MS);
  const cancelTimer = (): void => clearTimeout(timer);
  output.once('end', cancelTimer);
  output.once('close', cancelTimer);
  timer.unref();
  if (source.destroyed) output.end();
  else source.resume();
}

function createBoundedProviderOutput(
  source: Readable,
  budget: { remaining: number }
): Transform {
  const output = new Transform({
    highWaterMark: Math.max(1, Math.min(budget.remaining, 64 * 1_024)),
    transform(chunk: Buffer, _encoding, callback): void {
      if (chunk.byteLength > budget.remaining) {
        budget.remaining = 0;
        callback(new Error('node-anchor-provider-output-limit'));
        return;
      }
      budget.remaining -= chunk.byteLength;
      callback(null, chunk);
    },
  });
  // The internal listener prevents a pre-consumer limit violation from becoming an uncaught event.
  // Owner may attach its own listener and still receives the same terminal stream error.
  output.on('error', () => source.destroy());
  source.on('error', (error) => output.destroy(error));
  source.pipe(output);
  return output;
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
      () => writeBytes(this.stream, bytes),
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
    await runWithinBudget(
      () => endStream(this.stream),
      options.remainingTimeMs,
      options.cancellation
    );
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
      () => readChunk(this.stream),
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
  readonly ownerBinding: NodeAnchorSpawnerOptions['ownerBinding'];
}): ProcessOwnerAttestation {
  return parseProcessOwnerAttestation({
    attestationVersion: PROCESS_OWNER_ATTESTATION_VERSION,
    ...(input.ownerBinding ?? {}),
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
  effect: () => Promise<T>,
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
  effect: () => Promise<T>,
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
    void Promise.resolve()
      .then(effect)
      .then(
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
