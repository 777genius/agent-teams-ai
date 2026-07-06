import {
  SubscriptionQueueError,
  SubscriptionQueueErrorCodeKind,
} from "./queue-errors";
import {
  SubscriptionQueueEnvelopeKind,
  subscriptionQueueTaskEnvelopeVersion,
  type SubscriptionQueueTaskEnvelope,
} from "./queue-envelope";
import type {
  SubscriptionQueueEnqueueInput,
  SubscriptionQueueTask,
} from "./queue-task";

export function assertSubscriptionQueueId(queueId: string): void {
  assertNonBlankString(queueId, "Queue id is required.");
}

export function assertSubscriptionQueueEnqueueInput<Job>(
  input: SubscriptionQueueEnqueueInput<Job>,
): void {
  if (!input || typeof input !== "object") {
    throwInvalidInput("Task enqueue input is required.");
  }
  if (input.taskId !== undefined) {
    assertNonBlankString(input.taskId, "Task id is required when provided.");
  }
  if (input.idempotencyKey !== undefined) {
    assertNonBlankString(
      input.idempotencyKey,
      "Idempotency key is required when provided.",
    );
  }
  if (input.runAfter !== undefined) {
    assertValidDate(input.runAfter, "Task runAfter must be a valid Date.");
  }
  if (
    input.maxAttempts !== undefined &&
    (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)
  ) {
    throwInvalidInput("Task maxAttempts must be a positive integer.");
  }
  if (input.metadata !== undefined) {
    assertStringRecord(input.metadata, "Task metadata must contain strings.");
  }
}

export function assertSubscriptionQueueClaimInput(input: {
  readonly leaseTtlMs: number;
  readonly now?: Date;
}): void {
  if (!input || typeof input !== "object") {
    throwInvalidInput("Claim input is required.");
  }
  if (!Number.isFinite(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
    throwInvalidInput("Lease TTL must be a positive finite number.");
  }
  if (input.now !== undefined) {
    assertValidDate(input.now, "Claim time must be a valid Date.");
  }
}

export function assertSubscriptionQueueTask<Job>(
  task: SubscriptionQueueTask<Job>,
): void {
  if (!task || typeof task !== "object") {
    throwInvalidInput("Task is required.");
  }
  assertNonBlankString(task.taskId, "Task id is required.");
  if (!Number.isInteger(task.attempt) || task.attempt < 1) {
    throwInvalidInput("Task attempt must be a positive integer.");
  }
  if (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1) {
    throwInvalidInput("Task maxAttempts must be a positive integer.");
  }
  if (task.attempt > task.maxAttempts) {
    throwInvalidInput("Task attempt cannot exceed maxAttempts.");
  }
  if (task.idempotencyKey !== undefined) {
    assertNonBlankString(
      task.idempotencyKey,
      "Task idempotency key is required when provided.",
    );
  }
  assertValidDate(task.runAfter, "Task runAfter must be a valid Date.");
  assertValidDate(task.createdAt, "Task createdAt must be a valid Date.");
  assertStringRecord(task.metadata, "Task metadata must contain strings.");
}

export function assertSubscriptionQueueTaskEnvelope<Job>(
  envelope: SubscriptionQueueTaskEnvelope<Job>,
): void {
  if (!envelope || typeof envelope !== "object") {
    throwInvalidInput("Task envelope is required.");
  }
  if (
    envelope.kind !== SubscriptionQueueEnvelopeKind.Task ||
    envelope.version !== subscriptionQueueTaskEnvelopeVersion
  ) {
    throwInvalidInput("Task envelope is not supported.");
  }
  assertSubscriptionQueueId(envelope.queueId);
  assertSubscriptionQueueTask(envelope.task);
}

function assertNonBlankString(value: string, message: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throwInvalidInput(message);
  }
}

function assertValidDate(value: Date, message: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throwInvalidInput(message);
  }
}

function assertStringRecord(
  value: unknown,
  message: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throwInvalidInput(message);
  }
  for (const [key, entry] of Object.entries(
    value as Readonly<Record<string, unknown>>,
  )) {
    if (!key.trim() || typeof entry !== "string") {
      throwInvalidInput(message);
    }
  }
}

function throwInvalidInput(message: string): never {
  throw new SubscriptionQueueError(
    SubscriptionQueueErrorCodeKind.InvalidInput,
    message,
  );
}
