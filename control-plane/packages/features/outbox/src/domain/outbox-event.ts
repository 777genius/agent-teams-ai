import {
  createSafeError,
  type ExternalActionContentId,
  type OutboxEventId,
  type SafeError,
  type UnixMilliseconds,
  type WorkspaceId,
} from "@agent-teams-control-plane/shared";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type OutboxEventStatus =
  | "pending"
  | "processing"
  | "completed"
  | "dead-lettered"
  | "cancelled";

export type OutboxEvent = Readonly<{
  id: OutboxEventId;
  type: string;
  version: number;
  status: OutboxEventStatus;
  aggregateKind?: string;
  aggregateId?: string;
  workspaceId?: WorkspaceId;
  idempotencyKey: string;
  payload: JsonObject;
  contentRefId?: ExternalActionContentId;
  contentIntegrityHash?: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAtMs: UnixMilliseconds;
  lockedBy?: string;
  lockedUntilMs?: UnixMilliseconds;
  claimToken?: string;
  lastSafeError?: SafeError;
  createdAtMs: UnixMilliseconds;
  updatedAtMs: UnixMilliseconds;
  completedAtMs?: UnixMilliseconds;
  deadLetteredAtMs?: UnixMilliseconds;
}>;

export type NewOutboxEvent = Readonly<{
  id: OutboxEventId;
  type: string;
  version: number;
  aggregateKind?: string;
  aggregateId?: string;
  workspaceId?: WorkspaceId;
  idempotencyKey: string;
  payload: JsonObject;
  contentRefId?: ExternalActionContentId;
  contentIntegrityHash?: string;
  maxAttempts: number;
  nextAttemptAtMs: UnixMilliseconds;
}>;

export function validateNewOutboxEvent(event: NewOutboxEvent): SafeError | undefined {
  if (event.type.trim().length === 0) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_OUTBOX_EVENT_TYPE_REQUIRED",
      message: "Outbox event type is required.",
    });
  }
  if (event.version < 1) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_OUTBOX_EVENT_VERSION_INVALID",
      message: "Outbox event version must be positive.",
    });
  }
  if (event.maxAttempts < 1) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_OUTBOX_MAX_ATTEMPTS_INVALID",
      message: "Outbox max attempts must be positive.",
    });
  }
  if ((event.contentRefId === undefined) !== (event.contentIntegrityHash === undefined)) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_OUTBOX_CONTENT_REFERENCE_INVALID",
      message: "Outbox content reference and integrity hash must be stored together.",
    });
  }
  if (JSON.stringify(event.payload).length > 32_768) {
    return createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_OUTBOX_PAYLOAD_TOO_LARGE",
      message: "Outbox event payload is too large.",
    });
  }
  return undefined;
}

export function calculateRetryDelayMs(attempts: number): number {
  if (attempts <= 1) {
    return 0;
  }
  if (attempts === 2) {
    return 30_000;
  }
  if (attempts === 3) {
    return 120_000;
  }
  if (attempts === 4) {
    return 600_000;
  }
  return Math.min(3_600_000, 600_000 * 2 ** Math.max(0, attempts - 4));
}

export function calculateRetryDelayWithJitterMs(
  attempts: number,
  jitterMs: number,
): number {
  const baseDelayMs = calculateRetryDelayMs(attempts);
  if (baseDelayMs === 0) {
    return 0;
  }
  if (!Number.isFinite(jitterMs) || jitterMs < 0) {
    throw new RangeError("Retry jitter must be a non-negative finite number.");
  }
  return baseDelayMs + Math.floor(jitterMs);
}
