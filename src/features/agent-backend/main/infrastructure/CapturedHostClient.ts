import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import {
  DEFAULT_HOST_LIMITS,
  HOST_GAP_METHOD,
  HOST_PROTOCOL_VERSION,
  type HostHandshake,
  type HostLimits,
  hostMethodFrameLimit,
  hostProfileLimitCaps,
  type JsonValue,
  resolveHostProfileLimits,
  type RpcNotification,
  type RpcRequest,
  TEAM_HOST_DISPOSE_TIMEOUT_MS,
} from '@agent-teams/legacy-agent-host/contracts';
import {
  HOST_CUSTODY_BIND_METHOD,
  HOST_CUSTODY_CAPABILITY,
  HOST_CUSTODY_FRAME_BYTES,
  HOST_CUSTODY_METHOD,
  HOST_CUSTODY_READY_METHOD,
  type HostCustodyBinding,
  hostCustodyBindingSchema,
  type HostCustodyCall,
  hostCustodyControl,
  type HostCustodyHint,
  hostCustodyHintSchema,
  type HostCustodyOwner,
  type HostCustodyPort,
  type HostCustodyReply,
  hostCustodyRequestSchema,
  hostCustodySequence,
  sameHostCustodyBinding,
  validateHostCustodyResult,
} from '@agent-teams/legacy-agent-host/owned-process';
import { createLogger } from '@shared/utils/logger';

import { decodeClaudeCloseDiagnostics } from './decodeClaudeCloseDiagnostics';
import {
  captureHostProfile,
  HostClientError,
  type SelectedHostProfile,
  validateHostProfile,
} from './selectedHostProfile';

let startupProbeCount = 0;
export const observeCapturedHostStartup = (
  phase:
    | 'profile-validation-start'
    | 'profile-validation-complete'
    | 'child-captured'
    | 'ready'
    | 'request-timeout'
    | 'request-admitted'
    | 'response-accepted'
    | 'owner-start'
    | 'owner-started'
    | 'read-start'
    | 'read-complete',
  kind: 'handshake' | 'rpc' | 'registry-list' | 'retirement-read' = 'handshake'
): void => {
  if (process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS !== '1' || startupProbeCount >= 128) return;
  startupProbeCount++;
  try {
    createLogger('TEST:HostStartup').diagnostic('Host startup observation', {
      phase,
      kind,
      observation: startupProbeCount,
      elapsedMs: Math.round(performance.now()),
    });
  } catch {
    /* Passive diagnostics cannot change transport outcomes. */
  }
};

interface PendingRequest {
  maxFrameBytes: number;
  resolve: (value: JsonValue) => void;
  reject: (error: HostClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CapturedHostShutdown {
  /** Only this captured child is observed; provider custody is never inferred. */
  childExit: 'confirmed' | 'unknown';
  providerCustody: 'unresolved';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Main-owned transport. A new instance requires an explicit composition decision. */
export class CapturedHostClient {
  readonly profile: SelectedHostProfile;
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<HostHandshake>;
  private shutdownPromise?: Promise<CapturedHostShutdown>;
  private sealed = false;
  private ready = false;
  private exited = false;
  private exitPromise?: Promise<void>;
  private limits: HostLimits = { ...DEFAULT_HOST_LIMITS };
  private pending = new Map<string, PendingRequest>();
  private frame = Buffer.alloc(0);
  private frameBytes = 0;
  private notifications: RpcNotification[] = [];
  private notificationBytes = 0;
  private notificationGap = false;
  private writeBytes = 0;
  private writeCount = 0;
  private writeTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly nativeAbort = new AbortController();
  private nativeBinding?: HostCustodyBinding;
  private nativePort?: HostCustodyPort;
  private nativeUnsubscribe?: () => void;
  // HostOutput preserves FIFO within each lane while control can overtake queued work.
  private readonly nativeHighWatermark = { work: 0n, control: 0n };
  private readonly nativePending = new Map<string, HostCustodyCall>();
  private readonly nativeHints = new Map<string, { hint: HostCustodyHint; sent: boolean }>();
  private diagnosticTail = Buffer.alloc(0);
  private readonly retainCloseDiagnostic = decodeClaudeCloseDiagnostics(
    (observation) => {
      createLogger('Host:ClaudeClose').diagnostic('Claude close stage', observation);
    },
    (observation) => {
      createLogger('Host:ClaudeManagement').diagnostic('Claude management stage', observation);
    },
    (observation) => {
      if (this.child?.pid !== undefined)
        createLogger('Host:OpenCodeMetadata').diagnostic('OpenCode metadata stage', {
          profileHash: observation.profileHash, mode: observation.mode,
          providerHash: observation.providerHash, pid: observation.pid,
          startIdentityHash: createHash('sha256').update(observation.startIdentity, 'utf8').digest('hex'),
          stage: observation.stage, hostPid: this.child.pid,
        });
    }
  );

  constructor(
    profile: SelectedHostProfile,
    private readonly nativeOwner?: HostCustodyOwner
  ) {
    this.profile = captureHostProfile(profile);
  }

  start(): Promise<HostHandshake> {
    if (this.sealed) return Promise.reject(new HostClientError('shutting-down', 'not-dispatched'));
    this.startPromise ??= this.open();
    return this.startPromise;
  }

  private async open(): Promise<HostHandshake> {
    try {
      observeCapturedHostStartup('profile-validation-start');
      await validateHostProfile(this.profile);
      observeCapturedHostStartup('profile-validation-complete');
      if (this.sealed) throw new HostClientError('shutting-down', 'not-dispatched');
      const child = spawn(this.profile.nodeExecutable, [this.profile.hostEntry], {
        cwd: this.profile.cwd,
        env: { ...this.profile.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      observeCapturedHostStartup('child-captured');
      this.exitPromise = new Promise<void>((resolve) => {
        child.once('close', () => {
          this.exited = true;
          this.fail(new HostClientError('transport-closed', 'unknown'));
          resolve();
        });
      });
      child.once('error', () => this.fail(new HostClientError('transport-closed', 'unknown')));
      child.stdin.on('error', () => this.fail(new HostClientError('transport-closed', 'unknown')));
      child.stdout.on('error', () => this.fail(new HostClientError('transport-closed', 'unknown')));
      child.stdout.on('data', (chunk: Buffer) => this.decode(chunk));
      child.stdout.once('end', () => this.fail(new HostClientError('transport-closed', 'unknown')));
      child.stderr.on('error', () => {
        /* Diagnostics never determine command outcomes. */
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Kept private, bounded, and deliberately excluded from exceptions/public DTOs.
        this.diagnosticTail = Buffer.concat([this.diagnosticTail, chunk]).subarray(-8192);
        this.retainCloseDiagnostic(chunk);
      });
      const result = await this.send(
        'host.handshake',
        { protocolVersion: HOST_PROTOCOL_VERSION },
        true,
        this.profile.startupTimeoutMs
      );
      const handshake = this.validateHandshake(result);
      if (this.nativeOwner) await this.bindNative(handshake);
      if (this.sealed) throw new HostClientError('shutting-down', 'not-dispatched');
      this.ready = true;
      observeCapturedHostStartup('ready');
      return handshake;
    } catch (error) {
      const safe =
        error instanceof HostClientError ? error : new HostClientError('protocol-error', 'unknown');
      this.fail(safe);
      throw safe;
    }
  }

  private validateHandshake(result: JsonValue): HostHandshake {
    if (
      !isRecord(result) ||
      result.protocolVersion !== HOST_PROTOCOL_VERSION ||
      result.buildId !== this.profile.expectedBuildId ||
      typeof result.hostIncarnation !== 'string' ||
      !result.hostIncarnation ||
      !Array.isArray(result.capabilities) ||
      !result.capabilities.every((value) => typeof value === 'string') ||
      !result.capabilities.includes('transport.ndjson') ||
      !isRecord(result.limits)
    ) {
      throw new HostClientError('profile-mismatch', 'unknown');
    }
    try {
      const candidate = result.limits;
      if (this.profile.reviewTransport && !result.capabilities.includes('transport.review-v1'))
        throw new Error('capability');
      for (const [key, cap] of Object.entries(hostProfileLimitCaps(this.profile.reviewTransport))) {
        const maximum = key === 'disposeTimeoutMs' ? TEAM_HOST_DISPOSE_TIMEOUT_MS : cap;
        if (typeof candidate[key] !== 'number' || candidate[key] > maximum)
          throw new Error('limit');
      }
      this.limits = resolveHostProfileLimits(
        this.profile.reviewTransport,
        candidate as unknown as HostLimits
      );
    } catch {
      throw new HostClientError('protocol-error', 'unknown');
    }
    return result as unknown as HostHandshake;
  }

  request(
    method: string,
    params?: JsonValue,
    options: { control?: boolean } = {}
  ): Promise<JsonValue> {
    if (method.startsWith(HOST_CUSTODY_METHOD))
      return Promise.reject(new HostClientError('protocol-error', 'not-dispatched'));
    if (!this.ready || this.sealed) {
      return Promise.reject(
        new HostClientError(this.sealed ? 'shutting-down' : 'transport-closed', 'not-dispatched')
      );
    }
    return this.send(method, params, options.control ?? false, this.profile.requestTimeoutMs);
  }

  private send(
    method: string,
    params: JsonValue | undefined,
    control: boolean,
    timeoutMs: number
  ): Promise<JsonValue> {
    const child = this.child;
    if (this.sealed || !child || this.exited || child.stdin.destroyed) {
      return Promise.reject(new HostClientError('transport-closed', 'not-dispatched'));
    }
    const capacity = control
      ? this.limits.maxPendingRequests
      : this.limits.maxPendingRequests - this.limits.reservedControlRequests;
    if (this.pending.size >= capacity)
      return Promise.reject(new HostClientError('capacity-exceeded', 'not-dispatched'));
    const id = randomUUID();
    let frame: Buffer;
    try {
      if (!method || (method === 'host.handshake' && this.ready)) throw new Error('method');
      const request: RpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      };
      frame = Buffer.from(`${JSON.stringify(request)}\n`);
      if (
        frame.length - 1 >
        Math.min(
          this.limits.maxFrameBytes,
          hostMethodFrameLimit(method, this.profile.reviewTransport)
        )
      )
        throw new Error('frame');
    } catch {
      return Promise.reject(new HostClientError('protocol-error', 'not-dispatched'));
    }
    if (!this.canWrite(frame.length, control)) {
      return Promise.reject(new HostClientError('capacity-exceeded', 'not-dispatched'));
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        observeCapturedHostStartup(
          'request-timeout',
          method === 'host.handshake' ? 'handshake' : 'rpc'
        );
        reject(new HostClientError('request-timeout', 'unknown'));
      }, timeoutMs);
      observeCapturedHostStartup(
        'request-admitted',
        method === 'host.handshake' ? 'handshake' : 'rpc'
      );
      this.pending.set(id, {
        resolve: (value) => {
          observeCapturedHostStartup(
            'response-accepted',
            method === 'host.handshake' ? 'handshake' : 'rpc'
          );
          resolve(value);
        },
        reject,
        timer,
        maxFrameBytes: hostMethodFrameLimit(method, this.profile.reviewTransport),
      });
      if (!this.writeFrame(frame, control))
        this.fail(new HostClientError('transport-closed', 'unknown'));
    });
  }

  private canWrite(bytes: number, control: boolean): boolean {
    const count =
      this.limits.maxPriorityMessages - (control ? 0 : this.limits.reservedControlRequests);
    const budget = this.limits.maxPriorityBytes - (control ? 0 : this.limits.maxFrameBytes);
    // Reserve each admitted reverse reply before the owner can consume bytes or perform an effect.
    return (
      this.writeCount + this.nativePending.size < count &&
      this.writeBytes + this.nativePending.size * (HOST_CUSTODY_FRAME_BYTES + 1) + bytes <= budget
    );
  }

  private writeFrame(frame: Buffer, control: boolean): boolean {
    const child = this.child;
    if (
      this.sealed ||
      !child ||
      this.exited ||
      child.stdin.destroyed ||
      !this.canWrite(frame.length, control)
    )
      return false;
    this.writeBytes += frame.length;
    this.writeCount++;
    let completed = false;
    const timer = setTimeout(
      () => this.fail(new HostClientError('transport-closed', 'unknown')),
      this.profile.writeTimeoutMs
    );
    this.writeTimers.add(timer);
    const finish = (error?: Error | null) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      this.writeTimers.delete(timer);
      this.writeBytes -= frame.length;
      this.writeCount--;
      if (error) this.fail(new HostClientError('transport-closed', 'unknown'));
      else this.pumpNativeHints();
    };
    try {
      child.stdin.write(frame, finish);
    } catch {
      finish(new Error('Captured Host write failed'));
      return false;
    }
    return true;
  }

  private async bindNative(handshake: HostHandshake): Promise<void> {
    const owner = this.nativeOwner;
    if (!owner || !this.exitPromise || !handshake.capabilities.includes(HOST_CUSTODY_CAPABILITY))
      throw new HostClientError('profile-mismatch', 'unknown');
    const {
      env,
      startupTimeoutMs: _startup,
      requestTimeoutMs: _request,
      writeTimeoutMs: _write,
      shutdownTimeoutMs: _shutdown,
      ...source
    } = this.profile;
    const profileDigest = createHash('sha256')
      .update(
        JSON.stringify({
          ...source,
          env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
        })
      )
      .digest('hex');
    const binding = hostCustodyBindingSchema.parse({
      mainEpoch: owner.mainEpoch,
      hostIncarnation: handshake.hostIncarnation,
      profileDigest,
    });
    this.nativeBinding = Object.freeze(binding);
    this.nativePort = owner.attach({
      binding,
      profileId: this.profile.profileId,
      signal: this.nativeAbort.signal,
      hostExited: this.exitPromise,
    });
    const ack = await this.send(
      HOST_CUSTODY_BIND_METHOD,
      binding,
      true,
      this.profile.startupTimeoutMs
    );
    if (!isRecord(ack) || ack.bound !== true || this.sealed)
      throw new HostClientError('profile-mismatch', 'unknown');
    this.nativeUnsubscribe = this.nativePort.onReadable((hint) => this.queueNativeHint(hint));
  }

  private queueNativeHint(value: HostCustodyHint): void {
    if (this.sealed) return;
    const parsed = hostCustodyHintSchema.safeParse(value);
    if (!parsed.success) {
      this.fail(new HostClientError('protocol-error', 'unknown'));
      return;
    }
    const hint = parsed.data;
    const key = `${hint.capability}:${hint.stream}`;
    const previous = this.nativeHints.get(key);
    if (!previous) {
      if (this.nativeHints.size >= this.limits.maxPendingRequests) {
        this.fail(new HostClientError('capacity-exceeded', 'unknown'));
        return;
      }
    }
    this.nativeHints.set(key, { hint, sent: previous?.sent ?? false });
    this.pumpNativeHints();
  }

  private pumpNativeHints(): void {
    if (this.sealed || !this.nativeBinding) return;
    for (const hint of this.nativeHints.values()) {
      if (hint.sent) continue;
      const frame = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: HOST_CUSTODY_READY_METHOD,
          params: { binding: this.nativeBinding, hint: hint.hint },
        }) + '\n'
      );
      if (!this.canWrite(frame.length, false)) return;
      hint.sent = true;
      if (!this.writeFrame(frame, false)) {
        this.fail(new HostClientError('transport-closed', 'unknown'));
        return;
      }
    }
  }

  private receiveNative(value: unknown, frameBytes: number): void {
    const parsed = hostCustodyRequestSchema.safeParse(value);
    const binding = this.nativeBinding,
      port = this.nativePort;
    if (
      !parsed.success ||
      frameBytes > HOST_CUSTODY_FRAME_BYTES ||
      !binding ||
      !port ||
      !sameHostCustodyBinding(parsed.data.params.binding, binding)
    )
      throw new Error('Native request');
    const {
      id,
      params: { call },
    } = parsed.data;
    const control = hostCustodyControl(call);
    const sequence = hostCustodySequence(id, binding.hostIncarnation, control);
    if (sequence === undefined) throw new Error('Native request ID');
    const lane = control ? 'control' : 'work';
    if (sequence <= this.nativeHighWatermark[lane]) {
      this.replyNative(id, { status: 'unknown' });
      return;
    }
    this.nativeHighWatermark[lane] = sequence;
    const capacity =
      this.limits.maxPendingRequests - (control ? 0 : this.limits.reservedControlRequests);
    if (
      this.nativePending.size >= capacity ||
      !this.canWrite(HOST_CUSTODY_FRAME_BYTES + 1, control) ||
      (call.operation === 'read' &&
        [...this.nativePending.values()].some(
          (other) =>
            other.operation === 'read' &&
            other.capability === call.capability &&
            other.stream === call.stream
        ))
    ) {
      this.replyNative(id, { status: 'refused' });
      return;
    }
    this.nativePending.set(id, call);
    void this.executeNative(id, call, port);
  }

  private async executeNative(
    id: string,
    call: HostCustodyCall,
    port: HostCustodyPort
  ): Promise<void> {
    const hintKey = call.operation === 'read' ? `${call.capability}:${call.stream}` : undefined;
    const admittedHint = hintKey ? this.nativeHints.get(hintKey) : undefined;
    let reply: HostCustodyReply;
    try {
      reply = {
        status: 'completed',
        value: validateHostCustodyResult(call, await port.handle(call)),
      };
    } catch {
      reply = { status: 'unknown' };
    }
    if (this.sealed || !this.nativePending.delete(id)) return;
    const read =
      reply.status === 'completed' && reply.value.operation === 'read' ? reply.value : undefined;
    if (hintKey && read) {
      const current = this.nativeHints.get(hintKey);
      if (current === admittedHint) this.nativeHints.delete(hintKey);
      else if (current) current.sent = false; // New readiness must follow this read's reply.
    }
    this.replyNative(id, reply);
    if (call.operation === 'read' && read?.more)
      this.queueNativeHint({ capability: call.capability, stream: call.stream });
    this.pumpNativeHints();
  }

  private replyNative(id: string, reply: HostCustodyReply): void {
    const frame = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id, result: { binding: this.nativeBinding, reply } }) + '\n'
    );
    // Exchange already-reserved reply bytes; completion is not a new work admission.
    if (frame.length - 1 > HOST_CUSTODY_FRAME_BYTES || !this.writeFrame(frame, true))
      this.fail(new HostClientError('transport-closed', 'unknown'));
  }

  private sealNative(): void {
    this.nativeAbort.abort();
    const unsubscribe = this.nativeUnsubscribe;
    this.nativeUnsubscribe = undefined;
    this.nativePending.clear();
    this.nativeHints.clear();
    try {
      unsubscribe?.();
    } catch {
      /* Transport failure retains the independent physical owner. */
    }
    // The caller-owned physical port/receipts remain outside this transport's lifetime.
  }

  private decode(chunk: Buffer): void {
    if (this.sealed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      const required = this.frameBytes + part.length;
      if (required > this.limits.maxFrameBytes) {
        this.fail(new HostClientError('protocol-error', 'unknown'));
        return;
      }
      if (required > this.frame.length) {
        const capacity = Math.min(
          this.limits.maxFrameBytes,
          Math.max(required, this.frame.length * 2)
        );
        const grown = Buffer.allocUnsafe(capacity);
        this.frame.copy(grown, 0, 0, this.frameBytes);
        this.frame = grown;
      }
      part.copy(this.frame, this.frameBytes);
      this.frameBytes = required;
      if (newline < 0) return;
      const frame = this.frame.subarray(0, this.frameBytes);
      this.frame = Buffer.alloc(0);
      this.frameBytes = 0;
      if (!this.receive(frame)) return;
      offset = end + 1;
    }
  }

  private receive(frame: Buffer): boolean {
    try {
      const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
      if (!isRecord(message) || message.jsonrpc !== '2.0') throw new Error('envelope');
      if (typeof message.method === 'string' && message.method.startsWith(HOST_CUSTODY_METHOD)) {
        this.receiveNative(message, frame.length);
        return true;
      }
      if ('id' in message) {
        if (typeof message.id !== 'string' || 'result' in message === 'error' in message)
          throw new Error('response');
        if (
          'error' in message &&
          (!isRecord(message.error) ||
            !Number.isSafeInteger(message.error.code) ||
            typeof message.error.message !== 'string')
        )
          throw new Error('error');
        const pending = this.pending.get(message.id);
        if (!pending) return true; // Late response to a timed-out original request cannot create a new intent.
        if (frame.length > pending.maxFrameBytes) throw new Error('method response frame');
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if ('error' in message) {
          // Only transport-owned codes establish rejection before handler admission.
          // A handler exception may follow a partial effect and must remain unknown.
          const code = (message.error as { code: number }).code;
          const rejected = [-32001, -32002, -32601, -32602].includes(code);
          pending.reject(
            new HostClientError(
              rejected ? 'remote-rejected' : 'remote-error',
              rejected ? 'rejected' : 'unknown'
            )
          );
        } else pending.resolve(message.result as JsonValue);
      } else {
        if (typeof message.method !== 'string' || !('params' in message))
          throw new Error('notification');
        if (message.method === HOST_GAP_METHOD) this.notificationGap = true;
        else if (
          this.notifications.length >= this.limits.maxDataNotifications ||
          this.notificationBytes + frame.length > this.limits.maxDataBytes
        ) {
          this.notifications = [];
          this.notificationBytes = 0;
          this.notificationGap = true;
        } else {
          this.notifications.push(message as unknown as RpcNotification);
          this.notificationBytes += frame.length;
        }
      }
      return true;
    } catch {
      this.fail(new HostClientError('protocol-error', 'unknown'));
      return false;
    }
  }

  /** Pulling keeps slow UI work out of provider response/control processing. */
  takeNotifications(): { notifications: RpcNotification[]; gap: boolean } {
    const result = { notifications: this.notifications, gap: this.notificationGap };
    this.notifications = [];
    this.notificationBytes = 0;
    this.notificationGap = false;
    return result;
  }

  private fail(error: HostClientError): void {
    this.sealed = true;
    this.sealNative();
    this.ready = false;
    this.frame = Buffer.alloc(0);
    this.frameBytes = 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const timer of this.writeTimers) clearTimeout(timer);
    this.writeTimers.clear();
    // Scope is exactly the ChildProcess object captured by this instance, never a persisted PID.
    if (this.child && !this.exited) this.child.stdin.end();
    void this.shutdown();
  }

  shutdown(): Promise<CapturedHostShutdown> {
    this.sealed = true; // Synchronous fence prevents late validation/startup from allocating.
    this.sealNative();
    this.ready = false;
    this.shutdownPromise ??= this.dispose();
    return this.shutdownPromise;
  }

  private async waitForExit(timeoutMs = this.profile.shutdownTimeoutMs): Promise<boolean> {
    if (!this.child || this.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return this.exited;
  }

  private async dispose(): Promise<CapturedHostShutdown> {
    for (const timer of this.writeTimers) clearTimeout(timer);
    this.writeTimers.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HostClientError('shutting-down', 'unknown'));
    }
    this.pending.clear();
    const child = this.child;
    if (child && !this.exited) {
      child.stdin.end();
      // Enclose the captured Host's advertised finite disposal budget before escalating.
      const gracefulTimeoutMs = Math.max(
        this.profile.shutdownTimeoutMs,
        this.limits.disposeTimeoutMs + 1000
      );
      if (!(await this.waitForExit(gracefulTimeoutMs))) {
        child.kill('SIGTERM');
        if (!(await this.waitForExit())) {
          child.kill('SIGKILL');
          await this.waitForExit();
        }
      }
    }
    return {
      childExit: !this.child || this.exited ? 'confirmed' : 'unknown',
      providerCustody: 'unresolved',
    };
  }
}
