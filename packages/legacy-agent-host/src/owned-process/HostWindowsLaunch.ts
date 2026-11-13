import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';

import { encodeLaunch } from './codec.js';
import { sameOwner } from './contract.js';
import { HOST_CUSTODY_CHUNK_BYTES, HOST_CUSTODY_LAUNCH_MS } from './hostCustody.js';

import type { NativeProcessProfile } from '../composition/nativeProcessProfile.js';
import type {
  HostCustodyCall,
  HostCustodyClient,
  HostCustodyHint,
  HostCustodyResult,
} from './hostCustody.js';
import type {
  ControlDiagnostics,
  Coverage,
  OwnedLaunchPort,
  Preparation,
  PreparedOwnedProcess,
  ProcessOwner,
  ResolvedLaunchSpec,
  RootExit,
  StopRequest,
  TargetDrain,
  TreeOutcome,
  TreeReceipt,
} from './contract.js';

export function windowsBrokerReference(
  broker: NonNullable<NativeProcessProfile['windowsBroker']>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        path: broker.path,
        sha256: broker.sha256,
        arch: broker.arch,
        protocol: broker.protocol,
        ...(broker.capability === undefined ? {} : { capability: broker.capability }),
      })
    )
    .digest('hex');
}
function unavailable(): never {
  throw new Error('Original Main custody unavailable');
}

/** One private Host bridge; one readiness subscription and one bounded original preparation queue. */
export class HostWindowsLaunch {
  private readonly allocations = new Map<string, RemotePending>();
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private subscribed: HostCustodyClient | undefined;

  constructor(private readonly client: () => HostCustodyClient | undefined) {}

  private connected(): HostCustodyClient {
    const client = this.client() ?? unavailable();
    if (this.subscribed && this.subscribed !== client) unavailable();
    if (!this.subscribed) {
      this.subscribed = client;
      client.onReadable((hint) => this.allocations.get(hint.capability)?.readable(hint.stream));
    }
    return client;
  }

  async request(
    operation: HostCustodyCall['operation'], build: () => HostCustodyCall, deadline?: number
  ): Promise<HostCustodyResult> {
    const reply = await this.connected().requestWhenReady(operation, build, deadline);
    if (reply.status !== 'completed' || reply.value.operation !== operation) unavailable();
    return reply.value;
  }

  port(profile: NativeProcessProfile, current: () => boolean): OwnedLaunchPort {
    const selected = structuredClone(profile);
    if (!selected.windowsBroker) unavailable();
    const originals = new WeakSet<RemotePending>();
    return {
      allocate: (owner) => {
        if (this.allocations.size >= 256) unavailable();
        const pending = new RemotePending(this, selected, Object.freeze({ ...owner }), current);
        this.allocations.set(pending.key, pending);
        originals.add(pending);
        return pending;
      },
      prepare: (pending, spec) => {
        if (!(pending instanceof RemotePending) || !originals.has(pending) || this.queued >= 256)
          unavailable();
        // Retain one immutable original spec per allocation; encode only during serial staging.
        const original = pending.captureSpec(spec);
        this.queued++;
        const staged = this.tail.then(() => pending.stage(original));
        this.tail = staged
          .then(
            () => {},
            () => {}
          )
          .finally(() => {
            this.queued--;
          });
        // The next member can stage after commit; native preparation is not globally serialized.
        return staged.then(
          () => pending.prepare(),
          () => pending.failed()
        );
      },
    };
  }

  retire(pending: RemotePending): void {
    if (this.allocations.get(pending.key) === pending) this.allocations.delete(pending.key);
  }
}

class RemoteOutput extends Readable {
  private waiting = false;
  private demand = false;
  private hinted = false;

  constructor(
    private readonly pull: () => Promise<Extract<HostCustodyResult, { operation: 'read' }>>
  ) {
    super({ highWaterMark: 64 * 1024 });
    this.on('error', () => {});
  }
  override _read(): void {
    this.demand = true;
    void this.pump();
  }
  ready(): void {
    this.hinted = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.waiting || !this.demand || this.destroyed || this.readableEnded) return;
    this.waiting = true;
    try {
      do {
        this.hinted = false;
        const result = await this.pull();
        if (this.destroyed) return;
        if (result.state === 'eof') {
          this.demand = false;
          this.push(null);
          return;
        }
        if (result.state === 'empty') return;
        this.demand = this.push(Buffer.from(result.bytes, 'base64'));
        if (!result.more && !this.hinted) return;
      } while (this.demand);
    } catch {
      this.destroy(new Error('Original native output unavailable'));
    } finally {
      this.waiting = false;
      if (this.hinted && this.demand && !this.destroyed) void this.pump();
    }
  }
}

/** SDK-side reference only. The actual pending object/Job and genuine receipts stay in Main. */
class RemotePending implements PreparedOwnedProcess {
  readonly key = randomUUID();
  readonly stdin: Writable;
  readonly stdout: RemoteOutput;
  readonly stderr: RemoteOutput;
  private readonly deadline = performance.now() + HOST_CUSTODY_LAUNCH_MS;
  private rootIdentity: PreparedOwnedProcess['root'] | undefined;
  private dispatched = false;
  private stageQueued = false;
  private staged = false;
  private sealed = false;
  private resumed = false;
  private exit: RootExit | undefined;
  private failure = false;
  private readingState = false;
  private stateHint = false;
  private readonly exits = new Set<(exit: RootExit) => void>();
  private readonly failures = new Set<(reason: string) => void>();
  private readonly receipts = new WeakMap<TreeReceipt, string | null>();
  private readonly attempts = new Map<
    string,
    { request: StopRequest; result: Promise<TreeOutcome> }
  >();

  constructor(
    private readonly source: HostWindowsLaunch,
    private readonly profile: NativeProcessProfile,
    readonly owner: ProcessOwner,
    private readonly current: () => boolean
  ) {
    const read = (stream: 'stdout' | 'stderr') => async () => {
      const value = await source.request('read', () => ({ operation: 'read', capability: this.key, stream }));
      return value.operation === 'read' ? value : unavailable();
    };
    this.stdout = new RemoteOutput(read('stdout'));
    this.stderr = new RemoteOutput(read('stderr'));
    this.stdin = new Writable({
      highWaterMark: 64 * 1024,
      write: (value: Buffer, _encoding, done) => {
        void this.write(value).then(
          () => done(),
          () => done(new Error('Original native input unavailable'))
        );
      },
      final: (done) => {
        void this.end().then(
          () => done(),
          () => done(new Error('Original native input unavailable'))
        );
      },
    });
    this.stdin.on('error', () => {});
  }

  get root(): PreparedOwnedProcess['root'] {
    return this.rootIdentity ?? unavailable();
  }
  diagnostics(): ControlDiagnostics {
    return { writeCompleted: false };
  } // No synchronous Main wire proof is asserted.
  abandonControl(expectedOwner: ProcessOwner): void {
    if (!sameOwner(expectedOwner, this.owner)) unavailable();
    this.sealed = true;
    throw new Error('Original Main retains physical cleanup');
  }

  private assertInput(preparing = false): void {
    if (this.sealed || !this.current() || (preparing && performance.now() >= this.deadline))
      unavailable();
  }

  captureSpec(spec: ResolvedLaunchSpec): ResolvedLaunchSpec {
    this.assertInput(true);
    if (this.stageQueued) unavailable();
    this.stageQueued = true;
    return Object.freeze({ ...spec, environment: Object.freeze([...spec.environment]) });
  }

  async stage(spec: ResolvedLaunchSpec): Promise<void> {
    this.assertInput(true);
    if (this.dispatched) unavailable();
    const bytes = encodeLaunch(spec);
    const launchSha256 = createHash('sha256').update(bytes).digest('hex');
    await this.source.request(
      'allocate',
      () => {
        this.assertInput(true);
        this.dispatched = true; // Set only at actual admission; a lost reply is never known-not-created.
        return {
          operation: 'allocate', capability: this.key, owner: this.owner,
          brokerRef: windowsBrokerReference(this.profile.windowsBroker!),
          executableSha256: this.profile.executable.sha256,
          launchSha256, launchBytes: bytes.length,
          budgetMs: Math.max(0, Math.floor(this.deadline - performance.now())),
        };
      },
      this.deadline
    );
    for (let offset = 0; offset < bytes.length; offset += HOST_CUSTODY_CHUNK_BYTES) {
      this.assertInput(true);
      const chunk = bytes.subarray(offset, offset + HOST_CUSTODY_CHUNK_BYTES);
      const result = await this.source.request(
        'launch-chunk',
        () => {
          this.assertInput(true);
          return { operation: 'launch-chunk', capability: this.key, offset, bytes: chunk.toString('base64') };
        },
        this.deadline
      );
      if (result.operation !== 'launch-chunk' || result.offset !== offset + chunk.length)
        unavailable();
    }
    this.assertInput(true);
    await this.source.request('launch-commit', () => {
      this.assertInput(true);
      return { operation: 'launch-commit', capability: this.key };
    }, this.deadline);
    this.assertInput(true);
    this.staged = true;
  }

  failed(): Preparation {
    return {
      kind: 'failed',
      creation: this.dispatched ? 'uncertain' : 'known-not-created',
      reason: 'Original Main preparation unavailable',
      cleanup: this,
    };
  }

  async prepare(): Promise<Preparation> {
    try {
      this.assertInput(true);
      if (!this.staged || this.rootIdentity) unavailable();
      const prepared = await this.source.request(
        'prepare', () => {
          this.assertInput(true);
          return { operation: 'prepare', capability: this.key };
        }, this.deadline
      );
      if (prepared.operation !== 'prepare') unavailable();
      this.rootIdentity = Object.freeze({ ...prepared.root });
      if (this.stateHint) void this.observeState();
      this.assertInput(true);
      return { kind: 'prepared', process: this };
    } catch {
      return this.failed();
    }
  }

  async resume(expectedOwner: ProcessOwner, installOwner: () => Promise<void>): Promise<void> {
    if (!sameOwner(expectedOwner, this.owner) || !this.rootIdentity || this.resumed) unavailable();
    this.assertInput(true);
    await installOwner();
    this.assertInput(true);
    const result = await this.source.request(
      'resume', () => {
        this.assertInput(true);
        return { operation: 'resume', capability: this.key };
      }, this.deadline
    );
    if (result.operation !== 'resume') unavailable();
    this.assertInput(true);
    this.resumed = true;
    this.readable('state');
  }

  private async write(bytes: Buffer): Promise<void> {
    if (!this.resumed || this.exit) unavailable();
    for (let offset = 0; offset < bytes.length; offset += HOST_CUSTODY_CHUNK_BYTES) {
      this.assertInput();
      await this.source.request('write', () => {
        this.assertInput();
        return { operation: 'write', capability: this.key,
          bytes: bytes.subarray(offset, offset + HOST_CUSTODY_CHUNK_BYTES).toString('base64') };
      });
    }
    this.assertInput();
  }
  private async end(): Promise<void> {
    this.assertInput();
    if (!this.resumed) unavailable();
    await this.source.request('end', () => {
      this.assertInput();
      return { operation: 'end', capability: this.key };
    });
    this.assertInput();
  }

  observeRootExit(observer: (exit: RootExit) => void): () => void {
    this.exits.add(observer);
    if (this.exit) observer(this.exit);
    return () => {
      this.exits.delete(observer);
    };
  }
  observeTransportFailure(observer: (reason: string) => void): () => void {
    this.failures.add(observer);
    if (this.failure) observer('Original Main transport unavailable');
    return () => {
      this.failures.delete(observer);
    };
  }
  readable(stream: HostCustodyHint['stream']): void {
    if (stream !== 'state') {
      this[stream].ready();
      return;
    }
    this.stateHint = true;
    void this.observeState();
  }
  private async observeState(): Promise<void> {
    if (this.readingState || !this.rootIdentity) return;
    this.readingState = true;
    try {
      do {
        this.stateHint = false;
        const value = await this.source.request('observe', () => ({ operation: 'observe', capability: this.key }));
        if (value.operation !== 'observe') unavailable();
        if (value.exit && !this.exit) {
          if (value.exit.birth !== this.rootIdentity.birth) unavailable();
          this.exit = Object.freeze({ ...value.exit });
          for (const observer of this.exits) observer(this.exit);
        }
        if (value.transportFailed) unavailable();
      } while (this.stateHint);
    } catch {
      this.failure = true;
      for (const observer of this.failures) observer('Original Main transport unavailable');
    } finally {
      this.readingState = false;
    }
  }

  stop(request: StopRequest): Promise<TreeOutcome> {
    if (!sameOwner(request.expectedOwner, this.owner))
      return Promise.reject(new Error('Original owner mismatch'));
    this.sealed = true;
    const attempt = this.attempts.get(request.attemptId);
    if (attempt) {
      if (
        attempt.request.mode !== request.mode ||
        attempt.request.deadlineMs !== request.deadlineMs
      )
        return Promise.reject(new Error('Original attempt mismatch'));
      return attempt.result;
    }
    if (this.attempts.size >= 64) return Promise.reject(new Error('Original attempts exhausted'));
    const result = this.stopOriginal(request);
    this.attempts.set(request.attemptId, { request: Object.freeze({ ...request }), result });
    return result;
  }
  private async stopOriginal(request: StopRequest): Promise<TreeOutcome> {
    const unknown = (): TreeOutcome => ({
      kind: 'unknown',
      owner: this.owner,
      attemptId: request.attemptId,
      reason: 'Original Main Stop unconfirmed',
      creation: this.dispatched ? 'uncertain' : 'known-not-created',
      deadlineExpired: performance.now() >= request.deadlineMs,
    });
    if (request.mode !== 'force' || performance.now() >= request.deadlineMs) return unknown();
    if (!this.dispatched) {
      const receipt: TreeReceipt = Object.freeze({
        owner: this.owner,
        attemptId: request.attemptId,
        coverage: 'no-local-dispatch',
        rootExited: false,
        proofDigest: createHash('sha256').update(this.key).update(request.attemptId).digest('hex'),
      });
      this.receipts.set(receipt, null);
      return { kind: 'confirmed', receipt };
    }
    try {
      const value = await this.source.request(
        'stop', () => ({
          operation: 'stop',
          capability: this.key,
          attemptRef: request.attemptId,
          budgetMs: Math.max(
            0,
            Math.min(30000, Math.floor(request.deadlineMs - performance.now()))
          ),
        }),
        request.deadlineMs
      );
      if (
        value.operation !== 'stop' ||
        value.state !== 'confirmed' ||
        !value.receiptRef ||
        !value.receipt ||
        !sameOwner(value.receipt.owner, this.owner) ||
        value.receipt.attemptId !== request.attemptId ||
        performance.now() >= request.deadlineMs
      )
        return unknown();
      const receipt = Object.freeze({
        ...value.receipt,
        owner: Object.freeze({ ...value.receipt.owner }),
      });
      this.receipts.set(receipt, value.receiptRef);
      return { kind: 'confirmed', receipt };
    } catch {
      return unknown();
    }
  }

  async drain(deadlineMs: number): Promise<TargetDrain> {
    if (!this.dispatched) return { kind: 'complete' };
    const value = await this.source.request(
      'drain', () => ({
        operation: 'drain',
        capability: this.key,
        budgetMs: Math.max(0, Math.min(3000, Math.floor(deadlineMs - performance.now()))),
      }),
      deadlineMs
    );
    return value.operation === 'drain' ? { kind: value.state } : unavailable();
  }
  async release(receipt: TreeReceipt, coverage: Coverage): Promise<void> {
    if (
      !this.receipts.has(receipt) ||
      !sameOwner(receipt.owner, this.owner) ||
      coverage !== 'job-membership'
    )
      unavailable();
    const reference = this.receipts.get(receipt);
    if (reference) {
      const value = await this.source.request('release', () => ({
        operation: 'release', capability: this.key, receiptRef: reference,
      }));
      if (value.operation !== 'release' || value.state !== 'released') unavailable();
    }
    this.source.retire(this);
  }
}
