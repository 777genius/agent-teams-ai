import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Duplex, Readable, Writable } from 'node:stream';

import { verifyStagedBroker } from './brokerArtifact.js';
import { creationFromByte, facts, nativeExitCategories, type StopFacts } from './brokerEvidence.js';
import { WindowsServiceOperations, type OwnedServicePort } from './WindowsServiceOperations.js';
import {
  encodeFrame,
  encodeLaunch,
  type Frame,
  FrameDecoder,
  generationBytes,
  Op,
} from './codec.js';
import {
  type BrokerExit,
  type ControlCause,
  type ControlDiagnostics,
  type ControlPhase,
  type Coverage,
  type Creation,
  type OwnedLaunchPort,
  type Preparation,
  type PreparedOwnedProcess,
  type ProcessOwner,
  type ResolvedLaunchSpec,
  type RootExit,
  sameOwner,
  type StopRequest,
  type TargetDrain,
  type TreeOutcome,
  type TreeReceipt,
} from './contract.js';
import { BrokerReleaseConfirmation } from './releaseConfirmation.js';

export { verifyStagedBroker } from './brokerArtifact.js';

interface Waiter {
  opcode: number;
  observation: RequestObservation;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  received?: (frame: Frame) => void;
  service?: boolean;
}
interface RequestObservation {
  phase: ControlPhase;
  writeCompleted: boolean;
}
interface StopOperation {
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  settle: (value: StopFacts | undefined) => void;
  promise: Promise<StopFacts | undefined>;
}
const remaining = (deadline: number): number =>
  Math.max(0, Math.min(60000, Math.floor(deadline - performance.now())));
function validDeadline(value: number): void {
  if (!Number.isFinite(value) || value > performance.now() + 60000)
    throw new Error('Invalid deadline');
}
/** Trusted composition seam: private broker transport only, never a provider ChildProcess. */
export interface BrokerTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly control: Duplex;
  onFailure(callback: () => void): void;
  onExit(callback: (exit: BrokerExit) => void): void;
}
export interface BrokerTransportFactory {
  available(path: string): boolean;
  connect(path: string): BrokerTransport;
}
export function connectPrivateBroker(path: string): BrokerTransport {
  const child = spawn(path, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'overlapped'],
    windowsHide: true,
  });
  const control = child.stdio[3];
  if (!(control instanceof Duplex) || !child.stdin || !child.stdout || !child.stderr) {
    throw new Error('Private control or target streams unavailable');
  }
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    control,
    onFailure: (callback) => {
      child.on('error', callback);
    },
    onExit: (callback) => {
      child.on('exit', (code, signal) => callback({ code, signal }));
    },
  };
}
const nativeTransport = (capability: 'whole-job-v1' | 'service-scopes-v1'): BrokerTransportFactory => ({
  available: (path) => {
    if (process.platform !== 'win32' || !win32.isAbsolute(path)) return false;
    try {
      verifyStagedBroker(path, process.arch, capability);
      return true;
    } catch {
      return false;
    }
  },
  connect: connectPrivateBroker,
});

class WindowsCapability implements PreparedOwnedProcess {
  readonly owner: ProcessOwner;
  private child?: BrokerTransport;
  private control?: Duplex;
  private readonly decoder: FrameDecoder;
  private readonly serviceOperations: WindowsServiceOperations | undefined;
  private nextId = 1n;
  private readonly waiters = new Map<bigint, Waiter>();
  private readonly receipts = new WeakSet<TreeReceipt>();
  private readonly outcomes = new Map<
    string,
    { mode: StopRequest['mode']; deadline: number; result: Promise<TreeOutcome> }
  >();
  private readonly rootObservers = new Set<(exit: RootExit) => void>();
  private readonly transportObservers = new Set<(reason: string) => void>();
  private rootWitness?: RootExit;
  private rootIdentity?: Readonly<{ pid: number; birth: string }>;
  private transportFailure?: string;
  private firstCause?: ControlDiagnostics['cause'];
  private latestRequest?: RequestObservation;
  private brokerExit?: BrokerExit;
  private nativeFailure?: ControlDiagnostics['nativeFailure'];
  private creation: Creation = 'known-not-created';
  private started = false;
  private sealed = false;
  private released = false;
  private releaseRequested = false;
  private readonly releaseConfirmation = new BrokerReleaseConfirmation();
  private releaseOperation?: Promise<void>;
  private resumeStarted = false;
  private drainSettled = false;
  private streamFailed = false;
  private stopOperation: StopOperation | undefined;
  private stopWireReply: Promise<boolean> | undefined;
  constructor(
    owner: ProcessOwner,
    private readonly brokerPath: string,
    private readonly requiredCoverage: Coverage,
    private readonly transportFactory: BrokerTransportFactory,
    capability: 'whole-job-v1' | 'service-scopes-v1'
  ) {
    generationBytes(owner.processGeneration);
    for (const value of Object.values(owner)) {
      if (!value || value.length > 256 || value.includes('\0')) throw new Error('Invalid owner');
    }
    this.owner = Object.freeze({ ...owner });
    this.decoder = new FrameDecoder(this.owner.processGeneration);
    this.serviceOperations = capability === 'service-scopes-v1' ? new WindowsServiceOperations({
      captureAllowed: () => this.creation === 'running' && !this.sealed && !this.transportFailure,
      invalidReply: () => this.fail('Invalid original service reply'),
      send: (opcode, response, payload, received, admitted, failed) => {
        if (!this.control || this.transportFailure || this.released || this.nextId > 0xffffffffffffffffn) {
          this.serviceOperations?.close();
          return false;
        }
        if (this.waiters.size >= 4) return false;
        // Logical service deadlines live with their original operation. The bounded native waiter
        // retains a later validated ACK, exactly like the existing whole-provider Stop waiter.
        void this.request(opcode, response, payload, performance.now() + 60000,
          received, { admitted }).catch(failed);
        return true;
      },
    }) : undefined;
  }
  get services(): OwnedServicePort | undefined { return this.serviceOperations; }
  get root(): Readonly<{ pid: number; birth: string }> {
    if (!this.rootIdentity) throw new Error('Target not prepared');
    return this.rootIdentity;
  }
  get stdin(): Writable {
    if (!this.child?.stdin) {
      throw new Error('Target not prepared');
    }
    return this.child.stdin;
  }
  get stdout(): Readable {
    if (!this.child?.stdout) {
      throw new Error('Target not prepared');
    }
    return this.child.stdout;
  }
  get stderr(): Readable {
    if (!this.child?.stderr) {
      throw new Error('Target not prepared');
    }
    return this.child.stderr;
  }
  diagnostics(): ControlDiagnostics {
    const code = this.brokerExit?.code;
    const category =
      code === undefined || code === null || code < 70 || code > 205
        ? undefined
        : nativeExitCategories[(code & 127) - 70];
    return Object.freeze({
      cause: this.firstCause,
      writeCompleted: this.latestRequest?.writeCompleted ?? false,
      brokerExit: this.brokerExit,
      nativeExitCategory: category,
      nativeCancelUndrained: category === undefined ? undefined : Boolean((code ?? 0) & 128),
      nativeFailure: this.nativeFailure,
    });
  }
  private recordCause(name: ControlCause, observation = this.latestRequest): void {
    this.firstCause ??= Object.freeze({
      name,
      phase: observation?.phase ?? 'idle',
      writeCompleted: observation?.writeCompleted ?? false,
    });
  }
  private fail(
    reason: string,
    cause: ControlCause = 'protocol',
    observation = this.latestRequest
  ): void {
    if (this.released) return;
    if (this.transportFailure) return;
    this.recordCause(cause, observation);
    this.transportFailure = reason;
    this.serviceOperations?.close();
    this.releaseConfirmation.fail(reason);
    this.sealed = true;
    if (this.started && !this.rootIdentity) this.creation = 'uncertain';
    for (const waiter of this.waiters.values()) waiter.reject(new Error(reason));
    this.waiters.clear();
    this.control?.destroy(); // owner EOF invokes private Job containment, not proof
    for (const callback of this.transportObservers) callback(reason);
  }
  private publishRoot(exit: RootExit): void {
    if (!this.rootIdentity || exit.birth !== this.rootIdentity.birth)
      throw new Error('Root birth mismatch');
    if (this.rootWitness) {
      if (this.rootWitness.birth !== exit.birth || this.rootWitness.code !== exit.code)
        throw new Error('Conflicting root witness');
      return;
    }
    this.rootWitness = Object.freeze(exit);
    for (const callback of this.rootObservers) queueMicrotask(() => callback(exit));
  }
  private consume(frame: Frame): void {
    if (frame.opcode === Op.rootExit) {
      if (frame.requestId !== 0n || frame.payload.length !== 12) {
        throw new Error('Invalid root witness');
      }
      const birth = frame.payload.readBigUInt64LE(4).toString(16).padStart(16, '0');
      this.publishRoot({ code: frame.payload.readUInt32LE(0), birth });
      return;
    }
    const waiter = this.waiters.get(frame.requestId);
    if (!waiter || (frame.opcode !== waiter.opcode && frame.opcode !== Op.failed &&
      !(waiter.service && frame.opcode === Op.serviceRefused))) {
      throw new Error('Unexpected broker response');
    }
    this.waiters.delete(frame.requestId);
    if (frame.opcode === Op.prepared) {
      if (frame.payload.length !== 12 || !frame.payload.readUInt32LE(0) || this.rootIdentity) {
        throw new Error('Invalid prepared target');
      }
      this.rootIdentity = Object.freeze({
        pid: frame.payload.readUInt32LE(0),
        birth: frame.payload.readBigUInt64LE(4).toString(16).padStart(16, '0'),
      });
    }
    if (frame.opcode === Op.stopped) {
      const proof = facts(frame);
      if (proof.rootExited)
        this.publishRoot({
          code: frame.payload.readUInt32LE(6),
          birth: frame.payload.readBigUInt64LE(10).toString(16).padStart(16, '0'),
        });
    }
    if (frame.opcode === Op.released) {
      if (frame.payload.length) throw new Error('Invalid release acknowledgement');
      this.releaseConfirmation.acknowledge();
    }
    if (frame.opcode === Op.failed) {
      if (frame.payload.length !== 5) throw new Error('Invalid preparation failure');
      this.creation = creationFromByte(frame.payload.readUInt8(0));
      this.nativeFailure ??= Object.freeze({
        creation: this.creation,
        code: frame.payload.readUInt32LE(1),
      });
      this.recordCause('native-failed', waiter.observation);
      waiter.reject(new Error(`Broker operation failed (${frame.payload.readUInt32LE(1)})`));
    } else waiter.resolve(frame);
    waiter.received?.(frame); // Only a validated original reply, even after its public deadline expired.
    this.serviceOperations?.wake();
  }
  private request(
    opcode: number,
    response: number,
    payload: Buffer,
    deadline: number,
    received?: (frame: Frame) => void,
    service?: { admitted(id: bigint): void }
  ): Promise<Frame> {
    if (
      !this.control ||
      this.transportFailure ||
      this.released ||
      this.waiters.size >= 4 ||
      this.nextId > 0xffffffffffffffffn
    ) {
      return Promise.reject(new Error('Broker transport unavailable'));
    }
    const observation: RequestObservation = {
      phase:
        opcode === Op.launch
          ? 'prepare'
          : opcode === Op.resume
            ? 'resume'
            : opcode === Op.stop
              ? 'stop'
              : service ? 'service' : 'release',
      writeCompleted: false,
    };
    this.latestRequest = observation;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        this.recordCause('request-deadline', observation);
        reject(new Error('Broker response deadline'));
        // Keep the bounded waiter so a late reply is consumed without changing the latched outcome.
      }, remaining(deadline));
      this.waiters.set(id, {
        opcode: response,
        observation,
        ...(received ? { received } : {}),
        ...(service ? { service: true } : {}),
        resolve: (frame) => {
          clearTimeout(timer);
          if (!settled) resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          if (!settled) reject(error);
        },
      });
      service?.admitted(id); // Original service operation retained before its first native write.
      const bytes = encodeFrame({
        opcode,
        requestId: id,
        generation: this.owner.processGeneration,
        payload,
      });
      const writeTimer = setTimeout(() => {
        if (!observation.writeCompleted)
          this.fail('Control write deadline', 'control-write-deadline', observation);
      }, 5000);
      this.control!.write(bytes, (error?: Error | null) => {
        observation.writeCompleted = true; // this callback cannot complete a newer request
        clearTimeout(writeTimer);
        if (error) this.fail('Control write failure', 'control-write', observation);
      });
    });
  }
  async prepare(spec: ResolvedLaunchSpec): Promise<Preparation> {
    if (this.started || this.sealed || this.released) {
      return { kind: 'failed', creation: this.creation, reason: 'Admission sealed', cleanup: this };
    }
    let payload: Buffer;
    try {
      payload = encodeLaunch(spec);
    } catch {
      return {
        kind: 'failed',
        creation: 'known-not-created',
        reason: 'Unsupported launch specification',
        cleanup: this,
      };
    }
    if (!this.transportFactory.available(this.brokerPath)) {
      return {
        kind: 'failed',
        creation: 'known-not-created',
        reason: 'Windows capability unavailable',
        cleanup: this,
      };
    }
    this.started = true;
    this.creation = 'uncertain';
    try {
      this.child = this.transportFactory.connect(this.brokerPath);
      const pipe = this.child.control;
      this.control = pipe;
      this.child.stdout?.on('error', () => {
        this.streamFailed = true;
      });
      this.child.stderr?.on('error', () => {
        this.streamFailed = true;
      });
      this.child.stdin?.on('error', () => {
        this.streamFailed = true;
      });
      pipe.on('data', (chunk: Buffer) => {
        try {
          this.decoder.push(chunk, (frame) => this.consume(frame));
        } catch {
          this.fail('Invalid broker protocol');
        }
      });
      pipe.on('end', () => {
        try {
          this.decoder.end();
        } catch {
          this.fail('Truncated broker protocol');
        }
        if (!this.releaseConfirmation.acknowledged) this.fail('Broker control EOF', 'control-eof');
      });
      pipe.on('error', () => this.fail('Broker control failure', 'control-read'));
      this.child.onFailure(() => this.fail('Broker startup failure', 'startup'));
      this.child.onExit((exit) => {
        this.brokerExit ??= Object.freeze({ code: exit.code, signal: exit.signal });
        this.releaseConfirmation.observeExit(this.brokerExit);
        if (this.releaseRequested && (exit.code !== 0 || exit.signal !== null))
          this.fail('Broker exit without release success', 'broker-exit');
        // Process exit can precede reading its fully written acknowledgement. A pending release
        // remains bounded by request deadline/EOF; exit alone is never an acknowledgement.
        if (!this.released && !this.releaseRequested)
          this.fail('Broker exit without proof', 'broker-exit');
      });
      const frame = await this.request(Op.launch, Op.prepared, payload, performance.now() + 15000);
      if (frame.payload.length !== 12 || !frame.payload.readUInt32LE(0))
        throw new Error('Invalid prepared target');
      this.creation = 'contained-suspended';
      if (this.sealed)
        return {
          kind: 'failed',
          creation: this.creation,
          reason: 'Admission cancelled',
          cleanup: this,
        };
      return { kind: 'prepared', process: this };
    } catch {
      this.sealed = true;
      return {
        kind: 'failed',
        creation: this.creation,
        reason: 'Preparation incomplete',
        cleanup: this,
      };
    }
  }
  observeRootExit(callback: (exit: RootExit) => void): () => void {
    this.rootObservers.add(callback);
    if (this.rootWitness) callback(this.rootWitness);
    return () => {
      this.rootObservers.delete(callback);
    };
  }
  observeTransportFailure(callback: (reason: string) => void): () => void {
    this.transportObservers.add(callback);
    if (this.transportFailure) callback(this.transportFailure);
    return () => {
      this.transportObservers.delete(callback);
    };
  }
  async resume(expectedOwner: ProcessOwner, installOwner: () => Promise<void>): Promise<void> {
    if (
      !sameOwner(this.owner, expectedOwner) ||
      this.sealed ||
      this.resumeStarted ||
      !this.rootIdentity
    ) {
      throw new Error('Resume ownership unavailable');
    }
    this.resumeStarted = true;
    try {
      await installOwner();
      if (this.sealed || this.transportFailure)
        throw new Error('Resume sealed during owner installation');
      this.creation = 'uncertain'; // dispatch may resume natively before its acknowledgement arrives
      const frame = await this.request(
        Op.resume,
        Op.resumed,
        Buffer.alloc(0),
        performance.now() + 5000
      );
      if (frame.payload.length) throw new Error('Invalid resume acknowledgement');
      this.creation = 'running';
    } catch (error) {
      this.sealed = true;
      throw error;
    }
  }
  stop(request: StopRequest): Promise<TreeOutcome> {
    if (!sameOwner(this.owner, request.expectedOwner))
      return Promise.reject(new Error('Stop owner mismatch'));
    validDeadline(request.deadlineMs);
    if (!request.attemptId || request.attemptId.length > 256)
      return Promise.reject(new Error('Invalid attempt'));
    const existing = this.outcomes.get(request.attemptId);
    if (existing) {
      if (existing.mode !== request.mode || existing.deadline !== request.deadlineMs)
        return Promise.reject(new Error('Conflicting Stop attempt'));
      return existing.result;
    }
    if (this.outcomes.size >= 64)
      return Promise.reject(new Error('Attempt evidence capacity reached'));
    this.sealed = true;
    const work = this.performStop(request);
    this.outcomes.set(request.attemptId, {
      mode: request.mode,
      deadline: request.deadlineMs,
      result: work,
    });
    return work;
  }
  private async performStop(request: StopRequest): Promise<TreeOutcome> {
    let coalescedDeadline = request.deadlineMs;
    const unknown = (reason: string): TreeOutcome =>
      Object.freeze({
        kind: 'unknown',
        owner: this.owner,
        attemptId: request.attemptId,
        reason,
        creation: this.creation,
        deadlineExpired: remaining(coalescedDeadline) === 0,
      });
    if (request.mode !== 'force') return unknown('Graceful Windows Stop unsupported');
    if (this.transportFailure || remaining(request.deadlineMs) === 0) return unknown('Stop unavailable before deadline');
    let proof: StopFacts | undefined;
    if (!this.started)
      proof = {
        creation: 'known-not-created',
        rootExited: false,
        active: 0,
        dispatchError: 0,
        queryError: 0,
        payload: Buffer.alloc(0),
      };
    else {
      for (;;) {
        const previous = this.stopOperation;
        if (previous && remaining(previous.deadline) === 0) this.expireStop(previous);
        if (this.stopOperation || !this.stopWireReply) break;
        // Native stopBusy remains owned until its actual reply; timeout cannot authorize a second Stop.
        if (!await this.waitStopWire(this.stopWireReply, request.deadlineMs) || this.transportFailure ||
            remaining(request.deadlineMs) === 0) return unknown('Original Stop wire reply unavailable');
      }
      if (!this.stopOperation) {
        let settle!: (value: StopFacts | undefined) => void;
        const promise = new Promise<StopFacts | undefined>((resolve) => {
          settle = resolve;
        });
        const timer = setTimeout(() => this.expireStop(operation), remaining(request.deadlineMs));
        const operation = { deadline: request.deadlineMs, timer, settle, promise };
        this.stopOperation = operation;
        let acknowledge!: (received: boolean) => void;
        const wireReply = new Promise<boolean>(resolve => { acknowledge = resolve; });
        this.stopWireReply = wireReply;
        const received = () => {
          if (this.stopWireReply === wireReply) this.stopWireReply = undefined;
          acknowledge(true);
        };
        const payload = Buffer.alloc(5);
        payload.writeUInt32LE(remaining(request.deadlineMs));
        payload[4] = 1;
        void this.request(Op.stop, Op.stopped, payload, performance.now() + 60000, received).then(
          (frame) => {
            let result: StopFacts | undefined;
            try {
              if (performance.now() < operation.deadline) result = facts(frame);
            } catch {
              this.fail('Invalid Stop facts');
            }
            clearTimeout(operation.timer);
            operation.settle(result);
            if (this.stopOperation === operation) this.stopOperation = undefined;
          },
          () => {
            acknowledge(false); // A deadline/error is not a reply; keep the original wire debt.
            clearTimeout(operation.timer);
            operation.settle(undefined);
            if (this.stopOperation === operation) this.stopOperation = undefined;
          }
        );
      } else if (request.deadlineMs < this.stopOperation.deadline) {
        this.stopOperation.deadline = request.deadlineMs;
        clearTimeout(this.stopOperation.timer);
        const operation = this.stopOperation;
        operation.timer = setTimeout(
          () => this.expireStop(operation),
          remaining(request.deadlineMs)
        );
      }
      const operation = this.stopOperation;
      proof = await operation.promise;
      coalescedDeadline = operation.deadline;
    }
    if (!proof || this.transportFailure || remaining(request.deadlineMs) === 0)
      return unknown('Tree proof unavailable before deadline');
    const noDispatch = proof.creation === 'known-not-created';
    if (
      proof.active !== 0 ||
      proof.dispatchError ||
      proof.queryError ||
      (!noDispatch && (!proof.rootExited || !this.rootIdentity))
    ) {
      return unknown('Job accounting or original root witness incomplete');
    }
    if (
      !noDispatch &&
      proof.payload.readBigUInt64LE(10).toString(16).padStart(16, '0') !== this.rootIdentity!.birth
    ) {
      this.fail('Stop root mismatch');
      return unknown('Root identity mismatch');
    }
    const receipt = Object.freeze({
      owner: this.owner,
      attemptId: request.attemptId,
      coverage: noDispatch ? ('no-local-dispatch' as const) : ('job-membership' as const),
      rootExited: proof.rootExited,
      proofDigest: createHash('sha256')
        .update(JSON.stringify(this.owner))
        .update(proof.payload)
        .update(request.attemptId)
        .digest('hex'),
    });
    this.receipts.add(receipt);
    return Object.freeze({ kind: 'confirmed', receipt });
  }
  private expireStop(operation: StopOperation): void {
    clearTimeout(operation.timer); operation.settle(undefined);
    if (this.stopOperation === operation) this.stopOperation = undefined;
  }
  private waitStopWire(reply: Promise<boolean>, deadline: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), remaining(deadline));
      void reply.then(received => { clearTimeout(timer); resolve(received); });
    });
  }
  async drain(deadlineMs: number): Promise<TargetDrain> {
    validDeadline(deadlineMs);
    if (!this.child) {
      this.drainSettled = true;
      return { kind: 'complete' };
    }
    if (this.streamFailed) {
      this.drainSettled = true;
      return { kind: 'incomplete', reason: 'Target stream failure' };
    }
    const streams = [this.stdout, this.stderr];
    const result = await new Promise<TargetDrain>((resolve) => {
      const finish = (value: TargetDrain): void => {
        clearTimeout(timer);
        for (const stream of streams) {
          stream.off('end', check);
          stream.off('error', failed);
        }
        resolve(value);
      };
      const check = (): void => {
        if (streams.every((stream) => stream.readableEnded)) finish({ kind: 'complete' });
      };
      const failed = (): void => finish({ kind: 'incomplete', reason: 'Target stream failure' });
      const timer = setTimeout(
        () => finish({ kind: 'incomplete', reason: 'Target drain deadline' }),
        remaining(deadlineMs)
      );
      for (const stream of streams) {
        stream.on('end', check);
        stream.on('error', failed);
      }
      check();
    });
    this.drainSettled = true;
    return result;
  }
  async release(receipt: TreeReceipt, requiredCoverage: Coverage): Promise<void> {
    if (
      !this.receipts.has(receipt) ||
      !sameOwner(receipt.owner, this.owner) ||
      requiredCoverage !== this.requiredCoverage ||
      (receipt.coverage !== requiredCoverage && receipt.coverage !== 'no-local-dispatch')
    ) {
      throw new Error('Receipt authority or required coverage mismatch');
    }
    if (this.released) return;
    if (this.started && !this.drainSettled) throw new Error('Target drain not settled');
    if (this.releaseOperation) return this.releaseOperation;
    this.releaseOperation = this.performRelease();
    return this.releaseOperation;
  }
  private async performRelease(): Promise<void> {
    if (this.started) {
      this.releaseRequested = true;
      const deadline = performance.now() + 5000;
      try {
        const frame = await this.request(Op.release, Op.released, Buffer.alloc(0), deadline);
        if (frame.payload.length) throw new Error('Invalid release acknowledgement');
        await this.releaseConfirmation.wait(deadline);
      } catch (error) {
        this.releaseRequested = false;
        this.fail('Broker release acknowledgement unavailable', 'release-unavailable');
        throw error;
      }
    }
    this.released = true;
    this.serviceOperations?.close();
    this.control?.end();
    this.child?.stdin?.destroy();
  }
  abandonControl(expectedOwner: ProcessOwner): void {
    if (!sameOwner(this.owner, expectedOwner)) throw new Error('Abandon owner mismatch');
    this.fail('Owner abandoned control; containment unconfirmed', 'owner-abandoned');
    this.child?.stdin?.destroy();
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
    this.drainSettled = true;
  }
}

/** Deliberately unconnected to product launch factories until platform/PR5 gates pass. */
export function createWindowsOwnedLaunchPort(
  brokerPath: string,
  requiredCoverage: Coverage = 'job-membership',
  transportFactory?: BrokerTransportFactory,
  brokerCapability: 'whole-job-v1' | 'service-scopes-v1' = 'whole-job-v1'
): OwnedLaunchPort {
  if (brokerCapability !== 'whole-job-v1' && brokerCapability !== 'service-scopes-v1')
    throw new Error('Unsupported original broker capability');
  const selectedTransport = transportFactory ?? nativeTransport(brokerCapability);
  const capabilities = new WeakSet<WindowsCapability>();
  return {
    allocate(owner) {
      const capability = new WindowsCapability(
        owner,
        brokerPath,
        requiredCoverage,
        selectedTransport,
        brokerCapability
      );
      capabilities.add(capability);
      return capability;
    },
    prepare(pending, spec) {
      if (!(pending instanceof WindowsCapability) || !capabilities.has(pending))
        throw new Error('Foreign pending authority');
      return pending.prepare(spec);
    },
  };
}
