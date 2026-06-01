import { SubscriptionWorkerError } from "./errors.js";
const defaultMaxQueueSize = 1024;
const defaultShutdownTimeoutMs = 30_000;
export class BoundedSubscriptionWorkerPool {
    options;
    slots = [];
    queue = [];
    poolState = "created";
    completedCount = 0;
    failedCount = 0;
    restartedCount = 0;
    inFlightCount = 0;
    constructor(options) {
        this.options = options;
        if (!options.poolId.trim()) {
            throw new SubscriptionWorkerError("subscription_worker_pool_empty", "Worker pool id is required.");
        }
        if (!Number.isInteger(options.slots) || options.slots <= 0) {
            throw new SubscriptionWorkerError("subscription_worker_pool_empty", "Worker pool must have at least one slot.");
        }
    }
    get poolId() {
        return this.options.poolId;
    }
    get state() {
        return this.poolState;
    }
    async start() {
        if (this.poolState === "disposed") {
            throw new SubscriptionWorkerError("subscription_worker_disposed", "Worker pool has been disposed.");
        }
        if (this.poolState !== "created" && this.poolState !== "failed") {
            throw new SubscriptionWorkerError("subscription_worker_already_started", "Worker pool is already started.");
        }
        this.poolState = "starting";
        try {
            for (let index = 0; index < this.options.slots; index += 1) {
                const slot = this.createSlot(index);
                await slot.worker.start();
                this.slots.push(slot);
            }
            this.poolState = "started";
            if (this.options.prewarmOnStart) {
                await this.prewarm();
            }
            this.emit("subscription_worker_pool.started");
        }
        catch (error) {
            this.poolState = "failed";
            await this.disposeStartedSlots();
            throw new SubscriptionWorkerError("subscription_worker_start_failed", "Worker pool failed to start.", { cause: error });
        }
    }
    async prewarm() {
        this.assertRunnable();
        this.poolState = "prewarming";
        try {
            const results = await Promise.all(this.slots.map((slot) => slot.worker.prewarm()));
            this.poolState = "ready";
            this.emit("subscription_worker_pool.prewarmed");
            return results;
        }
        catch (error) {
            this.poolState = "failed";
            throw new SubscriptionWorkerError("subscription_worker_prewarm_failed", "Worker pool failed to prewarm.", { cause: error });
        }
    }
    run(job, options = {}) {
        this.assertRunnable();
        if (options.abortSignal?.aborted) {
            return Promise.reject(runAbortedError());
        }
        if (this.poolState === "draining") {
            return Promise.reject(new SubscriptionWorkerError("subscription_worker_pool_draining", "Worker pool is draining and does not accept new work."));
        }
        const available = this.slots.find((slot) => !slot.busy);
        if (available) {
            return this.runOnSlot(available, job, options);
        }
        if (this.queue.length >= (this.options.maxQueueSize ?? defaultMaxQueueSize)) {
            return Promise.reject(new SubscriptionWorkerError("subscription_worker_pool_queue_full", "Worker pool queue is full."));
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const resolveOnce = (result) => {
                if (settled)
                    return;
                settled = true;
                options.abortSignal?.removeEventListener("abort", abort);
                resolve(result);
            };
            const rejectOnce = (error) => {
                if (settled)
                    return;
                settled = true;
                options.abortSignal?.removeEventListener("abort", abort);
                reject(error);
            };
            const abort = () => {
                const index = this.queue.indexOf(queued);
                if (index >= 0)
                    this.queue.splice(index, 1);
                rejectOnce(runAbortedError());
            };
            const queued = {
                job,
                options,
                resolve: resolveOnce,
                reject: rejectOnce,
            };
            options.abortSignal?.addEventListener("abort", abort, { once: true });
            this.queue.push(queued);
            this.drainQueue();
        });
    }
    async restartSlot(slotIndex, options = {}) {
        this.assertRunnable();
        const slot = this.slots[slotIndex];
        if (!slot) {
            throw new SubscriptionWorkerError("subscription_worker_pool_slot_not_found", "Worker pool slot was not found.", { details: { slotIndex: String(slotIndex) } });
        }
        if (slot.busy) {
            throw new SubscriptionWorkerError("subscription_worker_pool_slot_busy", "Worker pool slot is busy and cannot be restarted.", { details: { slotIndex: String(slotIndex) } });
        }
        this.emit("subscription_worker_pool.slot_restart.started", {
            slotIndex: String(slotIndex),
            workerId: slot.worker.workerId,
        });
        slot.busy = true;
        const next = this.createSlot(slotIndex);
        try {
            await slot.worker.dispose();
            await next.worker.start();
            if (options.prewarm) {
                await next.worker.prewarm();
            }
            this.slots[slotIndex] = next;
        }
        catch (error) {
            this.slots.splice(slotIndex, 1);
            this.poolState = "failed";
            const restartError = new SubscriptionWorkerError("subscription_worker_pool_slot_restart_failed", "Worker pool slot failed to restart.", {
                cause: error,
                details: {
                    slotIndex: String(slotIndex),
                    workerId: next.worker.workerId,
                },
            });
            await next.worker.dispose().catch(() => {
                // Best-effort cleanup after a failed replacement.
            });
            if (this.slots.length === 0) {
                this.rejectQueued(restartError);
            }
            else {
                this.drainQueue();
            }
            throw restartError;
        }
        this.restartedCount += 1;
        this.emit("subscription_worker_pool.slot_restart.completed", {
            slotIndex: String(slotIndex),
            workerId: next.worker.workerId,
        });
        this.drainQueue();
    }
    async health() {
        const slotHealth = await Promise.all(this.slots.map((slot) => safeHealth(slot.worker)));
        const unhealthy = slotHealth.filter((health) => health.status === "unhealthy");
        const degraded = slotHealth.filter((health) => health.status === "degraded");
        const status = unhealthy.length > 0
            ? "unhealthy"
            : degraded.length > 0 || this.poolState === "failed"
                ? "degraded"
                : "healthy";
        return {
            poolId: this.options.poolId,
            status,
            state: this.poolState,
            checkedAt: new Date(),
            slots: slotHealth,
            queued: this.queue.length,
            inFlight: this.inFlightCount,
        };
    }
    stats() {
        return {
            poolId: this.options.poolId,
            state: this.poolState,
            slots: this.slots.length,
            queued: this.queue.length,
            inFlight: this.inFlightCount,
            completed: this.completedCount,
            failed: this.failedCount,
            restarted: this.restartedCount,
        };
    }
    async dispose() {
        if (this.poolState === "disposed")
            return;
        this.poolState = "draining";
        const deadline = Date.now() + (this.options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs);
        while (this.inFlightCount > 0 && Date.now() < deadline) {
            await delay(25);
        }
        if (this.inFlightCount > 0) {
            this.rejectQueued(new SubscriptionWorkerError("subscription_worker_shutdown_timeout", "Worker pool shutdown timed out with in-flight work."));
        }
        else {
            this.rejectQueued(new SubscriptionWorkerError("subscription_worker_pool_draining", "Worker pool was disposed before queued work started."));
        }
        await this.disposeStartedSlots();
        this.poolState = "disposed";
        this.emit("subscription_worker_pool.disposed");
    }
    runOnSlot(slot, job, options) {
        slot.busy = true;
        this.inFlightCount += 1;
        return slot.worker
            .run(job, options.abortSignal ? { abortSignal: options.abortSignal } : {})
            .then((result) => {
            this.completedCount += 1;
            return result;
        })
            .catch((error) => {
            this.failedCount += 1;
            throw new SubscriptionWorkerError("subscription_worker_pool_slot_failed", "Worker pool slot failed to run a task.", {
                cause: error,
                details: {
                    workerId: slot.worker.workerId,
                    slotIndex: String(slot.index),
                },
            });
        })
            .finally(() => {
            slot.busy = false;
            this.inFlightCount -= 1;
            this.drainQueue();
        });
    }
    createSlot(index) {
        const workerId = `${this.options.poolId}:slot-${index + 1}`;
        return {
            index,
            worker: this.options.workerFactory({
                slotIndex: index,
                workerId,
            }),
            busy: false,
        };
    }
    drainQueue() {
        if (this.poolState === "draining" || this.poolState === "disposed")
            return;
        for (const slot of this.slots) {
            if (slot.busy)
                continue;
            const next = this.queue.shift();
            if (!next)
                return;
            void this.runOnSlot(slot, next.job, next.options)
                .then(next.resolve)
                .catch(next.reject);
        }
    }
    assertRunnable() {
        if (this.poolState === "disposed") {
            throw new SubscriptionWorkerError("subscription_worker_disposed", "Worker pool has been disposed.");
        }
        if (this.slots.length === 0) {
            throw new SubscriptionWorkerError("subscription_worker_not_started", "Worker pool has not been started.");
        }
    }
    rejectQueued(error) {
        const queued = this.queue.splice(0);
        for (const item of queued)
            item.reject(error);
    }
    async disposeStartedSlots() {
        const slots = this.slots.splice(0);
        const results = await Promise.allSettled(slots.map((slot) => slot.worker.dispose()));
        const rejected = results.filter((result) => result.status === "rejected");
        if (rejected.length > 0) {
            throw new AggregateError(rejected.map((result) => result.reason), "subscription_worker_pool_dispose_failed");
        }
    }
    emit(name, metadata = {}) {
        this.options.observability?.emit({
            name,
            metadata: {
                poolId: this.options.poolId,
                slots: String(this.options.slots),
                ...metadata,
            },
        });
    }
}
async function safeHealth(worker) {
    try {
        return await worker.health();
    }
    catch (error) {
        return {
            status: "unhealthy",
            state: "failed",
            checkedAt: new Date(),
            failures: [
                {
                    code: "subscription_worker_health_failed",
                    safeMessage: error instanceof Error ? error.message : "Worker health failed.",
                },
            ],
            warnings: [],
        };
    }
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function runAbortedError() {
    return new SubscriptionWorkerError("subscription_worker_pool_run_aborted", "Worker pool run was aborted before it started.");
}
//# sourceMappingURL=worker-pool.js.map