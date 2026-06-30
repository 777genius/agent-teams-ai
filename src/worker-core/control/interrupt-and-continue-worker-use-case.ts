import type {
  ActiveAttemptInterruptResult,
  ActiveAttemptRegistry,
  WorkerControlActor,
  WorkerControlCaller,
  WorkerControlPriority,
  WorkerControlSignal,
  WorkerControlTarget,
} from "./types";
import { WorkerControlService } from "./worker-control-service";

export type InterruptAndContinueWorkerInput = {
  readonly target: WorkerControlTarget;
  readonly message: string;
  readonly caller?: WorkerControlCaller;
  readonly createdBy?: WorkerControlActor;
  readonly priority?: WorkerControlPriority;
  readonly idempotencyKey?: string;
  readonly expiresAt?: Date;
};

export type InterruptAndContinueWorkerResult =
  | {
      readonly status: "interrupted";
      readonly signal: WorkerControlSignal;
      readonly interrupt: Extract<ActiveAttemptInterruptResult, { status: "interrupted" }>;
      readonly safeMessage: string;
    }
  | {
      readonly status: "accepted_as_next_safe_point";
      readonly signal: WorkerControlSignal;
      readonly safeMessage: string;
    };

export class InterruptAndContinueWorkerUseCase {
  constructor(
    private readonly options: {
      readonly control: WorkerControlService;
      readonly activeAttemptRegistry?: ActiveAttemptRegistry;
    },
  ) {}

  async execute(
    input: InterruptAndContinueWorkerInput,
  ): Promise<InterruptAndContinueWorkerResult> {
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

    const interrupt = await this.options.activeAttemptRegistry?.interrupt(
      input.target,
      {
        code: "runtime_controlled_interrupt",
        safeMessage:
          "Runtime controlled interrupt requested by worker control inbox.",
        signalId: signal.signalId,
        requestedBy: caller.id ?? caller.kind,
      },
    );

    if (interrupt?.status === "interrupted") {
      return {
        status: "interrupted",
        signal,
        interrupt,
        safeMessage:
          "Active attempt was interrupted. Safe execution will resume through continuation.",
      };
    }

    return {
      status: "accepted_as_next_safe_point",
      signal,
      safeMessage:
        "Guidance was stored durably. No interruptible active attempt was available, so it will be delivered at the next safe continuation point.",
    };
  }
}
