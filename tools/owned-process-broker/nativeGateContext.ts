import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import type {
  PendingOwnedProcess,
  Preparation,
  ProcessOwner,
  ResolvedLaunchSpec,
} from '../../src/main/utils/ownedProcess/contract';
import type { GatePhase, HelperRole } from './nativeGateDiagnostics';
import type { NativeGateEvents } from './nativeGateEvents';

export function timeout<T>(promise: Promise<T>, ms = 10000): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Native gate deadline')), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Native gate operation failed'));
      }
    );
  });
}
export async function waitFor(
  check: () => boolean,
  ms = 10000,
  events?: NativeGateEvents
): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('Native readiness deadline');
    const tick = new Promise<void>((done) => setTimeout(done, 5));
    await (events ? events.wait(tick) : tick);
  }
}
export async function capturedWitness(
  fixture: string,
  pid: number,
  birth: string,
  track: (child: ChildProcess) => void,
  events: NativeGateEvents
): Promise<{ process: ChildProcess; exit: Promise<number | null> }> {
  const guardedTimeout = <T>(operation: Promise<T>, ms?: number): Promise<T> =>
    timeout(events.wait(operation), ms);
  const process = spawn(fixture, ['wait', String(pid), birth], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  track(process);
  const exit = new Promise<number | null>((resolveExit, reject) => {
    process.on('exit', resolveExit);
    process.on('error', reject);
  });
  void exit.catch(() => undefined); // capture failure is separately surfaced below, including spawn errors
  await guardedTimeout(
    new Promise<void>((resolveCaptured, reject) => {
      process.stdout.once(
        'data',
        events.guard((data: Buffer) =>
          data.toString().includes('captured')
            ? resolveCaptured()
            : reject(new Error('Witness not captured'))
        )
      );
      process.once('exit', () => reject(new Error('Witness exited before capture')));
      process.once('error', reject);
    })
  );
  return { process, exit };
}
export function preparationError(failure: Extract<Preparation, { kind: 'failed' }>): Error {
  console.error(
    JSON.stringify({
      gateFailure: 'prepare',
      creation: failure.creation,
      diagnostics: failure.cleanup.diagnostics(),
    })
  );
  return new Error(failure.reason);
}
export async function brokerReleased(
  pending: PendingOwnedProcess,
  events: NativeGateEvents
): Promise<void> {
  await events.wait(waitFor(() => pending.diagnostics().brokerExit !== undefined, 3000, events));
  assert.deepEqual(
    pending.diagnostics().brokerExit,
    { code: 0, signal: null },
    'Original broker exits0 after full Released ACK'
  );
}
export interface StartMarker {
  path: string;
  nonce: string;
}
export interface GateContext {
  broker: string;
  fixture: string;
  birthFailureBroker: string;
  accountingFailureBroker: string;
  readonly track: (child: ChildProcess, role?: HelperRole) => void;
  readonly phase: (phase: GatePhase) => void;
  readonly events: NativeGateEvents;
  readonly retain: (pending: PendingOwnedProcess) => void;
  readonly marker: () => StartMarker;
  readonly spec: (mode: string, start: StartMarker) => ResolvedLaunchSpec;
  readonly owner: () => ProcessOwner;
}
