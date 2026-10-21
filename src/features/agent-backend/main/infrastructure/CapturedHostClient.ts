import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import {
  DEFAULT_HOST_LIMITS,
  HOST_GAP_METHOD,
  HOST_PROTOCOL_VERSION,
  type HostHandshake,
  type HostLimits,
  type JsonValue,
  resolveHostLimits,
  type RpcNotification,
  type RpcRequest,
} from '@agent-teams/legacy-agent-host/contracts';

import {
  captureHostProfile,
  HostClientError,
  type SelectedHostProfile,
  validateHostProfile,
} from './selectedHostProfile';

interface PendingRequest {
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
  private notifications: RpcNotification[] = [];
  private notificationBytes = 0;
  private notificationGap = false;
  private writeBytes = 0;
  private writeCount = 0;
  private writeTimers = new Set<ReturnType<typeof setTimeout>>();
  private diagnosticTail = Buffer.alloc(0);

  constructor(profile: SelectedHostProfile) {
    this.profile = captureHostProfile(profile);
  }

  start(): Promise<HostHandshake> {
    if (this.sealed) return Promise.reject(new HostClientError('shutting-down', 'not-dispatched'));
    this.startPromise ??= this.open();
    return this.startPromise;
  }

  private async open(): Promise<HostHandshake> {
    try {
      await validateHostProfile(this.profile);
      if (this.sealed) throw new HostClientError('shutting-down', 'not-dispatched');
      const child = spawn(this.profile.nodeExecutable, [this.profile.hostEntry], {
        cwd: this.profile.cwd,
        env: { ...this.profile.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
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
      });
      const result = await this.send(
        'host.handshake',
        { protocolVersion: HOST_PROTOCOL_VERSION },
        true,
        this.profile.startupTimeoutMs
      );
      const handshake = this.validateHandshake(result);
      if (this.sealed) throw new HostClientError('shutting-down', 'not-dispatched');
      this.ready = true;
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
      for (const [key, cap] of Object.entries(DEFAULT_HOST_LIMITS)) {
        if (typeof candidate[key] !== 'number' || candidate[key] > cap) throw new Error('limit');
      }
      this.limits = resolveHostLimits(candidate as unknown as HostLimits);
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
      if (frame.length - 1 > this.limits.maxFrameBytes) throw new Error('frame');
    } catch {
      return Promise.reject(new HostClientError('protocol-error', 'not-dispatched'));
    }
    const writeCountLimit = control
      ? this.limits.maxPriorityMessages
      : this.limits.maxPriorityMessages - this.limits.reservedControlRequests;
    const writeByteLimit = control
      ? this.limits.maxPriorityBytes
      : this.limits.maxPriorityBytes - this.limits.maxFrameBytes;
    if (this.writeCount >= writeCountLimit || this.writeBytes + frame.length > writeByteLimit) {
      return Promise.reject(new HostClientError('capacity-exceeded', 'not-dispatched'));
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostClientError('request-timeout', 'unknown'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeBytes += frame.length;
      this.writeCount++;
      const writeTimer = setTimeout(
        () => this.fail(new HostClientError('transport-closed', 'unknown')),
        this.profile.writeTimeoutMs
      );
      this.writeTimers.add(writeTimer);
      child.stdin.write(frame, (error) => {
        clearTimeout(writeTimer);
        this.writeTimers.delete(writeTimer);
        this.writeBytes -= frame.length;
        this.writeCount--;
        if (error) this.fail(new HostClientError('transport-closed', 'unknown'));
      });
    });
  }

  private decode(chunk: Buffer): void {
    if (this.sealed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.frame.length + part.length > this.limits.maxFrameBytes) {
        this.fail(new HostClientError('protocol-error', 'unknown'));
        return;
      }
      this.frame = Buffer.concat([this.frame, part]);
      if (newline < 0) return;
      const frame = this.frame;
      this.frame = Buffer.alloc(0);
      if (!this.receive(frame)) return;
      offset = end + 1;
    }
  }

  private receive(frame: Buffer): boolean {
    try {
      const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
      if (!isRecord(message) || message.jsonrpc !== '2.0') throw new Error('envelope');
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
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if ('error' in message) {
          // Only transport-owned codes establish rejection before handler admission.
          // A handler exception may follow a partial effect and must remain unknown.
          const code = (message.error as { code: number }).code;
          const rejected = [-32001, -32002, -32601].includes(code);
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
    this.ready = false;
    this.frame = Buffer.alloc(0);
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
    this.ready = false;
    this.shutdownPromise ??= this.dispose();
    return this.shutdownPromise;
  }

  private async waitForExit(): Promise<boolean> {
    if (!this.child || this.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.profile.shutdownTimeoutMs);
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
      if (!(await this.waitForExit())) {
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
