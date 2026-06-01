import { defaultSubscriptionRetryPolicy } from "./validation.js";
import { SubscriptionQueueError } from "./errors.js";
const defaultShutdownGraceMs = 30_000;
export class SubscriptionQueueProcessor {
    options;
    processorState = "created";
    loop = null;
    stopController = null;
    currentTaskController = null;
    shutdownGraceTimer = null;
    counters = {
        claimed: 0,
        completed: 0,
        retried: 0,
        deadLettered: 0,
        failed: 0,
    };
    constructor(options) {
        this.options = options;
    }
    get state() {
        return this.processorState;
    }
    start() {
        if (this.processorState === "running")
            return;
        this.stopController = new AbortController();
        this.processorState = "running";
        this.loop = this.runLoop(this.stopController.signal);
    }
    async stop() {
        if (this.processorState === "created") {
            this.processorState = "stopped";
            return;
        }
        if (!this.stopController) {
            throw new SubscriptionQueueError("subscription_queue_processor_not_started", "Queue processor has not been started.");
        }
        this.processorState = "stopping";
        this.armCurrentTaskShutdownGrace();
        this.stopController.abort();
        try {
            await this.loop;
        }
        finally {
            this.clearShutdownGraceTimer();
            this.processorState = "stopped";
        }
    }
    stats() {
        return {
            state: this.processorState,
            ...this.counters,
        };
    }
    async runLoop(signal) {
        while (!signal.aborted && !this.options.abortSignal?.aborted) {
            const claimed = await this.options.queue.claim({
                leaseTtlMs: this.options.leaseTtlMs ?? 10 * 60_000,
            });
            if (!claimed) {
                await delay(this.options.idleDelayMs ?? 250, signal);
                continue;
            }
            if (signal.aborted || this.options.abortSignal?.aborted) {
                await this.releaseClaim(claimed);
                break;
            }
            this.counters.claimed += 1;
            const taskController = new AbortController();
            const abortTask = () => taskController.abort();
            this.options.abortSignal?.addEventListener("abort", abortTask, {
                once: true,
            });
            this.currentTaskController = taskController;
            if (this.processorState === "stopping") {
                this.armCurrentTaskShutdownGrace();
            }
            try {
                const result = await this.options.workerPool.run(claimed.task.job, {
                    ...(claimed.task.idempotencyKey
                        ? { idempotencyKey: claimed.task.idempotencyKey }
                        : {}),
                    abortSignal: taskController.signal,
                });
                await this.options.queue.complete({
                    taskId: claimed.task.taskId,
                    leaseId: claimed.leaseId,
                    result,
                });
                this.counters.completed += 1;
            }
            catch (error) {
                this.counters.failed += 1;
                const failed = await this.options.queue.fail({
                    taskId: claimed.task.taskId,
                    leaseId: claimed.leaseId,
                    error,
                    retryPolicy: this.options.retryPolicy ?? defaultSubscriptionRetryPolicy,
                });
                if (failed.status === "retry_scheduled") {
                    this.counters.retried += 1;
                }
                else {
                    this.counters.deadLettered += 1;
                }
            }
            finally {
                this.options.abortSignal?.removeEventListener("abort", abortTask);
                if (this.processorState === "stopping") {
                    this.clearShutdownGraceTimer();
                }
                if (this.currentTaskController === taskController) {
                    this.currentTaskController = null;
                }
            }
        }
    }
    async releaseClaim(claimed) {
        if (!this.options.queue.release)
            return;
        await this.options.queue.release({
            taskId: claimed.task.taskId,
            leaseId: claimed.leaseId,
        });
    }
    armCurrentTaskShutdownGrace() {
        if (this.shutdownGraceTimer)
            return;
        const currentTaskController = this.currentTaskController;
        if (!currentTaskController || currentTaskController.signal.aborted)
            return;
        this.shutdownGraceTimer = setTimeout(() => {
            currentTaskController.abort();
        }, this.options.shutdownGraceMs ?? defaultShutdownGraceMs);
    }
    clearShutdownGraceTimer() {
        if (!this.shutdownGraceTimer)
            return;
        clearTimeout(this.shutdownGraceTimer);
        this.shutdownGraceTimer = null;
    }
}
function delay(ms, signal) {
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
//# sourceMappingURL=processor.js.map