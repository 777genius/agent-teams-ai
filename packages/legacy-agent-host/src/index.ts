import { randomUUID } from 'node:crypto';

import { HOST_PROTOCOL_VERSION, resolveHostLimits } from './contracts.js';
import { BoundedLineDecoder } from './framing.js';
import { HostOutput } from './output.js';

import type {
  HostCloseReason,
  HostCloseResult,
  HostHandshake,
  HostLimits,
  JsonValue,
  RpcId,
  RpcRequest,
} from './contracts.js';
import type { Readable, Writable } from 'node:stream';

export type { HostCloseResult, HostHandshake, HostLimits, JsonValue } from './contracts.js';

export interface HostHandlerContext {
  requestId: RpcId;
  /** Transport disposal signal, not an application command cancellation receipt. */
  signal: AbortSignal;
}

export interface HostMethod {
  lane: 'work' | 'control';
  handle(
    params: JsonValue | undefined,
    context: HostHandlerContext
  ): JsonValue | Promise<JsonValue>;
}

export interface HostServerOptions {
  input: Readable;
  output: Writable;
  buildId: string;
  capabilities?: readonly string[];
  limits?: Partial<HostLimits>;
  methods?: Readonly<Record<string, HostMethod>>;
  /** Synchronous work seal, before any abort/cleanup await, including pending allocations. */
  onSeal?(): void;
  /** Caller must retain durable obligations; called once even after transport failure. */
  onDispose?(reason: HostCloseReason): void | Promise<void>;
}

export interface HostServer {
  readonly handshake: HostHandshake;
  readonly closed: Promise<HostCloseResult>;
  notifyData(method: string, params: JsonValue): boolean;
  notifyControl(method: string, params: JsonValue): boolean;
  dispose(reason?: HostCloseReason): Promise<HostCloseResult>;
}

export class HostRpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

function isRequest(value: unknown): value is RpcRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    request.jsonrpc === '2.0' &&
    typeof request.method === 'string' &&
    (typeof request.id === 'string' || Number.isSafeInteger(request.id))
  );
}

export function createHostServer(options: HostServerOptions): HostServer {
  const limits = resolveHostLimits(options.limits);
  const handshake: HostHandshake = {
    protocolVersion: HOST_PROTOCOL_VERSION,
    buildId: options.buildId,
    hostIncarnation: randomUUID(),
    capabilities: ['transport.ndjson', 'transport.gap', ...(options.capabilities ?? [])],
    limits,
  };
  const abort = new AbortController();
  const pending = new Set<RpcId>();
  let workCount = 0;
  let handshaken = false;
  let closing = false;
  let finish!: (result: HostCloseResult) => void;
  const closed = new Promise<HostCloseResult>((resolve) => {
    finish = resolve;
  });
  const fail = (reason: HostCloseReason): void => {
    void dispose(reason);
  };
  const output = new HostOutput(options.output, limits, fail);
  const decoder = new BoundedLineDecoder(limits.maxFrameBytes, receive, fail);

  function sendError(id: RpcId | null, code: number, message: string): void {
    output.sendPriority({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function receive(frame: string): void {
    if (closing) return;
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      sendError(null, -32700, 'Invalid JSON');
      return;
    }
    if (!isRequest(value)) {
      sendError(null, -32600, 'Invalid request');
      return;
    }
    const request = value;
    if (pending.has(request.id)) {
      sendError(request.id, -32600, 'Request ID already pending');
      return;
    }
    let method: HostMethod | undefined;
    if (request.method === 'host.handshake') {
      const params = request.params;
      if (
        !params ||
        typeof params !== 'object' ||
        Array.isArray(params) ||
        params.protocolVersion !== HOST_PROTOCOL_VERSION
      ) {
        sendError(request.id, -32001, 'Protocol mismatch');
        return;
      }
      method = {
        lane: 'control',
        handle() {
          handshaken = true;
          return { ...handshake, limits: { ...limits } };
        },
      };
    } else {
      if (!handshaken) {
        sendError(request.id, -32001, 'Handshake required');
        return;
      }
      if (Object.hasOwn(options.methods ?? {}, request.method))
        method = options.methods?.[request.method];
    }
    if (!method) {
      sendError(request.id, -32601, 'Method not found');
      return;
    }
    if (
      pending.size >= limits.maxPendingRequests ||
      (method.lane === 'work' &&
        workCount >= limits.maxPendingRequests - limits.reservedControlRequests)
    ) {
      sendError(request.id, -32002, 'Host busy');
      return;
    }
    pending.add(request.id);
    if (method.lane === 'work') workCount++;
    // Never await handlers in the reader: control can arrive during a long prompt.
    void execute(request, method);
  }

  async function execute(request: RpcRequest, method: HostMethod): Promise<void> {
    try {
      const result = await method.handle(request.params, {
        requestId: request.id,
        signal: abort.signal,
      });
      if (!closing) output.sendPriority({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      // Only transport owns pre-admission rejection codes. A handler can fail
      // after effects and must never manufacture a safe-to-retry busy/mismatch.
      const safeError =
        error instanceof HostRpcError &&
        Number.isSafeInteger(error.code) &&
        error.code >= -32099 &&
        error.code <= -32010;
      if (!closing)
        sendError(
          request.id,
          safeError ? error.code : -32603,
          safeError ? 'Operation failed' : 'Handler failed'
        );
    } finally {
      pending.delete(request.id);
      if (method.lane === 'work') workCount--;
    }
  }

  function onData(chunk: Buffer | string): void {
    decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  function onEnd(): void {
    decoder.end();
    fail('input_eof');
  }
  function onInputError(): void {
    fail('input_error');
  }
  function onOutputError(): void {
    fail('output_error');
  }

  function dispose(reason: HostCloseReason = 'disposed'): Promise<HostCloseResult> {
    if (closing) return closed;
    closing = true;
    let sealFailed = false;
    try {
      options.onSeal?.();
    } catch {
      sealFailed = true;
    }
    decoder.stop();
    options.input.off('data', onData).off('end', onEnd).off('error', onInputError);
    options.input.pause();
    output.stop();
    abort.abort(reason);
    options.input.destroy();
    options.output.destroy();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<HostCloseResult['cleanup']>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), limits.disposeTimeoutMs);
    });
    const cleanup = Promise.resolve()
      .then(async () => {
        await options.onDispose?.(reason);
        if (sealFailed) throw new Error('Seal failed');
      })
      .then(
        () => 'completed' as const,
        () => 'failed' as const
      );
    void Promise.race([cleanup, timeout]).then((status) => {
      clearTimeout(timer);
      finish({ reason, cleanup: status });
    });
    return closed;
  }

  options.input.on('data', onData).on('end', onEnd).on('error', onInputError);
  options.output.on('error', onOutputError);
  return {
    handshake,
    closed,
    notifyData: (method, params) => output.sendData({ jsonrpc: '2.0', method, params }),
    notifyControl: (method, params) => output.sendPriority({ jsonrpc: '2.0', method, params }),
    dispose,
  };
}
