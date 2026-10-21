import { HOST_GAP_METHOD } from './contracts.js';

import type { HostCloseReason, HostLimits, RpcNotification, RpcResponse } from './contracts.js';
import type { Writable } from 'node:stream';

/** One in-flight write; bounded priority/data budgets never await a producer. */
export class HostOutput {
  private priority: Buffer[] = [];
  private data: Buffer[] = [];
  private priorityBytes = 0;
  private dataBytes = 0;
  private dropped = 0;
  private writing = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly output: Writable,
    private readonly limits: HostLimits,
    private readonly fail: (reason: HostCloseReason) => void
  ) {}

  sendPriority(message: RpcResponse | RpcNotification): boolean {
    if (this.stopped) return false;
    const frame = this.encode(message);
    if (
      !frame ||
      this.priority.length >= this.limits.maxPriorityMessages ||
      this.priorityBytes + frame.length > this.limits.maxPriorityBytes
    ) {
      this.fail('priority_overflow');
      return false;
    }
    this.priority.push(frame);
    this.priorityBytes += frame.length;
    this.pump();
    return true;
  }

  sendData(message: RpcNotification): boolean {
    if (this.stopped) return false;
    const frame = this.encode(message);
    if (
      !frame ||
      this.data.length >= this.limits.maxDataNotifications ||
      this.dataBytes + frame.length > this.limits.maxDataBytes
    ) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + this.data.length + 1);
      this.data = [];
      this.dataBytes = 0;
      this.pump();
      return false;
    }
    this.data.push(frame);
    this.dataBytes += frame.length;
    this.pump();
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.priority = [];
    this.data = [];
    this.priorityBytes = this.dataBytes = this.dropped = 0;
  }

  private encode(message: RpcResponse | RpcNotification): Buffer | undefined {
    try {
      const text = JSON.stringify(message);
      if (Buffer.byteLength(text) > this.limits.maxFrameBytes) return undefined;
      return Buffer.from(`${text}\n`);
    } catch {
      return undefined;
    }
  }

  private pump(): void {
    if (this.stopped || this.writing) return;
    let frame = this.priority.shift();
    if (frame) this.priorityBytes -= frame.length;
    else if (this.dropped > 0) {
      frame = this.encode({
        jsonrpc: '2.0',
        method: HOST_GAP_METHOD,
        params: { dropped: this.dropped },
      });
      this.dropped = 0;
    } else {
      frame = this.data.shift();
      if (frame) this.dataBytes -= frame.length;
    }
    if (!frame) return;
    this.writing = true;
    this.timer = setTimeout(() => this.fail('write_timeout'), this.limits.writeTimeoutMs);
    try {
      this.output.write(frame, (error) => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.writing = false;
        if (this.stopped) return;
        if (error) this.fail('output_error');
        else this.pump();
      });
    } catch {
      this.fail('output_error');
    }
  }
}
