import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Duplex, Readable, Writable } from 'node:stream';

import {
  encodeFrame,
  encodeLaunch,
  type Frame,
  FrameDecoder,
  generationBytes,
  Op,
  VERSION,
} from './codec';
import {
  type BrokerExit,
  type ControlCause,
  type ControlDiagnostics,
  type ControlPhase,
  type Coverage,
  type Creation,
  type NativeExitCategory,
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
} from './contract';

const nativeExitCategories: readonly NativeExitCategory[] = [
  'owner-eof',
  'bootstrap',
  'read',
  'write',
  'write-deadline',
  'protocol',
  'cancel-undrained',
  'pending-read-barrier',
];
const creations: readonly Creation[] = [
  'known-not-created',
  'contained-suspended',
  'running',
  'uncertain',
];
interface Waiter {
  opcode: number;
  observation: RequestObservation;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
}
interface RequestObservation {
  phase: ControlPhase;
  writeCompleted: boolean;
}
interface StopFacts {
  creation: Creation;
  rootExited: boolean;
  active: number;
  dispatchError: number;
  queryError: number;
  payload: Buffer;
}
const remaining = (deadline: number): number =>
  Math.max(0, Math.min(60000, Math.floor(deadline - performance.now())));
function validDeadline(value: number): void {
  if (!Number.isFinite(value) || value > performance.now() + 60000)
    throw new Error('Invalid deadline');
}
function facts(frame: Frame): StopFacts {
  if (frame.payload.length !== 26 || frame.payload.readUInt8(1) > 1) {
    throw new Error('Invalid Stop evidence');
  }
  return {
    creation: creationFromByte(frame.payload.readUInt8(0)),
    rootExited: frame.payload.readUInt8(1) === 1,
    active: frame.payload.readUInt32LE(2),
    dispatchError: frame.payload.readUInt32LE(18),
    queryError: frame.payload.readUInt32LE(22),
    payload: frame.payload,
  };
}
function creationFromByte(value: number): Creation {
  const creation = creations[value];
  if (creation === undefined) throw new Error('Invalid creation fact');
  return creation;
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
function boundedFile(path: string, limit: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new Error('Broker admission file exceeds limit');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) {
        throw new Error('Broker admission file changed');
      }
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length))
      throw new Error('Broker admission file changed');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
/** Bounded staged-artifact verification; not a guarantee against a malicious filesystem/OS race. */
export function verifyStagedBroker(path: string, arch: string): void {
  if (basename(path) !== 'owned-process-broker.exe' || (arch !== 'x64' && arch !== 'arm64')) {
    throw new Error('Unsupported staged broker');
  }
  const manifest: unknown = JSON.parse(
    boundedFile(join(dirname(path), 'manifest.json'), 4096).toString('utf8')
  );
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('Invalid broker manifest');
  const m = manifest as Record<string, unknown>;
  if (
    Object.keys(m).sort().join(',') !== 'arch,file,platform,protocol,schema,sha256' ||
    m.schema !== 1 ||
    m.protocol !== VERSION ||
    m.platform !== 'win32' ||
    m.arch !== arch ||
    m.file !== basename(path) ||
    typeof m.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(m.sha256)
  )
    throw new Error('Invalid broker manifest');
  const bytes = boundedFile(path, 16 * 1024 * 1024);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ')
    throw new Error('Invalid broker PE');
  const offset = bytes.readUInt32LE(60);
  if (
    offset > bytes.length - 24 ||
    bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(offset + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64) ||
    createHash('sha256').update(bytes).digest('hex') !== m.sha256
  )
    throw new Error('Broker architecture or digest mismatch');
}
const nativeTransport: BrokerTransportFactory = {
  available: (path) => {
    if (process.platform !== 'win32' || !win32.isAbsolute(path)) return false;
    try {
      verifyStagedBroker(path, process.arch);
      return true;
    } catch {
      return false;
    }
  },
  connect: connectPrivateBroker,
};

class WindowsCapability implements PreparedOwnedProcess {
  readonly owner: ProcessOwner;
  private child?: BrokerTransport;
  private control?: Duplex;
  private readonly decoder: FrameDecoder;
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
  private resumeStarted = false;
  private drainSettled = false;
  private streamFailed = false;
  private stopOperation?: {
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
    settle: (value: StopFacts | undefined) => void;
    promise: Promise<StopFacts | undefined>;
  };
  constructor(
    owner: ProcessOwner,
    private readonly brokerPath: string,
    private readonly requiredCoverage: Coverage,
    private readonly transportFactory: BrokerTransportFactory
  ) {
    generationBytes(owner.processGeneration);
    for (const value of Object.values(owner)) {
      if (!value || value.length > 256 || value.includes('\0')) throw new Error('Invalid owner');
    }
    this.owner = Object.freeze({
      ...owner,
      processGeneration: owner.processGeneration.toLowerCase(),
    });
    this.decoder = new FrameDecoder(this.owner.processGeneration);
  }
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
    if (!waiter || (frame.opcode !== waiter.opcode && frame.opcode !== Op.failed)) {
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
      this.released = true; // terminal before EOF/exit can run ahead of Promise continuation
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
  }
  private request(
    opcode: number,
    response: number,
    payload: Buffer,
    deadline: number
  ): Promise<Frame> {
    if (
      !this.control ||
      this.transportFailure ||
      this.released ||
      this.waiters.size >= 4 ||
      this.nextId > 1024n
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
              : 'release',
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
        resolve: (frame) => {
          clearTimeout(timer);
          if (!settled) resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          if (!settled) reject(error);
        },
      });
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
        this.fail('Broker control EOF', 'control-eof');
      });
      pipe.on('error', () => this.fail('Broker control failure', 'control-read'));
      this.child.onFailure(() => this.fail('Broker startup failure', 'startup'));
      this.child.onExit((exit) => {
        this.brokerExit ??= Object.freeze({ code: exit.code, signal: exit.signal });
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
      if (!this.stopOperation) {
        let settle!: (value: StopFacts | undefined) => void;
        const promise = new Promise<StopFacts | undefined>((resolve) => {
          settle = resolve;
        });
        const timer = setTimeout(() => settle(undefined), remaining(request.deadlineMs));
        const operation = { deadline: request.deadlineMs, timer, settle, promise };
        this.stopOperation = operation;
        const payload = Buffer.alloc(5);
        payload.writeUInt32LE(remaining(request.deadlineMs));
        payload[4] = 1;
        void this.request(Op.stop, Op.stopped, payload, performance.now() + 60000).then(
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
          () => operation.settle(undefined),
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
    if (this.started) {
      this.releaseRequested = true;
      try {
        const frame = await this.request(
          Op.release,
          Op.released,
          Buffer.alloc(0),
          performance.now() + 5000
        );
        if (frame.payload.length) throw new Error('Invalid release acknowledgement');
      } catch (error) {
        this.releaseRequested = false;
        this.fail('Broker release acknowledgement unavailable', 'release-unavailable');
        throw error;
      }
    }
    this.released = true;
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
  transportFactory: BrokerTransportFactory = nativeTransport
): OwnedLaunchPort {
  const capabilities = new WeakSet<WindowsCapability>();
  return {
    allocate(owner) {
      const capability = new WindowsCapability(
        owner,
        brokerPath,
        requiredCoverage,
        transportFactory
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
