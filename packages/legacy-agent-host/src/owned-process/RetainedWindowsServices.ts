import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

import { sameOwner } from './contract.js';
import {
  hostServiceCallSchema, serviceSource, validateServiceOutcome,
} from './retainedServiceContracts.js';

import type { OwnedServicePort, OwnedServiceResult, PendingServiceOperation } from './WindowsServiceOperations.js';
import type { ProcessOwner, TreeReceipt } from './contract.js';
import type { ServiceScopeFacts } from './codec.js';
import type {
  HostServiceCall, HostServiceResult, WindowsServiceCapture, WindowsServiceIntent,
  WindowsServiceOutcome, WindowsServiceSource,
} from './retainedServiceContracts.js';

interface Scope {
  capture: WindowsServiceCapture;
  terminal: boolean;
  settled: boolean;
}
interface OriginalOperation {
  intent: WindowsServiceIntent;
  pending: PendingServiceOperation;
  deadline: number;
  initial?: Promise<WindowsServiceOutcome>;
  local?: WindowsServiceOutcome;
}
export interface OriginalWholeServiceProof {
  mainEpoch: string;
  capability: string;
  generation: string;
  root: { pid: number; birth: string };
  receipt: TreeReceipt;
  released: boolean;
}
const unknown: WindowsServiceOutcome = Object.freeze({ state: 'unknown' });
const notDispatched = (reason: 'capacity' | 'deadline' | 'admission'): WindowsServiceOutcome =>
  ({ state: 'not-dispatched', reason });
function unavailable(): never { throw new Error('Original service custody unavailable'); }

/** Metadata and original operations of one existing Main allocation, never another physical owner. */
export class RetainedWindowsServices {
  private readonly operations = new Map<string, OriginalOperation>();
  private readonly scopes = new Map<string, Scope>();
  private readonly pendingCaptures = new Set<OriginalOperation>();
  private readonly source: WindowsServiceSource;

  constructor(private readonly options: {
    source: WindowsServiceSource;
    owner: ProcessOwner;
    port: OwnedServicePort;
    /** Populated only by the same allocation's genuine pending Stop/release path. */
    wholeProof(): OriginalWholeServiceProof | undefined;
  }) {
    this.source = structuredClone(serviceSource(options.source));
  }

  async handle(call: HostServiceCall, admitCapture: () => Promise<void>): Promise<HostServiceResult> {
    const entered = performance.now();
    call = hostServiceCallSchema.parse(call);
    const deadline = 'budgetMs' in call ? entered + call.budgetMs : undefined;
    const original = call.operation === 'service-query' ? call.capture : call.intent;
    if (call.capability !== this.source.providerCapability ||
      !isDeepStrictEqual(serviceSource(original), this.source)) unavailable();
    let outcome: WindowsServiceOutcome;
    if (call.operation === 'service-query') {
      outcome = await this.query(call.capture, deadline!);
    } else if (call.operation === 'service-lookup') {
      const retained = this.operations.get(call.intent.operationRef);
      if (retained && !isDeepStrictEqual(retained.intent, call.intent)) unavailable();
      outcome = retained ? this.latest(retained) : unknown;
    } else {
      outcome = await this.run(call.intent, deadline!, admitCapture);
    }
    validateServiceOutcome(call, outcome);
    // No caller receives a mutable reference into the retained operation/scope records.
    return structuredClone({ operation: call.operation, outcome });
  }

  private scope(capture: WindowsServiceCapture): Scope {
    const scope = this.scopes.get(capture.target.key);
    if (!scope || !isDeepStrictEqual(scope.capture, capture)) unavailable();
    return scope;
  }

  private whole(): OriginalWholeServiceProof | undefined {
    const proof = this.options.wholeProof();
    if (!proof || proof.mainEpoch !== this.source.mainEpoch ||
      proof.capability !== this.source.providerCapability ||
      proof.generation !== this.source.providerGeneration ||
      !isDeepStrictEqual(proof.root, this.source.root) ||
      !sameOwner(proof.receipt.owner, this.options.owner) ||
      proof.receipt.owner.processGeneration !== this.source.providerGeneration ||
      proof.receipt.coverage !== 'job-membership' || !proof.receipt.rootExited) return;
    return proof;
  }

  private absent(scope: Scope): 'retained-terminal' | 'original-whole-job' | undefined {
    if (scope.terminal) return 'retained-terminal';
    // The record exists only after this exact broker's genuine capture reply proved membership.
    if (this.whole()) return 'original-whole-job';
    return;
  }

  private run(intent: WindowsServiceIntent, deadline: number,
    admitCapture: () => Promise<void>): Promise<WindowsServiceOutcome> {
    const previous = this.operations.get(intent.operationRef);
    if (previous) {
      if (!isDeepStrictEqual(previous.intent, intent)) unavailable();
      return previous.initial ?? unavailable(); // Never run the same pending object with a new deadline.
    }
    if (this.operations.size >= 10000) return Promise.resolve(notDispatched('capacity'));
    if (performance.now() >= deadline) return Promise.resolve(notDispatched('deadline'));
    const command = intent.command;
    if (command.operation === 'capture') {
      if (this.scopes.size + this.pendingCaptures.size >= 4096)
        return Promise.resolve(notDispatched('capacity'));
    } else {
      const scope = this.scope(command.capture);
      if (command.operation === 'settle' && !this.absent(scope)) unavailable();
    }
    const pending = this.options.port.allocate(command.operation === 'capture'
      ? { operation: 'capture', pid: command.pid }
      : { operation: command.operation, identity: command.capture.target });
    const entry: OriginalOperation = { intent: structuredClone(intent), pending, deadline };
    this.operations.set(intent.operationRef, entry); // Retain before source verification, native run or any await.
    if (command.operation === 'capture') this.pendingCaptures.add(entry);
    entry.initial = this.execute(entry, admitCapture);
    return entry.initial;
  }

  private async execute(entry: OriginalOperation, admitCapture: () => Promise<void>): Promise<WindowsServiceOutcome> {
    if (entry.intent.command.operation === 'capture') {
      try { await admitCapture(); }
      catch {
        entry.local = notDispatched('admission');
        this.pendingCaptures.delete(entry);
        return entry.local;
      }
    } else if (entry.intent.command.operation === 'settle') {
      const scope = this.scope(entry.intent.command.capture);
      if (scope.settled || this.whole()?.released) {
        scope.terminal = true;
        scope.settled = true;
        entry.local = { state: 'settled', capture: scope.capture };
        return entry.local;
      }
    }
    try {
      const result = await entry.pending.run(entry.deadline);
      return this.project(entry, result);
    } catch {
      // This path cannot infer no effect or delete the original pending/wire debt.
      return unknown;
    }
  }

  private latest(entry: OriginalOperation): WindowsServiceOutcome {
    if (entry.local) return entry.local;
    const result = entry.pending.snapshot().result;
    return result ? this.project(entry, result) : unknown;
  }

  private project(entry: OriginalOperation, result: OwnedServiceResult): WindowsServiceOutcome {
    const command = entry.intent.command;
    if (command.operation === 'capture' && result.state !== 'unknown')
      this.pendingCaptures.delete(entry);
    if (result.state === 'unknown' || result.state === 'not-dispatched' || result.state === 'refused')
      return result;
    if (command.operation === 'capture') {
      if (result.state !== 'captured') unavailable();
      const capture: WindowsServiceCapture = {
        ...serviceSource(this.source), version: 5, platform: 'win32', admission: 'main-owned-job-scope-v1',
        target: { pid: command.pid, key: result.identity.key, birth: result.identity.birth },
        registrar: structuredClone(command.registrar),
      };
      const previous = this.scopes.get(capture.target.key);
      if (previous && !isDeepStrictEqual(previous.capture, capture)) return { state: 'conflict' };
      if (!previous) {
        if (this.scopes.size >= 4096) unavailable();
        this.scopes.set(capture.target.key, { capture, terminal: false, settled: false });
      }
      return { state: 'captured', capture: previous?.capture ?? capture };
    }
    const scope = this.scope(command.capture);
    if (result.state === 'settled') {
      if (command.operation !== 'settle') unavailable();
      scope.terminal = true;
      scope.settled = true;
      return { state: 'settled', capture: scope.capture };
    }
    if (result.state !== 'stopped' || command.operation !== 'stop') unavailable();
    return { state: 'stopped', capture: scope.capture,
      observation: this.observeFacts(scope, result.facts), evidence: 'native-scope' };
  }

  private observeFacts(scope: Scope, facts: ServiceScopeFacts): 'same-live' | 'absent' | 'unknown' {
    if (facts.key !== scope.capture.target.key || facts.birth !== scope.capture.target.birth) unavailable();
    if (facts.queryError) return 'unknown';
    if (facts.rootExited && facts.activeProcesses === 0) {
      scope.terminal = true;
      return 'absent';
    }
    return facts.activeProcesses > 0 ? 'same-live' : 'unknown';
  }

  private async query(capture: WindowsServiceCapture, deadline: number): Promise<WindowsServiceOutcome> {
    const scope = this.scope(capture);
    const terminal = this.absent(scope);
    if (terminal) return { state: 'observed', capture: scope.capture,
      observation: 'absent', evidence: terminal };
    const result = await this.options.port.query(scope.capture.target, deadline);
    if (result.state === 'unknown' || result.state === 'not-dispatched' || result.state === 'refused') return result;
    if (result.state !== 'observed') unavailable();
    return { state: 'observed', capture: scope.capture,
      observation: this.observeFacts(scope, result.facts), evidence: 'native-scope' };
  }

  /** Physical release alone cannot evict a lost application capture/Stop result. */
  retirable(): boolean {
    try {
      for (const entry of this.operations.values()) {
        const latest = this.latest(entry);
        if (latest.state === 'unknown') return false;
      }
      return [...this.scopes.values()].every(scope => scope.settled);
    } catch { return false; }
  }
}
