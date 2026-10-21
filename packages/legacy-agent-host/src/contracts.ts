/** Browser-safe transport contracts. No native/provider or product DTOs. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: '2.0';
  id: RpcId;
  method: string;
  params?: JsonValue;
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: RpcId | null; result: JsonValue }
  | { jsonrpc: '2.0'; id: RpcId | null; error: { code: number; message: string } };

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: JsonValue;
}

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_GAP_METHOD = 'host.gap';

export interface HostLimits {
  /** UTF-8 bytes before the LF delimiter, including an optional CR. */
  maxFrameBytes: number;
  maxPendingRequests: number;
  reservedControlRequests: number;
  maxDataNotifications: number;
  maxDataBytes: number;
  maxPriorityMessages: number;
  maxPriorityBytes: number;
  writeTimeoutMs: number;
  disposeTimeoutMs: number;
}

export const DEFAULT_HOST_LIMITS: Readonly<HostLimits> = Object.freeze({
  maxFrameBytes: 1024 * 1024,
  maxPendingRequests: 32,
  reservedControlRequests: 8,
  maxDataNotifications: 128,
  maxDataBytes: 2 * 1024 * 1024,
  maxPriorityMessages: 64,
  maxPriorityBytes: 2 * 1024 * 1024,
  writeTimeoutMs: 5000,
  disposeTimeoutMs: 5000,
});

export interface HostHandshake {
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  buildId: string;
  hostIncarnation: string;
  capabilities: string[];
  limits: HostLimits;
}

export type HostCloseReason =
  | 'disposed'
  | 'input_eof'
  | 'input_error'
  | 'output_error'
  | 'signal'
  | 'frame_too_large'
  | 'invalid_utf8'
  | 'truncated_frame'
  | 'priority_overflow'
  | 'write_timeout';

export interface HostCloseResult {
  reason: HostCloseReason;
  cleanup: 'completed' | 'failed' | 'timeout';
}

export function resolveHostLimits(overrides: Partial<HostLimits> = {}): HostLimits {
  const limits = { ...DEFAULT_HOST_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) {
      throw new RangeError(`Invalid host limit: ${key}`);
    }
  }
  if (limits.maxFrameBytes < 1024 || limits.reservedControlRequests >= limits.maxPendingRequests) {
    throw new RangeError('Frame limit must be >=1024; control reserve must be below request limit');
  }
  return limits;
}
