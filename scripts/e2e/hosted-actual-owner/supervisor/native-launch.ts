import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, fstatSync, openSync, constants, type BigIntStats } from 'node:fs';
import { Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';

import type { BootstrapFrames } from './bootstrap-v2';
import { decodeDelivery, decodeExecuted, decodeExit, decodeFailure, decodeHeld, decodeSealed,
  nativeMessage, NATIVE_COMMAND, NATIVE_EVENT, NATIVE_MAGIC, u32,
  type Delivery, type ExecutedOwner, type HeldOwner, type NativeDescriptor, type OwnerExit, type SealedLease } from './native-protocol';

export interface InheritedImage {
  readonly fd: number;
  readonly pin: Readonly<{ device: string; inode: string; size: number; mode: number; sha256: string }>;
}
export interface NativeLaunchOptions {
  /** Borrowed until launch settles. Both images are already selected by descriptor admission. */
  readonly helper: InheritedImage;
  readonly executable: InheritedImage;
  readonly cwdFd: number;
  /** Ownership TRANSFERS on entry after distinct-number validation, including on failure. */
  readonly rawFd: number;
  readonly walFd: number;
  /** Includes argv[0]. Source execution uses the Bun image and its admitted module argv separately. */
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Helper-local input slots, for inherited-map integration; 255 is the helper's exec anchor. */
  readonly sourceSlots?: readonly [number, number, number, number, number, number];
  /** Receives the real stopped child, never a proposed PID. Returned buffers transfer to this call. */
  readonly assemble: (held: HeldOwner) => BootstrapFrames | Promise<BootstrapFrames>;
}
export interface NativeEventRecord { readonly type: number; readonly bodyBase64: string }
export class OwnerLaunchError extends Error {
  constructor(message: string, readonly nativeEvents: readonly NativeEventRecord[], options?: ErrorOptions) {
    super(message, options); this.name = 'OwnerLaunchError';
  }
}
/** Owns a Node socket object, never closes a possibly reused numeric descriptor. */
export class OwnedEndpoint {
  private owned: Socket | undefined;
  constructor(socket: Socket) { this.owned = socket; }
  take(): Socket {
    if (!this.owned) throw new Error('owner_endpoint_already_transferred');
    const socket = this.owned; this.owned = undefined; return socket;
  }
  close(): void { this.owned?.destroy(); this.owned = undefined; }
}
export interface NativeOwnerLaunch {
  readonly held: HeldOwner;
  readonly sealed: SealedLease;
  readonly executed: ExecutedOwner & { readonly executableSha256: string };
  readonly delivery: Delivery;
  /** take() transfers once. Receiver must close it, including if Product admission fails. */
  readonly activation: OwnedEndpoint;
  readonly liveness: OwnedEndpoint;
  readonly exit: Promise<OwnerExit>;
  readonly nativeEvents: () => readonly NativeEventRecord[];
  /** Cancels only this helper's exact unreaped child and closes endpoints still owned here. */
  dispose(): Promise<void>;
}
function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`owner_launch_${reason}`);
}
function stable(s: BigIntStats): string {
  return [s.dev, s.ino, s.size, s.mode, s.nlink, s.uid, s.gid, s.mtimeNs, s.ctimeNs].join(':');
}
function matchesDescriptor(s: BigIntStats, d: NativeDescriptor): boolean {
  return s.dev.toString() === d.device && s.ino.toString() === d.inode && s.size.toString() === d.size &&
    Number(s.mode & 0o7777n) === d.mode && s.uid === BigInt(d.uid) && s.gid === BigInt(d.gid) &&
    String(s.nlink) === d.nlink && String(s.mtimeNs) === d.mtimeNs && String(s.ctimeNs) === d.ctimeNs;
}
async function hashImage(image: InheritedImage, signal?: AbortSignal): Promise<BigIntStats> {
  signal?.throwIfAborted();
  const before = fstatSync(image.fd, { bigint: true }), pin = image.pin;
  requireValue(before.isFile() && before.nlink === 1n && before.uid === BigInt(process.getuid!()) &&
    before.gid === BigInt(process.getgid!()) && (before.mode & 0o7777n) === 0o500n && pin.mode === 0o500 &&
    Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= 1024 ** 3 && before.size === BigInt(pin.size) &&
    String(before.dev) === pin.device && String(before.ino) === pin.inode && /^[0-9a-f]{64}$/u.test(pin.sha256), 'image_pin');
  const hash = createHash('sha256');
  const stream = createReadStream('', { fd: image.fd, autoClose: false, start: 0, end: pin.size - 1,
    highWaterMark: 64 * 1024, signal });
  let count = 0;
  for await (const part of stream) { count += (part as Buffer).length; hash.update(part as Buffer); }
  requireValue(count === pin.size && hash.digest('hex') === pin.sha256 &&
    stable(before) === stable(fstatSync(image.fd, { bigint: true })), 'image_changed');
  return before;
}
function closeAndObserve(fd: number): void {
  closeSync(fd);
  // Intentionally adjacent. The snapshot is retained; this numeric slot is never inspected again.
  try { fstatSync(fd); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EBADF') return;
    throw error;
  }
  throw new Error('owner_launch_parent_copy_open');
}
function encodeStrings(values: readonly string[]): Buffer {
  requireValue(values.length <= 32, 'string_count');
  const parts = [u32(values.length)];
  for (const value of values) {
    requireValue(typeof value === 'string' && !value.includes('\0') && Buffer.from(value).toString('utf8') === value, 'argument');
    const b = Buffer.from(value); requireValue(b.length > 0 && b.length <= 8192, 'argument_length');
    parts.push(u32(b.length), b);
  }
  return Buffer.concat(parts);
}
function ownerEnvironment(environment: Readonly<Record<string, string>>): string[] {
  // No ambient credentials, runtime injection flags, PATH, loader, or shell variables.
  const allowed = new Set(['NODE_ENV', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
    'XDG_STATE_HOME', 'TMPDIR', 'P3C_PROCESS_OWNERSHIP_MARKER', 'CLAUDE_TEAM_PRODUCER_PROVENANCE_V2']);
  return Object.entries(environment).map(([key, value]) => {
    requireValue(allowed.has(key) && typeof value === 'string' && (key !== 'NODE_ENV' || value === 'development'), 'environment');
    return `${key}=${value}`;
  });
}
class NativeChannel {
  readonly records: NativeEventRecord[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private queue: { type: number; body: Buffer }[] = [];
  private waiting: { resolve: (v: { type: number; body: Buffer }) => void; reject: (e: Error) => void } | undefined;
  private failure: Error | undefined;
  private total = 0;
  constructor(readable: Readable, helper: ChildProcess) {
    readable.on('data', (chunk: Buffer) => {
      try {
        this.total += chunk.length; requireValue(this.total <= 16384, 'native_output_bound');
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 12) {
          requireValue(this.buffer.readUInt32BE(0) === NATIVE_MAGIC, 'native_version');
          const type = this.buffer.readUInt32BE(4), len = this.buffer.readUInt32BE(8);
          requireValue(len <= 4096, 'native_record_bound');
          if (this.buffer.length < 12 + len) break;
          const body = Buffer.from(this.buffer.subarray(12, 12 + len));
          this.buffer = this.buffer.subarray(12 + len);
          this.records.push(Object.freeze({ type, bodyBase64: body.toString('base64') }));
          const event = { type, body }, waiting = this.waiting; this.waiting = undefined;
          if (waiting) waiting.resolve(event); else this.queue.push(event);
        }
      } catch (error) { this.stop(error as Error); }
    });
    readable.on('end', () => this.stop(new Error('owner_launch_native_eof')));
    readable.on('error', error => this.stop(error));
    helper.on('error', error => this.stop(error));
  }
  stop(error: Error): void { this.failure ??= error; this.waiting?.reject(error); this.waiting = undefined; }
  async next(type: number): Promise<Buffer> {
    let event = this.queue.shift();
    if (!event) {
      if (this.failure) throw this.failure;
      requireValue(!this.waiting, 'concurrent_protocol_read');
      event = await new Promise<{ type: number; body: Buffer }>((resolve, reject) => { this.waiting = { resolve, reject }; });
    }
    if (event.type === NATIVE_EVENT.failed) {
      const failure = decodeFailure(event.body);
      throw new OwnerLaunchError(`owner_native_phase_${failure.phase}_errno_${failure.errno}`, [...this.records]);
    }
    requireValue(event.type === type, 'native_event_order'); return event.body;
  }
}
function writeMessage(stream: Writable, type: number, body?: Buffer): Promise<void> {
  const packet = nativeMessage(type, body);
  return new Promise<void>((resolve, reject) => {
    stream.write(packet, error => { packet.fill(0); if (error) reject(error); else resolve(); });
  });
}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('owner_launch_cleanup_deadline')), ms);
  })]); } finally { clearTimeout(timer); }
}

/** A usable descriptor-only Linux caller; namespace/profile/OpenCode admission belongs above it. */
export async function launchNativeOwner(options: NativeLaunchOptions): Promise<NativeOwnerLaunch> {
  requireValue(process.platform === 'linux', 'linux_required');
  const numbers = [options.helper.fd, options.executable.fd, options.cwdFd, options.rawFd, options.walFd];
  requireValue(numbers.every(fd => Number.isSafeInteger(fd) && fd >= 3) && new Set(numbers).size === 5, 'distinct_owned_handles');
  const ownedWriters = new Set([options.rawFd, options.walFd]);
  let helper: ChildProcess | undefined, channel: NativeChannel | undefined, control: Writable | undefined;
  let activation: OwnedEndpoint | undefined, liveness: OwnedEndpoint | undefined;
  let closed: Promise<void> | undefined, startupTimer: NodeJS.Timeout | undefined;
  let frames: BootstrapFrames | undefined, transfer: Buffer | undefined;
  const startup = new AbortController();
  const closeWriters = () => { for (const fd of ownedWriters) { ownedWriters.delete(fd); closeAndObserve(fd); } };
  const revoke = () => {
    startup.abort(new Error('owner_launch_canceled_or_deadline'));
    channel?.stop(new Error('owner_launch_canceled_or_deadline'));
    control?.destroy(); activation?.close(); liveness?.close();
  };
  const onAbort = () => revoke(); options.signal?.addEventListener('abort', onAbort, { once: true });
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposing ??= (async () => {
    clearTimeout(startupTimer); options.signal?.removeEventListener('abort', onAbort);
    control?.destroy(); activation?.close(); liveness?.close();
    if (closed) {
      try { await bounded(closed, 2500); }
      catch (error) {
        // Never signal the Owner PID. This ChildProcess is our own helper; PDEATHSIG protects its child.
        if (helper && helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
        await bounded(closed, 1000);
        throw error;
      }
    }
    const terminal = channel?.records.at(-1);
    if (terminal?.type === NATIVE_EVENT.exited) requireValue(decodeExit(Buffer.from(terminal.bodyBase64, 'base64')).reaped, 'cleanup_unreaped');
    else if (terminal?.type === NATIVE_EVENT.failed) {
      const failure = decodeFailure(Buffer.from(terminal.bodyBase64, 'base64'));
      requireValue(failure.ownerPid === 0 || failure.reaped, 'cleanup_unreaped');
    } else if (helper?.pid) throw new Error('owner_launch_cleanup_observation_missing');
  })();
  try {
    options.signal?.throwIfAborted();
    const [helperStat, imageStat] = await Promise.all([hashImage(options.helper, options.signal), hashImage(options.executable, options.signal)]);
    const rawStat = fstatSync(options.rawFd, { bigint: true }), walStat = fstatSync(options.walFd, { bigint: true });
    requireValue(fstatSync(options.cwdFd).isDirectory(), 'cwd_descriptor');
    const slots = options.sourceSlots ?? [3, 4, 5, 6, 7, 8];
    requireValue(slots.length === 6 && new Set(slots).size === 6 && slots.every(n => Number.isInteger(n) && n >= 3 && n <= 254), 'source_slots');
    requireValue(options.argv.length > 0, 'argv');
    const init = Buffer.concat([...slots.map(u32), encodeStrings(options.argv), encodeStrings(ownerEnvironment(options.environment))]);
    requireValue(init.length <= 32768 && stable(helperStat) === stable(fstatSync(options.helper.fd, { bigint: true })), 'init_or_helper_changed');
    const stdio: StdioOptions = Array.from({ length: 256 }, () => 'ignore' as const);
    stdio[0] = 'pipe'; stdio[1] = 'pipe'; stdio[2] = 'ignore';
    stdio[slots[0]] = 'pipe'; stdio[slots[1]] = 'pipe';
    stdio[slots[2]] = options.rawFd; stdio[slots[3]] = options.walFd;
    stdio[slots[4]] = options.executable.fd; stdio[slots[5]] = options.cwdFd; stdio[255] = options.helper.fd;
    startup.signal.throwIfAborted(); options.signal?.throwIfAborted();
    startupTimer = setTimeout(revoke, 5000);
    helper = spawn('/proc/self/fd/255', [], { shell: false, env: {}, stdio });
    closed = new Promise(resolve => helper!.once('close', () => resolve()));
    control = helper.stdin!; requireValue(control && helper.stdout, 'native_control_streams');
    control.on('error', () => undefined);
    channel = new NativeChannel(helper.stdout, helper);
    const act = helper.stdio[slots[0]], live = helper.stdio[slots[1]];
    if (!(act instanceof Socket && live instanceof Socket)) {
      act?.destroy(); live?.destroy(); throw new Error('owner_launch_socketpair_stdio_required');
    }
    act.on('error', () => undefined); live.on('error', () => undefined);
    activation = new OwnedEndpoint(act); liveness = new OwnedEndpoint(live);
    closeWriters(); // libuv has already duplicated them. No writer retained in this TS process.
    await writeMessage(control, NATIVE_COMMAND.init, init); init.fill(0);
    const held = decodeHeld(await channel.next(NATIVE_EVENT.held));
    requireValue(held.parentPid === helper.pid && held.callerPid === process.pid &&
      matchesDescriptor(imageStat, held.descriptors[7]) && matchesDescriptor(rawStat, held.descriptors[5]) &&
      matchesDescriptor(walStat, held.descriptors[6]), 'held_inherited_handles');
    startup.signal.throwIfAborted();
    // Cancellation also interrupts a slow assembler; the native deadline remains independent of JS timers.
    const assembling = Promise.resolve(options.assemble(held)).then(value => {
      if (startup.signal.aborted) {
        value.leaseBytes.fill(0); value.bootstrapFrame.fill(0); value.authFrame.fill(0);
        startup.signal.throwIfAborted();
      }
      return value;
    });
    frames = await Promise.race([assembling, new Promise<never>((_, reject) => {
      startup.signal.addEventListener('abort', () => reject(startup.signal.reason), { once: true });
    })]);
    const { leaseBytes, bootstrapFrame, authFrame } = frames;
    requireValue(leaseBytes.length > 0 && leaseBytes.length <= 65536 && bootstrapFrame.length >= 70 &&
      bootstrapFrame.length <= 65604 && authFrame.length >= 6 && authFrame.length <= 8196, 'frame_bound');
    transfer = Buffer.concat([u32(leaseBytes.length), u32(bootstrapFrame.length), u32(authFrame.length), leaseBytes, bootstrapFrame, authFrame]);
    await writeMessage(control, NATIVE_COMMAND.assembled, transfer); transfer.fill(0);
    const sealed = decodeSealed(await channel.next(NATIVE_EVENT.sealed)), lease = held.descriptors[0];
    requireValue(sealed.construction.seals === 15 && sealed.construction.size === String(leaseBytes.length) &&
      sealed.construction.device === lease.device && sealed.construction.inode === lease.inode &&
      sealed.construction.mode === 0o600 && lease.accessMode === 'read-only' &&
      BigInt(sealed.constructionClosedMonotonicNs) <= BigInt(sealed.observedMonotonicNs), 'actual_seals');
    const executed = decodeExecuted(await channel.next(NATIVE_EVENT.exec));
    requireValue(executed.ownerPid === held.ownerPid && executed.ownerStartTicks === held.ownerStartTicks &&
      BigInt(executed.observedMonotonicNs) > BigInt(sealed.observedMonotonicNs) &&
      matchesDescriptor(imageStat, executed.executable), 'actual_exec_identity');
    // Observation only. Execution itself used execveat(FD11), never this proc link or the admitted path.
    const observedFd = openSync(`/proc/${held.ownerPid}/exe`, constants.O_RDONLY);
    try {
      const actual = await hashImage({ fd: observedFd, pin: options.executable.pin }, startup.signal);
      requireValue(matchesDescriptor(actual, executed.executable), 'post_exec_digest');
    } finally { closeSync(observedFd); }
    startup.signal.throwIfAborted();
    await writeMessage(control, NATIVE_COMMAND.execAck);
    const delivery = decodeDelivery(await channel.next(NATIVE_EVENT.delivered));
    requireValue(delivery.bootstrapBytes === bootstrapFrame.length && delivery.authBytes === authFrame.length, 'delivery_counts');
    clearTimeout(startupTimer);
    const exit = channel.next(NATIVE_EVENT.exited).then(bytes => {
      const observed = decodeExit(bytes);
      requireValue(observed.ownerPid === held.ownerPid && observed.reaped, 'exit_identity'); return observed;
    });
    void exit.catch(() => undefined);
    const retainedChannel = channel;
    return Object.freeze({ held, sealed, executed: Object.freeze({ ...executed, executableSha256: options.executable.pin.sha256 }),
      delivery, activation, liveness, exit, nativeEvents: () => Object.freeze([...retainedChannel.records]), dispose });
  } catch (cause) {
    let cleanupFailure: unknown;
    try { await dispose(); } catch (error) { cleanupFailure = error; }
    throw new OwnerLaunchError(cleanupFailure ? 'owner_launch_failed_cleanup_incomplete' : 'owner_launch_failed',
      Object.freeze([...(channel?.records ?? [])]), { cause: cleanupFailure ? new AggregateError([cause, cleanupFailure]) : cause });
  } finally {
    closeWriters(); transfer?.fill(0);
    frames?.leaseBytes.fill(0); frames?.bootstrapFrame.fill(0); frames?.authFrame.fill(0);
  }
}
