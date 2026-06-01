import { randomUUID } from "node:crypto";
import { computeBackoffDelayMs } from "./validation.js";
import { SubscriptionQueueError } from "./errors.js";
export class InMemorySubscriptionTaskQueue {
    queueId;
    records = new Map();
    idempotency = new Map();
    closed = false;
    constructor(options) {
        if (!options.queueId.trim()) {
            throw new SubscriptionQueueError("subscription_queue_closed", "Queue id is required.");
        }
        this.queueId = options.queueId;
    }
    async enqueue(input) {
        this.assertOpen();
        if (input.idempotencyKey) {
            const existingTaskId = this.idempotency.get(input.idempotencyKey);
            if (existingTaskId) {
                return { status: "idempotent_replay", taskId: existingTaskId };
            }
        }
        const taskId = input.taskId ?? randomUUID();
        if (this.records.has(taskId)) {
            throw new SubscriptionQueueError("subscription_queue_duplicate", "Task id already exists.");
        }
        const task = {
            taskId,
            job: input.job,
            attempt: 1,
            maxAttempts: input.maxAttempts ?? 3,
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
            runAfter: input.runAfter ?? new Date(),
            createdAt: new Date(),
            metadata: input.metadata ?? {},
        };
        this.records.set(taskId, {
            task,
            status: "queued",
            leaseId: null,
            leaseExpiresAt: null,
            result: null,
            error: null,
        });
        if (input.idempotencyKey)
            this.idempotency.set(input.idempotencyKey, taskId);
        return { status: "accepted", taskId };
    }
    async claim(input) {
        this.assertOpen();
        const now = input.now ?? new Date();
        for (const record of this.records.values()) {
            if (!isClaimable(record, now))
                continue;
            const leaseId = randomUUID();
            const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
            record.status = "leased";
            record.leaseId = leaseId;
            record.leaseExpiresAt = leaseExpiresAt;
            return {
                task: record.task,
                leaseId,
                leaseExpiresAt,
            };
        }
        return null;
    }
    async complete(input) {
        const record = this.requireLeased(input.taskId, input.leaseId);
        record.status = "completed";
        record.result = input.result;
        record.leaseId = null;
        record.leaseExpiresAt = null;
    }
    async release(input) {
        const record = this.requireLeased(input.taskId, input.leaseId);
        record.status = "queued";
        record.leaseId = null;
        record.leaseExpiresAt = null;
    }
    async fail(input) {
        const record = this.requireLeased(input.taskId, input.leaseId);
        const now = input.now ?? new Date();
        record.error = safeError(input.error);
        record.leaseId = null;
        record.leaseExpiresAt = null;
        if (record.task.attempt >=
            Math.min(record.task.maxAttempts, input.retryPolicy.maxAttempts)) {
            record.status = "dead_lettered";
            return { status: "dead_lettered" };
        }
        const nextAttempt = record.task.attempt + 1;
        const runAfter = new Date(now.getTime() +
            computeBackoffDelayMs({
                attempt: record.task.attempt,
                policy: input.retryPolicy,
                random: () => 0.5,
            }));
        record.status = "retry_scheduled";
        record.task = {
            ...record.task,
            attempt: nextAttempt,
            runAfter,
        };
        return {
            status: "retry_scheduled",
            nextAttempt,
            runAfter,
        };
    }
    async size(input = {}) {
        const now = new Date();
        return [...this.records.values()].filter((record) => {
            if (record.status !== "queued" && record.status !== "retry_scheduled") {
                return false;
            }
            if (input.includeDelayed)
                return true;
            return record.task.runAfter <= now;
        }).length;
    }
    close() {
        this.closed = true;
    }
    requireLeased(taskId, leaseId) {
        const record = this.records.get(taskId);
        if (!record || record.leaseId !== leaseId) {
            throw new SubscriptionQueueError("subscription_queue_job_not_found", "Leased task was not found.");
        }
        return record;
    }
    assertOpen() {
        if (this.closed) {
            throw new SubscriptionQueueError("subscription_queue_closed", "Subscription task queue is closed.");
        }
    }
}
function isClaimable(record, now) {
    if (record.status === "leased" && record.leaseExpiresAt) {
        return record.leaseExpiresAt <= now;
    }
    return ((record.status === "queued" || record.status === "retry_scheduled") &&
        record.task.runAfter <= now);
}
function safeError(error) {
    if (error instanceof Error)
        return error.message.slice(0, 500);
    if (typeof error === "string")
        return error.slice(0, 500);
    return "unknown";
}
//# sourceMappingURL=in-memory-task-queue.js.map