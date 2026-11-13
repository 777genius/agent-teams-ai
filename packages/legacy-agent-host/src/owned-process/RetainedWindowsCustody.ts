import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { decodeLaunch } from './codec.js';
import { createWindowsOwnedLaunchPort } from './windowsBroker.js';
import { HOST_CUSTODY_CHUNK_BYTES, hostCustodyCleanup } from './hostCustody.js';

import type { Readable } from 'node:stream';
import type { NativeProcessProfile } from '../composition/nativeProcessProfile.js';
import type {
  OwnedLaunchPort,
  PendingOwnedProcess,
  PreparedOwnedProcess,
  ResolvedLaunchSpec,
  RootExit,
  TreeOutcome,
  TreeReceipt,
} from './contract.js';
import type {
  HostCustodyBinding,
  HostCustodyCall,
  HostCustodyHint,
  HostCustodyOwner,
  HostCustodyPort,
  HostCustodyResult,
} from './hostCustody.js';

type Selection = NonNullable<NativeProcessProfile['windowsBroker']>;
type AllocationCall = Extract<HostCustodyCall, { operation: 'allocate' }>;
interface Attachment {
  binding: HostCustodyBinding;
  signal: AbortSignal;
  exited: boolean;
  inputSealed: boolean;
  observer?: (hint: HostCustodyHint) => boolean;
}
interface Allocation {
  call: AllocationCall;
  attachment: Attachment;
  selection: Selection;
  port: OwnedLaunchPort;
  pending: PendingOwnedProcess;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  bytes?: Buffer;
  loaded: number;
  spec?: ResolvedLaunchSpec;
  prepared?: PreparedOwnedProcess;
  preparation?: Promise<void>;
  resumption?: Promise<void>;
  running: boolean;
  inputSealed: boolean;
  exit?: RootExit;
  transportFailed: boolean;
  released: boolean;
  readonly dirty: Set<HostCustodyHint['stream']>;
  readonly subscriptions: (() => void)[];
  readonly stops: Map<string, { outcome: Promise<TreeOutcome>; receiptRef?: string }>;
  readonly receipts: Map<string, TreeReceipt>;
}

function unavailable(): never {
  throw new Error('Original native custody unavailable');
}

/** Physical owner belongs to Main. A replaceable Host owns neither the broker nor its handles. */
export class RetainedWindowsCustody implements HostCustodyOwner {
  readonly mainEpoch = randomUUID();
  private readonly allocations = new Map<string, Allocation>();
  private attachment: Attachment | undefined;
  private staging: Allocation | undefined;
  private shuttingDown = false;
  private closing: Promise<boolean> | undefined;
  private pumping = false;

  constructor(
    private readonly options: {
      profileId: string;
      profileDigest: string;
      /** Captured before Host start; no renderer or caller-provided executable selection. */
      selectBroker(reference: string): Selection;
      /** Fresh selected source/broker/executable admission, before prepare and resume. */
      verifyLaunch(
        spec: ResolvedLaunchSpec,
        executableSha256: string,
        broker: Selection
      ): Promise<void>;
      /** Existing launch primitive dependency; production composition leaves this absent. */
      createPort?(selection: Selection): OwnedLaunchPort;
    }
  ) {}

  attach(context: Parameters<HostCustodyOwner['attach']>[0]): HostCustodyPort {
    if (
      this.shuttingDown ||
      context.signal.aborted ||
      context.profileId !== this.options.profileId ||
      context.binding.mainEpoch !== this.mainEpoch ||
      context.binding.profileDigest !== this.options.profileDigest ||
      (this.attachment && (!this.attachment.signal.aborted || !this.attachment.exited))
    )
      unavailable();
    const attached: Attachment = {
      binding: Object.freeze({ ...context.binding }),
      signal: context.signal,
      exited: false,
      inputSealed: false,
    };
    this.attachment = attached;
    void context.hostExited.then(() => {
      attached.exited = true;
    });
    context.signal.addEventListener(
      'abort',
      () => {
        attached.inputSealed = true;
        delete attached.observer;
        if (this.staging?.attachment === attached) this.dropStaging(this.staging);
        // No physical close/Stop here. The same Main retains every pending outcome and handle.
      },
      { once: true }
    );
    return {
      handle: (call) => this.handle(attached, call),
      onReadable: (observer) => {
        this.assertAttached(attached);
        if (attached.observer) unavailable();
        attached.observer = observer;
        for (const allocation of this.allocations.values()) this.markCurrent(allocation);
        this.pump();
        return () => {
          if (attached.observer === observer) delete attached.observer;
        };
      },
      resumeReadable: () => {
        if (this.attachment === attached) this.pump();
      },
      sealInput: () => {
        attached.inputSealed = true;
      },
    };
  }

  private assertAttached(attached: Attachment): void {
    if (this.attachment !== attached || attached.signal.aborted) unavailable();
  }

  private input(attached: Attachment, allocation?: Allocation): void {
    this.assertAttached(attached);
    if (
      attached.inputSealed ||
      this.shuttingDown ||
      (allocation &&
        (allocation.attachment !== attached ||
          allocation.released ||
          allocation.inputSealed ||
          (!allocation.running && performance.now() >= allocation.deadline)))
    )
      unavailable();
  }

  private allocation(key: string): Allocation {
    const allocation = this.allocations.get(key);
    return allocation ?? unavailable();
  }

  private dropStaging(allocation: Allocation): void {
    delete allocation.bytes;
    if (this.staging === allocation) this.staging = undefined;
  }

  private mark(allocation: Allocation, stream: HostCustodyHint['stream']): void {
    if (allocation.released) return;
    allocation.dirty.add(stream);
    this.pump();
  }

  private markCurrent(allocation: Allocation): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const source = allocation.prepared?.[stream];
      if (source && (source.readableLength || source.readableEnded)) allocation.dirty.add(stream);
    }
    if (allocation.exit || allocation.transportFailed) allocation.dirty.add('state');
  }

  private pump(): void {
    const attached = this.attachment;
    if (this.pumping || !attached?.observer || attached.signal.aborted) return;
    this.pumping = true;
    try {
      for (const stream of ['state', 'stdout', 'stderr'] as const) {
        for (const allocation of this.allocations.values()) {
          // A successor can inspect/stop original scopes, but does not receive an orphaned SDK stream.
          if (
            allocation.attachment !== attached ||
            allocation.released ||
            !allocation.dirty.has(stream)
          )
            continue;
          if (!attached.observer({ capability: allocation.call.capability, stream })) return;
          allocation.dirty.delete(stream);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private commit(allocation: Allocation): void {
    this.input(allocation.attachment, allocation);
    const bytes = allocation.bytes;
    if (
      !bytes ||
      allocation.loaded !== bytes.length ||
      createHash('sha256').update(bytes).digest('hex') !== allocation.call.launchSha256
    )
      unavailable();
    allocation.spec = decodeLaunch(bytes);
    this.dropStaging(allocation);
  }

  private async prepare(allocation: Allocation): Promise<void> {
    this.input(allocation.attachment, allocation);
    const spec = allocation.spec ?? unavailable();
    await this.options.verifyLaunch(spec, allocation.call.executableSha256, allocation.selection);
    this.input(allocation.attachment, allocation);
    const result = await allocation.port.prepare(allocation.pending, spec);
    if (result.kind !== 'prepared') unavailable();
    allocation.prepared = result.process;
    allocation.subscriptions.push(
      result.process.observeRootExit((exit) => {
        allocation.exit = Object.freeze({ ...exit });
        this.mark(allocation, 'state');
      }),
      result.process.observeTransportFailure(() => {
        allocation.transportFailed = true;
        this.mark(allocation, 'state');
      })
    );
    for (const stream of ['stdout', 'stderr'] as const) {
      const source = result.process[stream];
      const readable = () => this.mark(allocation, stream);
      const failed = () => {
        allocation.transportFailed = true;
        this.mark(allocation, 'state');
      };
      source.on('readable', readable).on('end', readable).on('error', failed);
      allocation.subscriptions.push(() => {
        source.off('readable', readable).off('end', readable).off('error', failed);
      });
    }
    this.markCurrent(allocation);
    this.pump();
    // A late preparation is still retained for Main cleanup, never admitted to resume/input.
    this.input(allocation.attachment, allocation);
  }

  private async handle(attached: Attachment, call: HostCustodyCall): Promise<HostCustodyResult> {
    this.assertAttached(attached);
    if (!hostCustodyCleanup(call)) this.input(attached);
    if (call.operation === 'allocate') {
      if (
        !call.budgetMs ||
        this.staging ||
        this.allocations.has(call.capability) ||
        [...this.allocations.values()].filter((value) => !value.released).length >= 256
      )
        unavailable();
      const selection = Object.freeze({ ...this.options.selectBroker(call.brokerRef) });
      const port =
        this.options.createPort?.(selection) ?? createWindowsOwnedLaunchPort(selection.path);
      const pending = port.allocate(Object.freeze({ ...call.owner }));
      const allocation: Allocation = {
        call: structuredClone(call),
        attachment: attached,
        selection,
        port,
        pending,
        deadline: performance.now() + call.budgetMs,
        loaded: 0,
        running: false,
        inputSealed: false,
        transportFailed: false,
        released: false,
        timer: setTimeout(() => this.dropStaging(allocation), call.budgetMs),
        dirty: new Set(),
        subscriptions: [],
        stops: new Map(),
        receipts: new Map(),
      };
      this.allocations.set(call.capability, allocation); // Original pending retained before any async native work.
      allocation.bytes = Buffer.alloc(call.launchBytes);
      this.staging = allocation;
      return { operation: call.operation, state: 'allocated' };
    }
    const allocation = this.allocation(call.capability);
    if (!hostCustodyCleanup(call)) this.input(attached, allocation);
    switch (call.operation) {
      case 'launch-chunk': {
        const bytes = Buffer.from(call.bytes, 'base64');
        if (
          this.staging !== allocation ||
          !allocation.bytes ||
          !bytes.length ||
          call.offset !== allocation.loaded ||
          allocation.loaded + bytes.length > allocation.bytes.length
        )
          unavailable();
        bytes.copy(allocation.bytes, allocation.loaded);
        allocation.loaded += bytes.length;
        return { operation: call.operation, offset: allocation.loaded };
      }
      case 'prepare':
        allocation.preparation ??= this.prepare(allocation);
        await allocation.preparation;
        this.input(attached, allocation);
        return { operation: call.operation, root: { ...allocation.prepared!.root } };
      case 'launch-commit':
        this.commit(allocation);
        return { operation: call.operation, state: 'committed' };
      case 'resume':
        if (!allocation.prepared || !allocation.spec) unavailable();
        allocation.resumption ??= allocation.prepared
          .resume(allocation.pending.owner, async () => {
            this.input(attached, allocation);
            await this.options.verifyLaunch(
              allocation.spec!,
              allocation.call.executableSha256,
              allocation.selection
            );
            this.input(attached, allocation);
          })
          .then(() => {
            this.input(attached, allocation);
            allocation.running = true;
            clearTimeout(allocation.timer);
          });
        await allocation.resumption;
        this.input(attached, allocation);
        return { operation: call.operation, state: 'running' };
      case 'read': {
        if (allocation.attachment !== attached) unavailable();
        const source = allocation.prepared?.[call.stream];
        if (!source) unavailable();
        return this.read(source);
      }
      case 'write':
      case 'end': {
        if (!allocation.running || !allocation.prepared || allocation.exit) unavailable();
        // The launch deadline bounds preparation only, not the subsequent lifetime of an admitted SDK.
        const stdin = allocation.prepared.stdin;
        await new Promise<void>((resolve, reject) => {
          const completed = (error?: Error | null) => (error ? reject(error) : resolve());
          if (call.operation === 'write') stdin.write(Buffer.from(call.bytes, 'base64'), completed);
          else stdin.end(completed);
        });
        this.assertAttached(attached);
        return { operation: call.operation, state: 'completed' };
      }
      case 'observe':
        return {
          operation: call.operation,
          root: allocation.exit
            ? 'exited'
            : allocation.running && !allocation.transportFailed
              ? 'running'
              : 'unknown',
          ...(allocation.exit ? { exit: allocation.exit } : {}),
          transportFailed: allocation.transportFailed,
        };
      case 'stop': {
        allocation.inputSealed = true;
        this.dropStaging(allocation);
        let retained = allocation.stops.get(call.attemptRef);
        if (!retained) {
          if (allocation.stops.size >= 64) unavailable();
          retained = {
            outcome: allocation.pending.stop({
              expectedOwner: allocation.pending.owner,
              attemptId: call.attemptRef,
              mode: 'force',
              deadlineMs: performance.now() + call.budgetMs,
            }),
          };
          allocation.stops.set(call.attemptRef, retained);
        }
        const outcome = await retained.outcome;
        if (outcome.kind !== 'confirmed') return { operation: call.operation, state: 'unknown' };
        if (!retained.receiptRef) {
          retained.receiptRef = randomUUID();
          allocation.receipts.set(retained.receiptRef, outcome.receipt);
        }
        return {
          operation: call.operation,
          state: 'confirmed',
          receiptRef: retained.receiptRef,
          receipt: outcome.receipt,
        };
      }
      case 'drain': {
        const outcome = await allocation.pending.drain(performance.now() + call.budgetMs);
        return { operation: call.operation, state: outcome.kind };
      }
      case 'release': {
        const receipt = allocation.receipts.get(call.receiptRef);
        if (!receipt) unavailable();
        if (!allocation.released) {
          await allocation.pending.release(receipt, 'job-membership');
          this.retire(allocation);
        }
        return { operation: call.operation, state: 'released' };
      }
    }
  }

  private read(source: Readable): HostCustodyResult {
    const value: unknown = source.read(
      Math.min(HOST_CUSTODY_CHUNK_BYTES, source.readableLength || HOST_CUSTODY_CHUNK_BYTES)
    );
    if (value !== null && !Buffer.isBuffer(value)) unavailable();
    return {
      operation: 'read',
      state: value ? 'data' : source.readableEnded ? 'eof' : 'empty',
      bytes: value ? (value as Buffer).toString('base64') : '',
      more: Boolean(value && source.readableLength),
    };
  }

  private retire(allocation: Allocation): void {
    allocation.released = true;
    allocation.dirty.clear();
    clearTimeout(allocation.timer);
    this.dropStaging(allocation);
    for (const unsubscribe of allocation.subscriptions.splice(0)) unsubscribe();
    const terminal = [...this.allocations.values()].filter((value) => value.released);
    for (const old of terminal.slice(0, Math.max(0, terminal.length - 64)))
      this.allocations.delete(old.call.capability); // Retired random keys can only become unknown, never rebound.
  }

  /** Called by the original Main on Quit; independent of availability or identity of a replacement Host. */
  close(): Promise<boolean> {
    this.shuttingDown = true;
    this.closing ??= Promise.all(
      [...this.allocations.values()].map(async (allocation) => {
        if (allocation.released) return true;
        try {
          const outcome = await allocation.pending.stop({
            expectedOwner: allocation.pending.owner,
            attemptId: 'main-owner-quit',
            mode: 'force',
            deadlineMs: performance.now() + 10000,
          });
          if (outcome.kind !== 'confirmed') return false;
          await allocation.pending.drain(performance.now() + 3000);
          await allocation.pending.release(outcome.receipt, 'job-membership');
          this.retire(allocation);
          return true;
        } catch {
          return false;
        }
      })
    ).then((results) => results.every(Boolean));
    return this.closing;
  }
}
