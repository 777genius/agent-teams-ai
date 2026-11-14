import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

import {
  hostServiceCallSchema, serviceSource, windowsServiceCaptureSchema, windowsServiceIntentSchema,
} from './retainedServiceContracts.js';

import type { HostCustodyClient } from './hostCustody.js';
import type { PendingOwnedProcess } from './contract.js';
import type { RegistrarBinding } from '../process/registeredProcessContracts.js';
import type {
  HostServiceCall, WindowsRegisteredProcessPort, WindowsServiceCapture, WindowsServiceIntent,
  WindowsServiceOutcome, WindowsServiceSource,
} from './retainedServiceContracts.js';

interface LocalIntent {
  admit(): void;
  initial?: Promise<WindowsServiceOutcome>;
  deadline?: number;
  refused?: WindowsServiceOutcome;
}
const unknown: WindowsServiceOutcome = Object.freeze({ state: 'unknown' });
function unavailable(): never { throw new Error('Original retained process unavailable'); }
function frozenOutcome(value: WindowsServiceOutcome): WindowsServiceOutcome {
  const outcome = structuredClone(value);
  if ('capture' in outcome) {
    Object.freeze(outcome.capture.root); Object.freeze(outcome.capture.target);
    Object.freeze(outcome.capture.registrar); Object.freeze(outcome.capture);
  }
  return Object.freeze(outcome);
}
function frozenIntent(value: unknown): WindowsServiceIntent {
  const intent = windowsServiceIntentSchema.parse(value);
  Object.freeze(intent.root);
  if (intent.command.operation === 'capture') Object.freeze(intent.command.registrar);
  else {
    const capture = intent.command.capture;
    Object.freeze(capture.root); Object.freeze(capture.target); Object.freeze(capture.registrar);
    Object.freeze(capture);
  }
  Object.freeze(intent.command);
  return Object.freeze(intent);
}

/** Original Host intent references only. Main alone retains native pending objects and scope facts. */
export class HostWindowsServices implements WindowsRegisteredProcessPort {
  private readonly originals = new WeakMap<WindowsServiceIntent, LocalIntent>();

  constructor(private readonly options: {
    client(): HostCustodyClient;
    captureSource(original: PendingOwnedProcess): WindowsServiceSource;
  }) {}

  private currentMain(source: WindowsServiceSource): void {
    if (this.options.client().originalBinding().mainEpoch !== source.mainEpoch) unavailable();
  }

  prepareCapture(original: PendingOwnedProcess, pid: number, registrar: RegistrarBinding): WindowsServiceIntent {
    const source = this.options.captureSource(original);
    this.currentMain(source);
    const intent = frozenIntent({ ...serviceSource(source), operationRef: randomUUID(),
      command: { operation: 'capture', pid, registrar } });
    this.originals.set(intent, { admit: () => {
      this.currentMain(intent);
      if (!isDeepStrictEqual(this.options.captureSource(original), serviceSource(intent))) unavailable();
    } });
    return intent;
  }

  prepareControl(value: WindowsServiceCapture, operation: 'stop' | 'settle'): WindowsServiceIntent {
    const capture = windowsServiceCaptureSchema.parse(value);
    this.currentMain(capture);
    const intent = frozenIntent({ ...serviceSource(capture), operationRef: randomUUID(),
      command: { operation, capture } });
    this.originals.set(intent, { admit: () => this.currentMain(intent) });
    return intent;
  }

  run(intent: WindowsServiceIntent, deadline: number): Promise<WindowsServiceOutcome> {
    // A serialized or successor-Host intent may only be looked up, never dispatched anew.
    const original = this.originals.get(intent);
    if (!original) return Promise.resolve(unknown);
    if (original.initial) {
      if (original.deadline !== deadline) unavailable();
      return original.initial;
    }
    original.deadline = deadline;
    original.initial = this.request(() => {
      original.admit();
      return hostServiceCallSchema.parse({ operation: `service-${intent.command.operation}`,
        capability: intent.providerCapability, intent,
        budgetMs: Math.max(0, Math.min(30000, Math.floor(deadline - performance.now()))) });
    }, `service-${intent.command.operation}`, deadline, true).then(result => {
      const outcome = frozenOutcome(result);
      if (outcome.state === 'not-dispatched') original.refused = outcome;
      return outcome;
    });
    return original.initial;
  }

  lookup(value: WindowsServiceIntent, deadline: number): Promise<WindowsServiceOutcome> {
    const original = this.originals.get(value);
    if (original && !original.initial)
      return Promise.resolve({ state: 'not-dispatched', reason: 'admission' });
    if (original?.refused) return Promise.resolve(structuredClone(original.refused));
    const intent = windowsServiceIntentSchema.parse(value);
    return this.request(() => {
      this.currentMain(intent);
      return { operation: 'service-lookup', capability: intent.providerCapability, intent };
    }, 'service-lookup', deadline);
  }

  query(value: WindowsServiceCapture, deadline: number): Promise<WindowsServiceOutcome> {
    const capture = windowsServiceCaptureSchema.parse(value);
    return this.request(() => {
      this.currentMain(capture);
      return { operation: 'service-query', capability: capture.providerCapability, capture,
        budgetMs: Math.max(0, Math.min(30000, Math.floor(deadline - performance.now()))) };
    }, 'service-query', deadline);
  }

  private async request(build: () => HostServiceCall, operation: HostServiceCall['operation'],
    deadline: number, firstEffect = false): Promise<WindowsServiceOutcome> {
    if (!Number.isFinite(deadline) || deadline <= performance.now())
      return firstEffect ? { state: 'not-dispatched', reason: 'deadline' } : unknown;
    try {
      const reply = await this.options.client().requestWhenReady(operation, build, deadline);
      if (reply.status === 'refused')
        return firstEffect ? { state: 'not-dispatched', reason: 'admission' } : unknown;
      if (reply.status !== 'completed' || reply.value.operation !== operation || !('outcome' in reply.value))
        return unknown;
      return structuredClone(reply.value.outcome);
    } catch { return unknown; }
  }
}
