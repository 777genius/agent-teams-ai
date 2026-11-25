import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { sameOwner } from './contract.js';

import type { Readable } from 'node:stream';
import type { Preparation, PreparedOwnedProcess, ProcessOwner } from './contract.js';

/** Observable target IO only. This object is neither a native handle nor tree authority. */
export interface ObservableNativeProcess extends Pick<EventEmitter, 'on' | 'once' | 'off' | 'removeListener'> {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number | undefined;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface OwnedProcessFacadeOptions {
  owner: ProcessOwner;
  /** The caller has already retained the allocated pending capability before this runs. */
  prepare(): Promise<Preparation>;
  current(): boolean;
  /** Install original native-root authority and observers inside the pre-resume boundary. */
  installOwner(process: PreparedOwnedProcess): Promise<void>;
  /** Caller coalesces cleanup against its retained pending capability, including prepare failure. */
  requestStop(): boolean;
  signal?: AbortSignal;
}

/** Synchronous SDK process shape backed by asynchronous, suspended native preparation. */
export class OwnedProcessFacade extends EventEmitter implements ObservableNativeProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly stderr = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly ready: Promise<PreparedOwnedProcess>;
  private root: PreparedOwnedProcess['root'] | undefined;
  private nativeExit: number | null = null;
  private stopRequested = false;
  private stopAccepted = false;
  private failure: Error | undefined;
  private endedStreams = 0;
  private closed = false;
  private readonly options: OwnedProcessFacadeOptions;

  constructor(options: OwnedProcessFacadeOptions) {
    super();
    this.options = { ...options, owner: Object.freeze({ ...options.owner }) };
    // Errors remain observable by SDK listeners but cannot crash a caller attaching after prepare.
    this.on('error', () => {});
    this.stdout.on('error', () => {});
    this.stderr.on('error', () => {});
    this.stdin = new Writable({
      highWaterMark: 64 * 1024,
      write: (chunk: Buffer, _encoding, callback) => {
        void this.ready.then((process) => {
          this.assertInput();
          process.stdin.write(chunk, callback);
        }).catch((error: unknown) => callback(this.publicError(error)));
      },
      final: (callback) => {
        void this.ready.then((process) => {
          this.assertInput();
          process.stdin.end(callback);
        }).catch((error: unknown) => callback(this.publicError(error)));
      },
    });
    this.stdin.on('error', () => {});
    this.ready = Promise.resolve().then(() => this.prepare());
    void this.ready.catch((error: unknown) => this.fail(this.publicError(error)));
    const abort = () => { this.kill('SIGTERM'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    this.once('close', () => options.signal?.removeEventListener('abort', abort));
    if (options.signal?.aborted) abort();
  }

  get pid(): number | undefined { return this.root?.pid; }
  get killed(): boolean { return this.stopAccepted; }
  get exitCode(): number | null { return this.nativeExit; }
  get signalCode(): null { return null; }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    // The existing Windows primitive supplies force Stop; it cannot promise graceful signals.
    if (!['SIGTERM', 'SIGKILL', 15, 9].includes(signal)) return false;
    const accepted = this.stop();
    this.stdin.destroy(new Error('Native input is closed'));
    return accepted;
  }

  private stop(): boolean {
    if (this.stopRequested) return this.stopAccepted;
    this.stopRequested = true;
    try { this.stopAccepted = this.options.requestStop(); } catch { /* Caller retains unknown custody. */ }
    return this.stopAccepted;
  }

  private assertInput(): void {
    if (this.stopRequested || this.failure || this.nativeExit !== null || !this.options.current())
      throw new Error('Native input is unavailable');
  }

  private async prepare(): Promise<PreparedOwnedProcess> {
    this.assertInput();
    const result = await this.options.prepare();
    if (result.kind !== 'prepared') throw new Error('Native preparation is unavailable');
    const process = result.process;
    if (!sameOwner(process.owner, this.options.owner) ||
        !Number.isSafeInteger(process.root.pid) || process.root.pid <= 0 ||
        !/^[a-f0-9]{16}$/i.test(process.root.birth)) throw new Error('Native root is unavailable');
    this.root = Object.freeze({ ...process.root });
    process.observeRootExit((exit) => {
      if (exit.birth !== this.root?.birth || !Number.isInteger(exit.code)) {
        this.fail(new Error('Native exit identity is unavailable'));
        return;
      }
      if (this.nativeExit !== null) return;
      this.nativeExit = exit.code;
      // A private failure may already have closed SDK IO. Keep later native facts
      // for custody without sending an impossible close-then-exit event sequence.
      if (!this.closed) this.emit('exit', exit.code, null);
      this.maybeClose();
    });
    process.observeTransportFailure(() => this.fail(new Error('Native control is unavailable')));
    for (const [source, target] of [[process.stdout, this.stdout], [process.stderr, this.stderr]] as const) {
      source.once('end', () => { this.endedStreams++; this.maybeClose(); });
      source.on('error', () => this.fail(new Error('Native output is unavailable')));
      source.pipe(target);
    }
    this.assertInput();
    await process.resume(this.options.owner, async () => {
      this.assertInput();
      await this.options.installOwner(process);
      this.assertInput();
    });
    // A short-lived target may exit before the resume ACK reaches this reader.
    // Keep its real exit/output; later input writes still check the target state.
    if (this.stopRequested || this.failure || !this.options.current())
      throw new Error('Native resume is unavailable');
    return process;
  }

  private maybeClose(): void {
    if (this.closed || this.nativeExit === null || this.endedStreams !== 2) return;
    this.closed = true;
    this.emit('close', this.nativeExit, null);
  }

  private publicError(_error: unknown): Error {
    // Private launch inputs, native errors and control payloads are not SDK-visible diagnostics.
    return new Error('Native process is unavailable');
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.stop();
    this.stdin.destroy(error);
    this.stdout.destroy(error);
    this.stderr.destroy(error);
    this.emit('error', error);
    if (!this.closed) {
      this.closed = true;
      // This is IO closure only; null exit remains unknown and cannot settle the caller's custody.
      this.emit('close', this.nativeExit, null);
    }
  }
}
