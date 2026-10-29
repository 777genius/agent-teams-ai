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

/** Team/Runtime composition has a longer finite cleanup budget than transport-only hosts. */
export const TEAM_HOST_DISPOSE_TIMEOUT_MS = 60_000;

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

/** Explicit trusted profile opt-in; wire protocol remains version 1. */
export type HostReviewTransportProfile = 'review-v1';
export const REVIEW_HOST_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const REVIEW_HOST_ENVELOPE_BYTES = 64 * 1024;
export const MAX_HOST_FRAME_BYTES = REVIEW_HOST_PAYLOAD_BYTES + REVIEW_HOST_ENVELOPE_BYTES;
export const MAX_HOST_PRIORITY_BYTES = 2 * (MAX_HOST_FRAME_BYTES + 1);
export const REVIEW_HOST_METHODS: readonly string[] = Object.freeze([
  'team.review.invoke',
  'team.review.lookup',
  'team.review.recovery.read',
  'team.review.getTaskChanges',
  'team.review.getTaskSummaries',
  'team.review.getAgentChanges',
  'team.review.getChangeStats',
  'team.review.invalidateSummaries',
  'team.review.authorizeWatch',
  'team.review.getGitFileLog',
]);
export function isReviewHostMethod(method: string): boolean {
  return REVIEW_HOST_METHODS.includes(method);
}
/** Only these finite private management methods may carry bounded Skills file bundles. */
export const SKILLS_HOST_PAYLOAD_METHODS: readonly string[] = Object.freeze([
  'management.skills.read',
  'management.skills.preview',
  'management.skills.mutate',
  'management.skills.pending',
]);
export function isLargePayloadHostMethod(method: string): boolean {
  return isReviewHostMethod(method) || SKILLS_HOST_PAYLOAD_METHODS.includes(method);
}
export function hostPayloadLimit(method?: string): number {
  return method && isLargePayloadHostMethod(method)
    ? REVIEW_HOST_PAYLOAD_BYTES
    : DEFAULT_HOST_LIMITS.maxFrameBytes;
}
export function hostMethodFrameLimit(method: string, profile?: HostReviewTransportProfile): number {
  return profile === 'review-v1' && isLargePayloadHostMethod(method)
    ? MAX_HOST_FRAME_BYTES
    : DEFAULT_HOST_LIMITS.maxFrameBytes;
}
export function hostProfileLimitCaps(profile?: HostReviewTransportProfile): HostLimits {
  if (profile !== undefined && profile !== 'review-v1')
    throw new RangeError('Unknown transport profile');
  return {
    ...DEFAULT_HOST_LIMITS,
    ...(profile === 'review-v1'
      ? {
          maxFrameBytes: MAX_HOST_FRAME_BYTES,
          maxPriorityBytes: MAX_HOST_PRIORITY_BYTES,
        }
      : {}),
  };
}
export function resolveHostProfileLimits(
  profile?: HostReviewTransportProfile,
  overrides: Partial<HostLimits> = {}
): HostLimits {
  const caps = hostProfileLimitCaps(profile);
  const limits = resolveHostLimits({ ...caps, ...overrides });
  if (
    limits.maxFrameBytes > caps.maxFrameBytes ||
    limits.maxPriorityBytes > caps.maxPriorityBytes ||
    (profile === 'review-v1' && limits.maxPriorityBytes < 2 * (limits.maxFrameBytes + 1))
  )
    throw new RangeError('Transport capacity exceeds captured profile or lacks two-frame reserve');
  return limits;
}

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
  if (
    limits.maxFrameBytes > MAX_HOST_FRAME_BYTES ||
    limits.maxPriorityBytes > MAX_HOST_PRIORITY_BYTES
  )
    throw new RangeError('Transport capacity exceeds finite implementation maximum');
  if (limits.maxFrameBytes < 1024 || limits.reservedControlRequests >= limits.maxPendingRequests) {
    throw new RangeError('Frame limit must be >=1024; control reserve must be below request limit');
  }
  return limits;
}
