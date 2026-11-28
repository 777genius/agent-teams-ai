import { HOST_GAP_METHOD } from './contracts.js';

import type {
  HostCloseReason,
  HostLimits,
  RpcNotification,
  RpcRequest,
  RpcResponse,
} from './contracts.js';
import type { Writable } from 'node:stream';

/** One in-flight write; bounded priority/data budgets never await a producer. */
export class HostOutput {
  private priority: { frame: Buffer; control: boolean }[] = [];
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
    private readonly fail: (reason: HostCloseReason) => void,
    private readonly privateCapacity?: () => void
  ) {}

  sendPriority(
    message: RpcResponse | RpcNotification,
    maxFrameBytes = this.limits.maxFrameBytes
  ): boolean {
    if (this.stopped) return false;
    const frame = this.encode(message, maxFrameBytes);
    if (
      !frame ||
      this.priority.length >= this.limits.maxPriorityMessages ||
      this.priorityBytes + frame.length > this.limits.maxPriorityBytes
    ) {
      this.fail('priority_overflow');
      return false;
    }
    this.priority.push({ frame, control: true });
    this.priorityBytes += frame.length;
    this.pump();
    return true;
  }

  /** Conservative admission for one private frame; the following send is synchronous. */
  canSendPrivate(control: boolean, maxFrameBytes: number): boolean {
    const count = this.limits.maxPriorityMessages -
      (control ? 0 : this.limits.reservedControlRequests);
    const budget = this.limits.maxPriorityBytes - (control ? 0 : this.limits.maxFrameBytes);
    const bytes = Math.min(maxFrameBytes, this.limits.maxFrameBytes) + 1;
    return !this.stopped && this.priority.length < count && this.priorityBytes + bytes <= budget;
  }

  /** Private work shares the existing priority budget and leaves the original control reserve. */
  sendPrivate(message: RpcRequest, control: boolean, maxFrameBytes: number): boolean {
    if (this.stopped) return false;
    const frame = this.encode(message, maxFrameBytes);
    const count =
      this.limits.maxPriorityMessages - (control ? 0 : this.limits.reservedControlRequests);
    const bytes = this.limits.maxPriorityBytes - (control ? 0 : this.limits.maxFrameBytes);
    if (!frame || this.priority.length >= count || this.priorityBytes + frame.length > bytes) {
      if (control) this.fail('priority_overflow');
      return false;
    }
    this.priority.push({ frame, control });
    this.priorityBytes += frame.length;
    this.pump();
    return true;
  }

  sendData(message: RpcNotification, maxFrameBytes = this.limits.maxFrameBytes): boolean {
    if (this.stopped) return false;
    const frame = this.encode(message, maxFrameBytes);
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

  private encode(
    message: RpcResponse | RpcNotification | RpcRequest,
    maxFrameBytes = this.limits.maxFrameBytes
  ): Buffer | undefined {
    try {
      const text = JSON.stringify(message);
      if (Buffer.byteLength(text) > Math.min(maxFrameBytes, this.limits.maxFrameBytes))
        return undefined;
      return Buffer.from(`${text}\n`);
    } catch {
      return undefined;
    }
  }

  private pump(): void {
    if (this.stopped || this.writing) return;
    const control = this.priority.findIndex((entry) => entry.control);
    let frame: Buffer | undefined = this.priority.splice(control < 0 ? 0 : control, 1)[0]?.frame;
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
        else {
          this.pump();
          this.privateCapacity?.();
        }
      });
    } catch {
      this.fail('output_error');
    }
  }
}
