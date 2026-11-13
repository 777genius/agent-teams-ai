import {
  type ChildProcess, type ChildProcessWithoutNullStreams, execFile,
  type ExecFileException, type ExecFileOptions, spawn, type SpawnOptions, type SpawnOptionsWithStdioTuple,
  spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns, type StdioPipe,
} from 'node:child_process';
import { getSystemErrorName } from 'node:util';

import {
  linuxChildLaunchFailure, retainLinuxChildAllocationFailure, selectedLinuxChildExecutable, withLinuxChildExecTarget,
} from './linuxChildLaunchSelection';

type Handoff = {
  readonly entered: number;
  error?: Error;
  readonly listeners: Set<(error: Error) => void>;
};
const handoffs = new WeakMap<ChildProcess, Handoff>();

function decodeFailure(frame: Buffer, command: string, args: readonly string[]): Error | null {
  if (frame.length === 0) return null; // EOF is not an exec-success or ready witness.
  if (frame.length !== 12 || frame.readUInt32BE(0) !== 0x41544c58 || frame[4] !== 1 ||
      frame[6] !== 0 || frame[7] !== 0 || frame[5]! < 1 || frame[5]! > 3)
    return linuxChildLaunchFailure('status', true);
  const errno = frame.readUInt32LE(8);
  if (errno < 1 || errno > 4095) return linuxChildLaunchFailure('status', true);
  return withLinuxChildExecTarget(linuxChildLaunchFailure(
    frame[5] === 1 ? 'setup' : frame[5] === 2 ? 'close-range' : 'exec', true, errno), command, args);
}
function retainStatus(child: ChildProcess, entered: number, command: string, args: readonly string[]): (error: Error) => void {
  const state: Handoff = { entered, listeners: new Set() };
  handoffs.set(child, state);
  const pipe = child.stdio[3];
  let frame = Buffer.alloc(0), ended = false;
  const refuse = (error: Error): void => {
    if (state.error) return;
    state.error = error;
    for (const listener of state.listeners) listener(error);
  };
  child.once('error', (error: Error) => {
    retainLinuxChildAllocationFailure(error);
    refuse(error); // Retain the genuine Node event/error; never emit a synthetic event.
  });
  if (!pipe || !('on' in pipe)) {
    queueMicrotask(() => {
      if (child.pid !== undefined) refuse(linuxChildLaunchFailure('status', true));
    });
    return refuse;
  }
  pipe.on('data', (chunk: Buffer) => {
    if (state.error) return;
    if (!Buffer.isBuffer(chunk) || frame.length + chunk.length > 12) {
      refuse(linuxChildLaunchFailure('status', true));
      return;
    }
    frame = Buffer.concat([frame, chunk]);
  });
  pipe.once('end', () => {
    ended = true;
    const error = decodeFailure(frame, command, args);
    if (error) refuse(error);
  });
  pipe.once('error', () => refuse(linuxChildLaunchFailure('status', true)));
  pipe.once('close', () => {
    if (!ended && child.pid !== undefined) refuse(linuxChildLaunchFailure('status', true));
  });
  child.once('close', () => state.listeners.clear());
  return refuse;
}

/** This callback is private failure evidence, never a fabricated ChildProcess event. */
export function observeLinuxChildLaunchFailure(child: ChildProcess, listener: (error: Error) => void): () => void {
  const state = handoffs.get(child);
  if (!state) return () => {};
  if (state.error) queueMicrotask(() => listener(state.error!));
  else state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}
export function remainingLinuxChildLaunchTime(child: ChildProcess, budget: number, originalEntered?: number): number {
  const entered = handoffs.get(child)?.entered;
  return entered === undefined ? budget : Math.max(0, Math.floor(budget - (performance.now() - (originalEntered ?? entered))));
}
function stdio(options: SpawnOptions | SpawnSyncOptions): NonNullable<SpawnOptions['stdio']> {
  const supplied = options.stdio;
  const values = Array.isArray(supplied) ? [...supplied] :
    supplied === undefined || supplied === 'pipe' ? ['pipe', 'pipe', 'pipe'] :
    supplied === 'ignore' ? ['ignore', 'ignore', 'ignore'] :
    supplied === 'inherit' ? [0, 1, 2] : null;
  if (values === null || values.length > 3 || values.some(value => value === 'ipc') || options.shell)
    throw linuxChildLaunchFailure('options');
  while (values.length < 3) values.push('pipe');
  return [...values, 'pipe'] as NonNullable<SpawnOptions['stdio']>;
}
function invocation(command: string, args: readonly string[], argv0?: string): string[] {
  if (!command || command.includes('\0') || typeof argv0 !== 'undefined' && argv0.includes('\0') ||
      args.some(arg => typeof arg !== 'string' || arg.includes('\0')))
    throw linuxChildLaunchFailure('options');
  return ['--linux-child-exec-v1', command, argv0 ?? command, ...args];
}
function remaining(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  if (!Number.isFinite(deadline)) throw linuxChildLaunchFailure('options');
  const result = Math.floor(deadline - performance.now());
  if (result <= 0) throw linuxChildLaunchFailure('deadline');
  return result;
}
function finiteDeadline(entered: number, timeout: number | undefined): number | undefined {
  if (timeout === undefined || timeout === 0) return undefined;
  if (!Number.isInteger(timeout) || timeout < 0) throw linuxChildLaunchFailure('options');
  return entered + timeout;
}

export function spawnWithLinuxChildLaunch(command: string, args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>): ChildProcessWithoutNullStreams;
export function spawnWithLinuxChildLaunch(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
export function spawnWithLinuxChildLaunch(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const entered = performance.now(), helper = selectedLinuxChildExecutable();
  if (helper === null) return spawn(command, args, options);
  const deadline = finiteDeadline(entered, options.timeout), channels = stdio(options);
  const target = invocation(command, args, options.argv0), timeout = remaining(deadline);
  const child = spawn(helper, target, { ...options, argv0: helper, shell: false, stdio: channels, timeout: 0 });
  const refuse = retainStatus(child, entered, command, target.slice(3));
  if (timeout !== undefined) {
    const timer = setTimeout(() => {
      try { child.kill(options.killSignal ?? 'SIGTERM'); }
      catch (error) { refuse(error instanceof Error ? error : linuxChildLaunchFailure('status', true)); }
    }, Math.max(0, deadline! - performance.now()));
    child.once('exit', () => clearTimeout(timer));
    child.once('close', () => clearTimeout(timer));
  }
  return child;
}

type Callback = (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void;
export function execFileWithLinuxChildLaunch(command: string, args: readonly string[],
  options: ExecFileOptions,
  callback: Callback, originalDeadline?: number,
  onAllocatedFailure?: (child: ChildProcess, error: Error) => Promise<void>): ChildProcess {
  const entered = performance.now(), helper = selectedLinuxChildExecutable();
  if (helper === null) return execFile(command, args, options, callback);
  const timeoutDeadline = finiteDeadline(entered, options.timeout);
  const deadline = timeoutDeadline === undefined ? originalDeadline :
    originalDeadline === undefined ? timeoutDeadline : Math.min(timeoutDeadline, originalDeadline);
  const maxBuffer = options.maxBuffer ?? 1024 * 1024, killSignal = options.killSignal ?? 'SIGTERM';
  if (maxBuffer !== Infinity && (!Number.isFinite(maxBuffer) || maxBuffer < 0)) throw linuxChildLaunchFailure('options');
  const suppliedEncoding = Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8';
  const encoding = typeof suppliedEncoding === 'string' && suppliedEncoding !== 'buffer' && Buffer.isEncoding(suppliedEncoding)
    ? suppliedEncoding as BufferEncoding : null;
  // Same finite projection as Node execFile: in particular, no detached or argv0.
  const projected: SpawnOptions = {
    cwd: options.cwd, env: options.env, gid: options.gid, shell: options.shell,
    signal: options.signal, uid: options.uid, windowsHide: !!options.windowsHide,
    windowsVerbatimArguments: !!options.windowsVerbatimArguments,
  };
  const channels = stdio(projected), target = invocation(command, args);
  const timeout = remaining(deadline);
  const child = spawn(helper, target, { ...projected, shell: false, stdio: channels });
  retainStatus(child, entered, command, target.slice(3));
  const stdout: Array<string | Buffer> = [], stderr: Array<string | Buffer> = [];
  let stdoutBytes = 0, stderrBytes = 0, failure: ExecFileException | null = null;
  let completed = false, killed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const joined = (chunks: Array<string | Buffer>): string | Buffer =>
    encoding ? chunks.join('') : Buffer.concat(chunks as Buffer[]);
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (completed) return;
    completed = true;
    if (timer !== undefined) clearTimeout(timer);
    const out = joined(stdout), err = joined(stderr);
    if (!failure && code === 0 && signal === null) { callback(null, out, err); return; }
    failure ??= Object.assign(new Error('Command failed: ' + command + (args.length ? ' ' + args.join(' ') : '') + '\n' + String(err)), {
      code: code !== null && code < 0 ? getSystemErrorName(code) : code,
      killed: child.killed || killed, signal,
    }) as ExecFileException;
    Object.assign(failure, { cmd: command + (args.length ? ' ' + args.join(' ') : '') });
    callback(failure, out, err);
  };
  const fail = (error: Error): void => {
    if (completed) return;
    failure ??= error;
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.pid === undefined) finish(null, null);
    // An allocated child keeps its original callback pending until genuine close.
  };
  const kill = (): void => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    killed = true;
    try { child.kill(killSignal); }
    catch (error) { fail(error instanceof Error ? error : linuxChildLaunchFailure('status', true)); }
  };
  observeLinuxChildLaunchFailure(child, (error) => {
    fail(error);
    if (child.pid === undefined) return;
    // Start the original tree owner's cleanup before any immediate-child signal.
    // The ordinary callback still waits for this same child's real close.
    if (onAllocatedFailure) {
      try { void onAllocatedFailure(child, error).catch(() => kill()); }
      catch { kill(); }
    } else kill();
  });
  if (timeout !== undefined) timer = setTimeout(kill, Math.max(0, deadline! - performance.now()));
  const collect = (stream: 'stdout' | 'stderr', chunk: string | Buffer): void => {
    if (completed) return;
    const chunks = stream === 'stdout' ? stdout : stderr;
    const length = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding ?? 'utf8') : chunk.length;
    const before = stream === 'stdout' ? stdoutBytes : stderrBytes;
    if (stream === 'stdout') stdoutBytes += length; else stderrBytes += length;
    if (before + length <= maxBuffer) { chunks.push(chunk); return; }
    // Match the original execFile collector's truncation and kill boundary.
    chunks.push(chunk.slice(0, Math.max(0, maxBuffer - before)));
    failure = Object.assign(new RangeError(stream + ' maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    kill();
  };
  if (encoding) { child.stdout?.setEncoding(encoding); child.stderr?.setEncoding(encoding); }
  child.stdout?.on('data', (chunk: string | Buffer) => collect('stdout', chunk));
  child.stderr?.on('data', (chunk: string | Buffer) => collect('stderr', chunk));
  child.once('error', fail);
  child.once('close', finish);
  return child;
}

export function spawnSyncWithLinuxChildLaunch(command: string, args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnSyncWithLinuxChildLaunch(command: string, args: readonly string[],
  options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
export function spawnSyncWithLinuxChildLaunch(command: string, args: readonly string[],
  options: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  const entered = performance.now(), helper = selectedLinuxChildExecutable();
  if (helper === null) return spawnSync(command, args, options);
  const channels = stdio(options), target = invocation(command, args, options.argv0);
  const timeout = remaining(finiteDeadline(entered, options.timeout));
  const encoding = options.encoding && options.encoding !== 'buffer' ? options.encoding : null;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  if (maxBuffer !== Infinity && (!Number.isFinite(maxBuffer) || maxBuffer < 0)) throw linuxChildLaunchFailure('options');
  const result = spawnSync(helper, target, { ...options, argv0: helper, shell: false,
    stdio: channels, encoding: 'buffer',
    ...(typeof options.input === 'string' ? { input: Buffer.from(options.input, encoding ?? 'utf8') } : {}),
    // Protocol bytes are private; the original aggregate stdout/stderr allowance is checked below.
    maxBuffer: maxBuffer === Infinity || maxBuffer === 0 ? maxBuffer : maxBuffer + 12,
    ...(timeout === undefined ? {} : { timeout }) });
  if (!Array.isArray(result.output)) return result; // Preserve genuine pre-allocation spawnSync failure.
  const privateStatus = result.output[3];
  const statusFailure = Buffer.isBuffer(privateStatus) ? decodeFailure(privateStatus, command, target.slice(3)) :
    result.error ? null : linuxChildLaunchFailure('status', true);
  const publicOutput = result.output.slice(0, 3);
  const publicBytes = publicOutput.reduce((sum, bytes) => sum + (bytes?.length ?? 0), 0);
  // Node's synchronous maxBuffer=0 disables its cap; Infinity does too.
  const exceeded = maxBuffer > 0 && maxBuffer !== Infinity && publicBytes > maxBuffer;
  const overflow = exceeded ? Object.assign(new Error('spawnSync maxBuffer length exceeded'), {
    code: 'ENOBUFS', errno: -105, syscall: 'spawnSync', processOutcomeUnknown: true,
  }) : null;
  // A failed result exposes only a bounded original stdout/stderr prefix. The
  // private 12-byte status allowance never increases accepted public output.
  let available = maxBuffer;
  const output = publicOutput.map(bytes => {
    const bounded = exceeded && bytes ? bytes.subarray(0, Math.max(0, available)) : bytes;
    if (exceeded && bounded) available -= bounded.length;
    return bounded === null || !encoding ? bounded : bounded.toString(encoding);
  });
  const error = result.error ?? statusFailure ?? overflow;
  return { ...result, output, stdout: output[1]!, stderr: output[2]!, ...(error ? { error } : {}) };
}

/** Original MCP census collector; null never means process absence. */
export function execFileTextWithLinuxChildLaunch(
  command: string,
  args: string[],
  timeout: number,
  maxBuffer: number
): Promise<string | null> {
  return new Promise((resolve) => {
    execFileWithLinuxChildLaunch(
      command,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string | Buffer) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}
