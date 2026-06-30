export class InterruptAndContinueWorkerUseCase {
    options;
    constructor(options) {
        this.options = options;
    }
    async execute(input) {
        const caller = input.caller ?? {
            kind: input.createdBy ?? "operator",
        };
        const signal = await this.options.control.enqueueSignal({
            target: input.target,
            intent: "guidance",
            deliveryMode: "interrupt_then_continue",
            body: input.message,
            caller,
            ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
            ...(input.priority === undefined ? { priority: "high" } : { priority: input.priority }),
            ...(input.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: input.idempotencyKey }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            metadata: {
                requestedDelivery: "interrupt_then_continue",
            },
        });
        const interrupt = await this.options.activeAttemptRegistry?.interrupt(input.target, {
            code: "runtime_controlled_interrupt",
            safeMessage: "Runtime controlled interrupt requested by worker control inbox.",
            signalId: signal.signalId,
            requestedBy: caller.id ?? caller.kind,
        });
        if (interrupt?.status === "interrupted") {
            return {
                status: "interrupted",
                signal,
                interrupt,
                safeMessage: "Active attempt was interrupted. Safe execution will resume through continuation.",
            };
        }
        return {
            status: "accepted_as_next_safe_point",
            signal,
            safeMessage: "Guidance was stored durably. No interruptible active attempt was available, so it will be delivered at the next safe continuation point.",
        };
    }
}
//# sourceMappingURL=interrupt-and-continue-worker-use-case.js.map