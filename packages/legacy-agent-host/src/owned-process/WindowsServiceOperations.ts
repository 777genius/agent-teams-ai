import { performance } from 'node:perf_hooks';

import {
  decodeServiceFacts,
  decodeServiceIdentity,
  decodeServiceRefusal,
  encodeServiceCaptureCurrent,
  encodeServiceScope,
  encodeServiceStop,
  Op,
} from './codec.js';

import type { Frame, ServiceScopeFacts, ServiceScopeIdentity } from './codec.js';

export type OwnedServiceCommand =
  | Readonly<{ operation: 'capture'; pid: number }>
  | Readonly<{ operation: 'stop' | 'settle'; identity: ServiceScopeIdentity }>;
export type OwnedServiceResult =
  | Readonly<{ state: 'not-dispatched'; reason: 'deadline' | 'capacity' | 'admission' | 'closed' }>
  | Readonly<{ state: 'unknown' }>
  | Readonly<{ state: 'captured' | 'settled'; identity: ServiceScopeIdentity }>
  | Readonly<{ state: 'observed' | 'stopped'; facts: ServiceScopeFacts }>
  | Readonly<{ state: 'refused'; reason: number; nativeCode: number }>;
export type OwnedServiceSnapshot = Readonly<{
  phase: 'prepared' | 'queued' | 'requested' | 'settled';
  wireId?: string;
  result?: OwnedServiceResult;
}>;
export interface PendingServiceOperation {
  readonly command: OwnedServiceCommand;
  /** One immutable initial outcome. A later validated reply is read through snapshot(). */
  run(deadlineMs: number): Promise<OwnedServiceResult>;
  snapshot(): OwnedServiceSnapshot;
}
export interface OwnedServicePort {
  /** Pure allocation; the Main owner retains the original operation before run(). */
  allocate(command: OwnedServiceCommand): PendingServiceOperation;
  /** Read-only; it does not allocate durable application operation history. */
  query(identity: ServiceScopeIdentity, deadlineMs: number): Promise<OwnedServiceResult>;
}

type Command = OwnedServiceCommand | Readonly<{ operation: 'query'; identity: ServiceScopeIdentity }>;
interface Entry {
  command: Command;
  phase: OwnedServiceSnapshot['phase'];
  deadline?: number;
  timer?: ReturnType<typeof setTimeout>;
  wireId?: string;
  latest?: OwnedServiceResult;
  initial?: Promise<OwnedServiceResult>;
  finish?: (result: OwnedServiceResult) => void;
}
interface ServiceWire {
  /** False is only pre-admission capacity pressure; it creates no wire ID or effect. */
  send(
    opcode: number,
    response: number,
    payload: Buffer,
    received: (frame: Frame) => void,
    admitted: (id: bigint) => void,
    failed: () => void
  ): boolean;
  captureAllowed(): boolean;
  invalidReply(): void;
}
const remaining = (deadline: number): number =>
  Math.max(0, Math.min(60000, Math.floor(deadline - performance.now())));
const unknown: OwnedServiceResult = Object.freeze({ state: 'unknown' });
function copyIdentity(value: ServiceScopeIdentity): ServiceScopeIdentity {
  for (const field of [value.key, value.birth]) {
    if (!/^[a-f0-9]{16}$/.test(field) || field === '0000000000000000')
      throw new Error('Invalid original service identity');
  }
  return Object.freeze({ key: value.key, birth: value.birth });
}
function copyCommand(command: OwnedServiceCommand): OwnedServiceCommand {
  if (command.operation === 'capture') {
    encodeServiceCaptureCurrent(command.pid);
    return Object.freeze({ operation: command.operation, pid: command.pid });
  }
  if (command.operation !== 'stop' && command.operation !== 'settle')
    throw new Error('Unsupported original service operation');
  return Object.freeze({ operation: command.operation, identity: copyIdentity(command.identity) });
}

/** Service work shares the original broker/decoder; no second transport or ownership registry. */
export class WindowsServiceOperations implements OwnedServicePort {
  private readonly waiting: Entry[] = [];
  private readonly active = new Set<Entry>();
  private closed = false;
  private pumping = false;

  constructor(private readonly wire: ServiceWire) {}

  allocate(command: OwnedServiceCommand): PendingServiceOperation {
    const captured = copyCommand(command);
    const entry: Entry = { command: captured, phase: 'prepared' };
    return Object.freeze({
      command: captured,
      run: (deadline: number) => this.run(entry, deadline),
      snapshot: (): OwnedServiceSnapshot => Object.freeze({
        phase: entry.phase,
        ...(entry.wireId === undefined ? {} : { wireId: entry.wireId }),
        ...(entry.latest ? { result: entry.latest } : {}),
      }),
    });
  }

  query(identity: ServiceScopeIdentity, deadlineMs: number): Promise<OwnedServiceResult> {
    return this.run({ command: { operation: 'query', identity: copyIdentity(identity) }, phase: 'prepared' }, deadlineMs);
  }

  private run(entry: Entry, deadline: number): Promise<OwnedServiceResult> {
    if (entry.initial) {
      if (deadline !== entry.deadline) throw new Error('Conflicting original service deadline');
      return entry.initial;
    }
    if (!Number.isFinite(deadline) || deadline > performance.now() + 60000)
      throw new Error('Invalid original service deadline');
    entry.deadline = deadline;
    let finished = false;
    entry.initial = new Promise(resolve => {
      entry.finish = result => {
        if (finished) return;
        finished = true;
        if (entry.timer) clearTimeout(entry.timer);
        resolve(result);
      };
    });
    if (this.closed) this.refuse(entry, 'closed');
    else if (!remaining(deadline)) this.refuse(entry, 'deadline');
    // The existing Host family admits at most32 calls; old native wire debt uses its own3 slots.
    else if (this.waiting.length >= 32) this.refuse(entry, 'capacity');
    else if (entry.command.operation === 'capture' && !this.wire.captureAllowed())
      this.refuse(entry, 'admission');
    else {
      entry.phase = 'queued';
      this.waiting.push(entry);
      entry.timer = setTimeout(() => {
        if (entry.phase === 'queued') this.refuse(entry, 'deadline');
        else if (entry.phase === 'requested') {
          entry.latest = unknown;
          entry.finish!(unknown); // Keep the original native waiter and service slot for a late ACK.
        }
        this.wake();
      }, remaining(deadline));
      this.wake();
    }
    return entry.initial;
  }

  private refuse(entry: Entry, reason: Extract<OwnedServiceResult, { state: 'not-dispatched' }>['reason']): void {
    const index = this.waiting.indexOf(entry);
    if (index >= 0) this.waiting.splice(index, 1);
    const result: OwnedServiceResult = Object.freeze({ state: 'not-dispatched', reason });
    entry.phase = 'settled'; entry.latest = result; entry.finish!(result);
  }

  /** Re-enter after the original broker consumes a reply or frees a wire slot. */
  wake(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (this.active.size < 3 && this.waiting.length) {
        const index = this.waiting.findIndex(entry =>
          entry.command.operation === 'stop' || entry.command.operation === 'settle');
        const entry = this.waiting[index < 0 ? 0 : index]!;
        if (!remaining(entry.deadline!)) { this.refuse(entry, 'deadline'); continue; }
        if (entry.command.operation === 'capture' && !this.wire.captureAllowed()) {
          this.refuse(entry, 'admission'); continue;
        }
        const { command } = entry;
        const opcode = command.operation === 'capture' ? Op.serviceCaptureCurrent :
          command.operation === 'query' ? Op.serviceQuery :
            command.operation === 'stop' ? Op.serviceStop : Op.serviceSettle;
        const response = command.operation === 'capture' ? Op.serviceCaptured :
          command.operation === 'query' ? Op.serviceObserved :
            command.operation === 'stop' ? Op.serviceStopped : Op.serviceSettled;
        const payload = command.operation === 'capture' ? encodeServiceCaptureCurrent(command.pid) :
          command.operation === 'stop' ? encodeServiceStop(command.identity.key, remaining(entry.deadline!)) :
            encodeServiceScope(command.identity.key);
        // A native write may synchronously reply in the controlled peer. Retain the original first.
        this.active.add(entry);
        const admitted = this.wire.send(opcode, response, payload, frame => this.receive(entry, frame), id => {
          const queued = this.waiting.indexOf(entry);
          if (queued < 0 || entry.phase !== 'queued' || entry.wireId !== undefined)
            throw new Error('Invalid original service admission');
          this.waiting.splice(queued, 1);
          entry.phase = 'requested'; entry.wireId = id.toString();
        }, () => {
          if (entry.phase !== 'settled') { entry.latest = unknown; entry.finish!(unknown); }
          // Failure is not a validated reply; the original native wire debt remains held.
        });
        if (!admitted) { this.active.delete(entry); return; }
      }
    } finally { this.pumping = false; }
  }

  private receive(entry: Entry, frame: Frame): void {
    try {
      let result: OwnedServiceResult;
      if (frame.opcode === Op.serviceRefused) {
        result = Object.freeze({ state: 'refused', ...decodeServiceRefusal(frame) });
      } else if (entry.command.operation === 'capture' || entry.command.operation === 'settle') {
        const identity = decodeServiceIdentity(frame);
        if (entry.command.operation === 'settle') this.sameIdentity(entry.command.identity, identity);
        result = Object.freeze({ state: entry.command.operation === 'capture' ? 'captured' : 'settled', identity });
      } else {
        const facts = decodeServiceFacts(frame);
        this.sameIdentity(entry.command.identity, facts);
        result = Object.freeze({ state: entry.command.operation === 'query' ? 'observed' : 'stopped', facts });
      }
      entry.phase = 'settled'; entry.latest = result;
      // The timer may be delayed by the event loop. A late real reply is lookup evidence only.
      entry.finish!(remaining(entry.deadline!) ? result : unknown);
      this.active.delete(entry);
      this.wake();
    } catch {
      this.wire.invalidReply(); // Original provider containment remains unknown, never a fabricated service fact.
    }
  }

  private sameIdentity(expected: ServiceScopeIdentity, actual: ServiceScopeIdentity): void {
    if (expected.key !== actual.key || expected.birth !== actual.birth)
      throw new Error('Original service reply identity mismatch');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.waiting]) this.refuse(entry, 'closed');
    for (const entry of this.active) {
      if (entry.phase !== 'settled') { entry.latest = unknown; entry.finish!(unknown); }
    }
    this.active.clear(); // Transport is terminal; pending objects still retain their original unknown outcomes.
  }
}
