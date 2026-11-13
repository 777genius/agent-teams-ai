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
  events: NativeGateEvents,
  mode: 'wait-gated' | 'vendor-wait-gated' = 'wait-gated'
): Promise<{ process: ChildProcess; exit: Promise<number | null> }> {
  const guardedTimeout = <T>(operation: Promise<T>, ms?: number): Promise<T> =>
    timeout(events.wait(operation), ms);
  const process = spawn(fixture, [mode, String(pid), birth], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  track(process);
  process.stdin.on('error', events.guard(() => { throw new Error('Witness acknowledgement failed'); }));
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
  // Keep the witness alive until its HANDLE capture is observed, even when the
  // original target has already exited and the first native wait returns at once.
  await guardedTimeout(new Promise<void>((resolveAck, reject) => {
    process.stdin.end('1', (error?: Error | null) => error ? reject(error) : resolveAck());
  }));
  return { process, exit };
}

/** TEST-only fresh zero-time observations of one HANDLE retained before provider resume. */
export async function capturedQueryableWitness(
  fixture: string, pid: number, birth: string, track: (child: ChildProcess) => void,
  events: NativeGateEvents
): Promise<{
  process: ChildProcess;
  observe(): Promise<'alive' | 'absent'>;
  wait(): Promise<number | null>;
}> {
  const child = spawn(fixture, ['vendor-query-wait-gated', String(pid), birth], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  track(child);
  let pending: { resolve(value: string): void; reject(error: Error): void } | undefined;
  let buffer = '', queries = 0, querying = false;
  let waiting: Promise<number | null> | undefined;
  const failure = () => new Error('Original HANDLE witness unavailable');
  child.stdout.on('data', events.guard((bytes: Buffer) => {
    buffer += bytes.toString('ascii');
    assert.ok(buffer.length <= 64, 'Bounded original witness output');
    const end = buffer.indexOf('\n');
    if (end < 0) return;
    const line = buffer.slice(0, end).replace(/\r$/, '');
    buffer = buffer.slice(end + 1);
    assert.ok(pending && !buffer.length, 'Exactly one original witness reply');
    const original = pending; pending = undefined; original.resolve(line);
  }));
  child.stdin.on('error', events.guard(() => { throw failure(); }));
  const exit = new Promise<number | null>((resolveExit, reject) => {
    child.once('exit', code => { pending?.reject(failure()); pending = undefined; resolveExit(code); });
    child.once('error', error => { pending?.reject(failure()); pending = undefined; reject(error); });
  });
  void exit.catch(() => undefined);
  const line = () => {
    assert.equal(pending, undefined);
    assert.equal(child.exitCode, null);
    return new Promise<string>((resolveLine, reject) => {
      pending = { resolve: resolveLine, reject };
    });
  };
  assert.equal(await timeout(events.wait(line())), 'captured');
  return {
    process: child,
    async observe() {
      assert.ok(!querying && !waiting && queries++ < 4, 'Finite sequential original HANDLE observations');
      querying = true;
      try {
        const response = line();
        void response.catch(() => undefined);
        await timeout(events.wait(new Promise<void>((done, reject) => {
          child.stdin.write('Q', error => error ? reject(error) : done());
        })));
        const result = await timeout(events.wait(response));
        assert.ok(result === 'alive' || result === 'absent', 'Closed original HANDLE facts only');
        return result;
      } finally { querying = false; }
    },
    wait() {
      assert.equal(querying, false);
      waiting ??= (async () => {
        await timeout(events.wait(new Promise<void>((done, reject) => {
          child.stdin.end('W', (error?: Error | null) => error ? reject(error) : done());
        })));
        return timeout(events.wait(exit));
      })();
      return waiting;
    },
  };
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
