import type {
  ActiveAttemptInterruptResult,
  ActiveAttemptLease,
  ActiveAttemptRecord,
  ActiveAttemptRegistry,
  RuntimeInterruptReason,
  WorkerControlTarget,
} from "./types";
import { workerControlTargetMatches } from "./worker-control-service";

type RegisteredActiveAttempt = ActiveAttemptRecord & {
  readonly abortController: AbortController;
};

export class InMemoryActiveAttemptRegistry implements ActiveAttemptRegistry {
  private readonly attempts = new Map<string, RegisteredActiveAttempt>();

  register(input: RegisteredActiveAttempt): ActiveAttemptLease {
    const key = activeAttemptKey(input.target);
    this.attempts.set(key, input);
    return {
      attempt: activeAttemptRecord(input),
      release: () => {
        const current = this.attempts.get(key);
        if (
          current?.taskId === input.taskId &&
          current.attemptNumber === input.attemptNumber
        ) {
          this.attempts.delete(key);
        }
      },
    };
  }

  get(target: WorkerControlTarget): ActiveAttemptRecord | null {
    const direct = this.attempts.get(activeAttemptKey(target));
    if (direct) return activeAttemptRecord(direct);
    for (const attempt of this.attempts.values()) {
      if (workerControlTargetMatches(target, attempt.target)) {
        return activeAttemptRecord(attempt);
      }
    }
    return null;
  }

  interrupt(
    target: WorkerControlTarget,
    reason: RuntimeInterruptReason,
  ): ActiveAttemptInterruptResult {
    const attempt = this.find(target);
    if (!attempt) {
      return {
        status: "not_found",
        safeMessage: "No active attempt is registered for this target.",
      };
    }
    if (!attempt.abortController.signal.aborted) {
      attempt.abortController.abort(reason);
    }
    return {
      status: "interrupted",
      attempt: activeAttemptRecord(attempt),
    };
  }

  private find(target: WorkerControlTarget): RegisteredActiveAttempt | null {
    const direct = this.attempts.get(activeAttemptKey(target));
    if (direct) return direct;
    for (const attempt of this.attempts.values()) {
      if (workerControlTargetMatches(target, attempt.target)) return attempt;
    }
    return null;
  }
}

function activeAttemptKey(target: WorkerControlTarget): string {
  return [
    target.jobId,
    target.taskId ?? "",
    target.workerId ?? "",
    target.attemptId ?? "",
    target.providerSessionId ?? "",
    target.workspaceId ?? "",
  ].join("\0");
}

function activeAttemptRecord(input: ActiveAttemptRecord): ActiveAttemptRecord {
  return {
    taskId: input.taskId,
    attemptNumber: input.attemptNumber,
    provider: input.provider,
    workspacePath: input.workspacePath,
    target: input.target,
    startedAt: input.startedAt,
  };
}
