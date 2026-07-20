import type {
  WorkerControlContinuationBatch,
  WorkerControlContinuationSource,
  WorkerControlTarget,
} from "../../control";
import {
  defaultSafeExecutionErrorClassifier,
  failureDetailsFromUnknown,
  normalizeSafeExecutionPolicy,
  prefixFailureDetails,
  runtimeInterruptClassification,
  safeExecutionAttemptMetadataFromError,
  safeExecutionFinalStatusForFailure,
  safeExecutionWaitingStatusForBlockedFailure,
  safeExecutionWaitingStatusForFailure,
  SafeExecutionError,
  shouldContinueSafeExecutionAfterFailure,
  shouldDeliverSafeExecutionControlForContinuation,
  withFailureDetails,
  type AttemptFailureReason,
} from "../domain/safe-execution-policy";
import type {
  ContinuationPacket,
  TaskRunId,
  WorkspaceSnapshot,
} from "../domain/safe-execution-task";
import type {
  ContinuationPacketBuilder,
  SafeExecutionRuntime,
  SafeExecutionWorkspaceAccess,
  WorkspaceSnapshotter,
} from "../ports/safe-execution-ports";
import { continuationJobFor } from "./continuation-job";
import { DefaultContinuationPacketBuilder } from "./default-continuation-packet-builder";
import {
  completeAttemptRecord,
  failedAttemptRecord,
  interruptedWorkspaceDetails,
  unavailableWorkspaceSnapshot,
  workspaceChanged,
} from "./safe-execution-attempt-records";
import type {
  SafeExecutionRunInput,
  SafeExecutionRunnerOptions,
  SafeExecutionRunResult,
} from "./safe-execution-runner-contracts";
import { systemClock, workspaceRunId } from "./safe-execution-workspace";

export class SafeExecutionRunner {
  private readonly snapshotter: WorkspaceSnapshotter;
  private readonly workspaceAccess: SafeExecutionWorkspaceAccess;
  private readonly runtime: SafeExecutionRuntime;
  private readonly continuationPacketBuilder: ContinuationPacketBuilder;
  private readonly ownerId: string;
  private readonly ownerPid: number | undefined;
  private readonly clock: { now(): Date };

  constructor(private readonly options: SafeExecutionRunnerOptions) {
    this.snapshotter = options.snapshotter ?? defaultSnapshotter;
    this.workspaceAccess = options.workspaceAccess ?? defaultWorkspaceAccess;
    this.runtime = options.runtime ?? defaultRuntime;
    this.continuationPacketBuilder =
      options.continuationPacketBuilder ??
      new DefaultContinuationPacketBuilder();
    this.ownerId = options.ownerId ?? this.runtime.createOwnerId();
    this.ownerPid = options.ownerPid ?? this.runtime.currentPid();
    this.clock = options.clock ?? systemClock;
  }

  async run<Job, Result>(
    input: SafeExecutionRunInput<Job, Result>,
  ): Promise<SafeExecutionRunResult<Result>> {
    validateRunInput(input);
    const workspacePath = await this.workspaceAccess.canonicalizePath({
      path: input.workspace.path,
    });
    const existing = await this.options.journal.readTask({
      taskId: input.taskId,
    });
    if (
      existing?.status === "completed" &&
      (!this.options.controlInbox || !input.controlContinuationJobFactory)
    ) {
      return {
        status: "completed",
        task: existing,
        result: existing.result as Result,
        attempts: existing.attempts,
        replayed: true,
      };
    }

    const lock = await this.options.lockStore.acquire({
      taskId: input.taskId,
      workspacePath,
      ownerId: this.ownerId,
      ...(this.ownerPid === undefined ? {} : { ownerPid: this.ownerPid }),
      ...(input.workspace.staleLockMs === undefined
        ? {}
        : { staleLockMs: input.workspace.staleLockMs }),
      now: this.clock.now(),
    });
    const controlDeliveries: DeferredWorkerControlDelivery[] = [];

    try {
      const firstAttemptNumber = (existing?.attempts.length ?? 0) + 1;
      let task = existing?.status === "completed"
        ? existing
        : await this.options.journal.startTask({
            taskId: input.taskId,
            workspaceRunId: workspaceRunId(workspacePath),
            workspacePath,
            effectMode: input.effectMode,
            provider: input.provider,
            now: this.clock.now(),
          });
      if (input.workspace.requireGitWorkspace) {
        try {
          await this.workspaceAccess.assertGitWorkspace({
            workspacePath,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
        } catch (error) {
          if (task.status === "completed") throw error;
          return this.failStartedTask({ input, error });
        }
      }
      if (existing?.status === "running" && existing.attempts.length === 0) {
        let snapshot: WorkspaceSnapshot;
        try {
          snapshot = await this.snapshotter.capture({
            workspacePath,
            includeDiff: true,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
        } catch (error) {
          return this.failStartedTask({ input, error });
        }
        if (snapshot.dirty) {
          const safeMessage =
            "Safe execution found an interrupted running task with unrecorded workspace changes.";
          const details = interruptedWorkspaceDetails(snapshot);
          task = await this.options.journal.markPartial({
            taskId: input.taskId,
            status: "partial",
            reason: "unknown_error",
            message: safeMessage,
            details,
            now: this.clock.now(),
          });
          return {
            status: "partial",
            task,
            attempts: task.attempts,
            reason: "unknown_error",
            safeMessage,
            failureDetails: details,
          };
        }
      }
      const policy = normalizeSafeExecutionPolicy(input);
      if (task.status === "completed" && task.effectMode === "external_side_effects") {
        return {
          status: "completed",
          task,
          result: task.result as Result,
          attempts: task.attempts,
          replayed: true,
        };
      }
      if (input.abortSignal?.aborted) {
        if (task.status === "completed") {
          return {
            status: "completed",
            task,
            result: task.result as Result,
            attempts: task.attempts,
            replayed: true,
          };
        }
        const aborted = await this.options.journal.markPartial({
          taskId: input.taskId,
          status: "aborted",
          reason: "user_abort",
          message: "Safe execution run was aborted before guidance delivery.",
          now: this.clock.now(),
        });
        return {
          status: "aborted",
          task: aborted,
          attempts: aborted.attempts,
          reason: "user_abort",
          safeMessage: "Safe execution run was aborted.",
        };
      }
      let startupBeforeSnapshot: WorkspaceSnapshot | undefined;
      if (task.status === "completed") {
        startupBeforeSnapshot = await this.snapshotter.capture({
          workspacePath,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        });
      }
      const startupControlAllowed =
        task.status === "completed" ||
        !task.lastFailureReason ||
        shouldDeliverSafeExecutionControlForContinuation(task.lastFailureReason);
      const startupControlBatch =
        startupControlAllowed &&
          this.options.controlInbox &&
          input.controlContinuationJobFactory
          ? await this.options.controlInbox.consumeForContinuation({
              target: input.controlTarget ?? {
                jobId: input.taskId,
                workspaceId: workspacePath,
              },
              deliveryAttemptId: `${input.taskId}:attempt-${firstAttemptNumber}`,
              ...(supportsDeferredControlDelivery(this.options.controlInbox)
                ? { deferDeliveryConfirmation: true }
                : {}),
              now: this.clock.now(),
            })
          : undefined;
      if (
        startupControlBatch &&
        startupControlBatch.signalIds.length > 0 &&
        supportsDeferredControlDelivery(this.options.controlInbox)
      ) {
        controlDeliveries.push(new DeferredWorkerControlDelivery({
          source: this.options.controlInbox,
          batch: startupControlBatch,
        }));
      }
      if (
        startupControlBatch &&
        startupControlBatch.signalIds.length > 0 &&
        !startupControlBatch.message
      ) {
        throw new SafeExecutionError(
          "safe_execution_invalid_task",
          "Worker control inbox returned deliverable signal ids without a continuation message.",
        );
      }
      const hasStartupControl = Boolean(
        startupControlBatch?.message && startupControlBatch.signalIds.length > 0,
      );
      let job = input.job;
      let effectiveOriginalPrompt = input.originalPrompt;
      let previousOutputSummary = task.outputSummary;
      const controlledStartup = hasStartupControl && startupControlBatch
        ? input.controlContinuationJobFactory?.({
            job,
            originalPrompt: effectiveOriginalPrompt,
            controlBatch: startupControlBatch,
            attemptNumber: firstAttemptNumber,
          })
        : undefined;
      if (hasStartupControl && !controlledStartup) {
        throw new SafeExecutionError(
          "safe_execution_invalid_task",
          "Safe execution cannot deliver pending startup guidance without a control continuation job factory.",
        );
      }
      if (task.status === "completed") {
        if (!hasStartupControl) {
          return {
            status: "completed",
            task,
            result: task.result as Result,
            attempts: task.attempts,
            replayed: true,
          };
        }
        task = await this.options.journal.startTask({
          taskId: input.taskId,
          workspaceRunId: workspaceRunId(workspacePath),
          workspacePath,
          effectMode: input.effectMode,
          provider: input.provider,
          now: this.clock.now(),
          resumeCompleted: true,
        });
      }

      if (
        task.attempts.length > 0 &&
        task.lastFailureReason &&
        policy.continuationMode !== "disabled"
      ) {
        let snapshot: WorkspaceSnapshot;
        try {
          snapshot = await this.snapshotter.capture({
            workspacePath,
            includeDiff: true,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
        } catch (error) {
          return this.failStartedTask({ input, error });
        }
        const packet = await this.buildContinuationPacket({
          taskId: input.taskId,
          attemptNumber: firstAttemptNumber,
          provider: input.provider,
          workspacePath,
          originalPrompt: input.originalPrompt,
          previousFailureReason: task.lastFailureReason,
          snapshot,
          ...(previousOutputSummary === undefined
            ? {}
            : { previousOutputSummary }),
          ...(input.controlTarget === undefined
            ? {}
            : { controlTarget: input.controlTarget }),
          ...(startupControlBatch === undefined
            ? {}
            : { controlBatch: startupControlBatch }),
          onDeferredControlDelivery: (delivery) =>
            controlDeliveries.push(delivery),
        });
        const continuationJob = continuationJobFor({
          factory: input.continuationJobFactory,
          job,
          continuationPacket: packet,
          attemptNumber: firstAttemptNumber,
        });
        if (!continuationJob) {
          const safeMessage =
            "Safe execution needs a prompt job or continuationJobFactory to resume a partial task.";
          const partial = await this.options.journal.markPartial({
            taskId: input.taskId,
            status: "partial",
            reason: task.lastFailureReason,
            message: safeMessage,
            ...(task.lastFailureDetails === undefined
              ? {}
              : { details: task.lastFailureDetails }),
            now: this.clock.now(),
          });
          return {
            status: "partial",
            task: partial,
            attempts: partial.attempts,
            reason: task.lastFailureReason,
            safeMessage,
            ...(task.lastFailureDetails === undefined
              ? {}
              : { failureDetails: task.lastFailureDetails }),
          };
        }
        job = continuationJob;
        effectiveOriginalPrompt =
          controlledStartup?.originalPrompt ?? input.originalPrompt;
      } else if (controlledStartup) {
        job = controlledStartup.job;
        effectiveOriginalPrompt = controlledStartup.originalPrompt;
      }

      const maxAttemptNumber =
        existing && hasStartupControl
          ? firstAttemptNumber + policy.maxAttempts - 1
          : policy.maxAttempts;
      for (
        let attemptNumber = firstAttemptNumber;
        attemptNumber <= maxAttemptNumber;
        attemptNumber += 1
      ) {
        if (input.abortSignal?.aborted) {
          const aborted = await this.options.journal.markPartial({
            taskId: input.taskId,
            status: "aborted",
            reason: "user_abort",
            message: "Safe execution run was aborted before the next attempt.",
            now: this.clock.now(),
          });
          return {
            status: "aborted",
            task: aborted,
            attempts: aborted.attempts,
            reason: "user_abort",
            safeMessage: "Safe execution run was aborted.",
          };
        }

        let before: WorkspaceSnapshot;
        try {
          before = attemptNumber === firstAttemptNumber && startupBeforeSnapshot
            ? startupBeforeSnapshot
            : await this.snapshotter.capture({
                workspacePath,
                ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
              });
        } catch (error) {
          return this.failStartedTask({ input, error });
        }
        const startedAt = this.clock.now();
        const attemptAbort = createAttemptAbortController(input.abortSignal);
        const attemptTarget = attemptControlTarget({
          input,
          workspacePath,
          attemptNumber,
        });
        const activeAttempt = this.options.activeAttemptRegistry?.register({
          taskId: input.taskId,
          attemptNumber,
          provider: input.provider,
          workspacePath,
          target: attemptTarget,
          startedAt,
          abortController: attemptAbort.controller,
        });

        try {
          const result = await input.pool.run(job, {
            idempotencyKey: `${input.taskId}:${attemptNumber}`,
            abortSignal: attemptAbort.controller.signal,
            ...(controlDeliveries.length === 0
              ? {}
              : {
                  onProviderTaskStarted: () =>
                    Promise.all(
                      controlDeliveries.map((delivery) => delivery.confirm()),
                    ).then(() => undefined),
                }),
            retryPolicy: {
              maxAttempts: 1,
              retryOnSlotCapacityUnavailable: false,
            },
          });
          await Promise.all(
            controlDeliveries.map((delivery) => delivery.confirm()),
          );
          const after = await this.snapshotter
            .capture({
              workspacePath,
              ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            })
            .catch((error) =>
              unavailableWorkspaceSnapshot({ workspacePath, error }),
            );
          previousOutputSummary = input.summarizeResult?.(result);
          const usage = input.attemptUsage?.(result);
          const metadata = input.attemptMetadata?.({ result });
          const attempt = completeAttemptRecord({
            input,
            attemptNumber,
            startedAt,
            finishedAt: this.clock.now(),
            before,
            after,
            ...(metadata === undefined ? {} : { metadata }),
            ...(usage === undefined ? {} : { usage }),
            ...(previousOutputSummary === undefined
              ? {}
              : { outputSummary: previousOutputSummary }),
          });
          task = await this.options.journal.appendAttempt({
            taskId: input.taskId,
            attempt,
            now: this.clock.now(),
          });
          task = await this.options.journal.completeTask({
            taskId: input.taskId,
            result,
            ...(previousOutputSummary === undefined
              ? {}
              : { outputSummary: previousOutputSummary }),
            now: this.clock.now(),
          });
          return {
            status: "completed",
            task,
            result,
            attempts: task.attempts,
            replayed: false,
          };
        } catch (error) {
          let afterCaptureError: unknown;
          const after = await this.snapshotter
            .capture({
              workspacePath,
              includeDiff: true,
              ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            })
            .catch((error) => {
              afterCaptureError = error;
              return unavailableWorkspaceSnapshot({ workspacePath, error });
            });
          const runtimeInterrupt = runtimeInterruptClassification(
            attemptAbort.controller.signal.reason,
          );
          const classification = withFailureDetails(
            runtimeInterrupt ??
              input.classifyError?.(error) ??
              defaultSafeExecutionErrorClassifier(error),
            afterCaptureError === undefined
              ? undefined
              : prefixFailureDetails(
                  "workspaceSnapshot",
                  failureDetailsFromUnknown(afterCaptureError),
                ),
          );
          const errorSummary = input.summarizeError?.(error);
          const errorOutputSummary = input.summarizeErrorOutput?.(error);
          const failureMessage = errorSummary ?? classification.safeMessage;
          const attempt = failedAttemptRecord({
            input,
            attemptNumber,
            startedAt,
            finishedAt: this.clock.now(),
            before,
            after,
            classification,
            failureMessage,
            metadata:
              input.attemptMetadata?.({ error }) ??
              safeExecutionAttemptMetadataFromError(error),
          });
          task = await this.options.journal.appendAttempt({
            taskId: input.taskId,
            attempt,
            now: this.clock.now(),
          });

          const changed = workspaceChanged(before, after);
          const canContinue = shouldContinueSafeExecutionAfterFailure({
            classification,
            policy,
            effectMode: input.effectMode,
            workspaceChanged: changed,
            attemptsRemaining: attemptNumber < maxAttemptNumber,
          });

          if (!canContinue.allowed) {
            const status =
              safeExecutionWaitingStatusForBlockedFailure({
                reason: classification.reason,
                workspaceChanged: changed,
              }) ?? safeExecutionFinalStatusForFailure(classification.reason);
            task = await this.options.journal.markPartial({
              taskId: input.taskId,
              status,
              reason: classification.reason,
              message: canContinue.safeMessage ?? failureMessage,
              ...(classification.details === undefined
                ? {}
                : { details: classification.details }),
              now: this.clock.now(),
            });
            return {
              status,
              task,
              attempts: task.attempts,
              reason: classification.reason,
              safeMessage: canContinue.safeMessage ?? failureMessage,
              ...(classification.details === undefined
                ? {}
                : { failureDetails: classification.details }),
              error,
            };
          }

          const continuationOutputSummary =
            previousOutputSummary ??
            (classification.reason === "goal_slice_exhausted"
              ? errorOutputSummary
              : undefined);
          const packet = await this.buildContinuationPacket({
            taskId: input.taskId,
            attemptNumber: attemptNumber + 1,
            provider: input.provider,
            workspacePath,
            originalPrompt: effectiveOriginalPrompt,
            previousFailureReason: classification.reason,
            snapshot: after,
            ...(continuationOutputSummary === undefined
              ? {}
              : { previousOutputSummary: continuationOutputSummary }),
            ...(input.controlTarget === undefined
              ? {}
              : { controlTarget: input.controlTarget }),
            onDeferredControlDelivery: (delivery) =>
              controlDeliveries.push(delivery),
          });
          const continuationJob = continuationJobFor({
            factory: input.continuationJobFactory,
            job,
            continuationPacket: packet,
            attemptNumber: attemptNumber + 1,
          });
          if (!continuationJob) {
            const safeMessage =
              "Safe execution needs a prompt job or continuationJobFactory before retrying a partial workspace.";
            task = await this.options.journal.markPartial({
              taskId: input.taskId,
              status: "partial",
              reason: classification.reason,
              message: safeMessage,
              ...(classification.details === undefined
                ? {}
                : { details: classification.details }),
              now: this.clock.now(),
            });
            return {
              status: "partial",
              task,
              attempts: task.attempts,
              reason: classification.reason,
              safeMessage,
              ...(classification.details === undefined
                ? {}
                : { failureDetails: classification.details }),
              error,
            };
          }
          job = continuationJob;
        } finally {
          activeAttempt?.release();
          attemptAbort.dispose();
        }
      }

      const exhausted = await this.options.journal.markPartial({
        taskId: input.taskId,
        status:
          safeExecutionWaitingStatusForFailure(task.lastFailureReason) ??
          "partial",
        reason: task.lastFailureReason ?? "unknown_error",
        message: "Safe execution exhausted all configured attempts.",
        ...(task.lastFailureDetails === undefined
          ? {}
          : { details: task.lastFailureDetails }),
        now: this.clock.now(),
      });
      return {
        status:
          safeExecutionWaitingStatusForFailure(exhausted.lastFailureReason) ??
          "partial",
        task: exhausted,
        attempts: exhausted.attempts,
        reason: exhausted.lastFailureReason ?? "unknown_error",
        safeMessage: "Safe execution exhausted all configured attempts.",
        ...(exhausted.lastFailureDetails === undefined
          ? {}
          : { failureDetails: exhausted.lastFailureDetails }),
      };
    } finally {
      try {
        // A stale accepted claim is repairable; never mask the primary run
        // result when best-effort claim release itself is unavailable.
        await Promise.allSettled(
          controlDeliveries.map((delivery) => delivery.release()),
        );
      } finally {
        await lock.release();
      }
    }
  }

  private async failStartedTask<Job, Result>(input: {
    readonly input: SafeExecutionRunInput<Job, Result>;
    readonly error: unknown;
  }): Promise<SafeExecutionRunResult<Result>> {
    const classification = defaultSafeExecutionErrorClassifier(input.error);
    const failureMessage =
      input.input.summarizeError?.(input.error) ?? classification.safeMessage;
    const status = safeExecutionFinalStatusForFailure(classification.reason);
    const task = await this.options.journal.markPartial({
      taskId: input.input.taskId,
      status,
      reason: classification.reason,
      message: failureMessage,
      ...(classification.details === undefined
        ? {}
        : { details: classification.details }),
      now: this.clock.now(),
    });
    return {
      status,
      task,
      attempts: task.attempts,
      reason: classification.reason,
      safeMessage: failureMessage,
      ...(classification.details === undefined
        ? {}
        : { failureDetails: classification.details }),
      error: input.error,
    };
  }

  private async buildContinuationPacket(input: {
    readonly taskId: TaskRunId;
    readonly attemptNumber: number;
    readonly provider: string;
    readonly workspacePath: string;
    readonly originalPrompt: string;
    readonly previousFailureReason: AttemptFailureReason;
    readonly snapshot: WorkspaceSnapshot;
    readonly previousOutputSummary?: string;
    readonly controlTarget?: WorkerControlTarget;
    readonly controlBatch?: WorkerControlContinuationBatch;
    readonly onDeferredControlDelivery?: (
      delivery: DeferredWorkerControlDelivery,
    ) => void;
  }): Promise<ContinuationPacket> {
    let controlBatch = input.controlBatch;
    if (
      controlBatch === undefined &&
      this.options.controlInbox &&
      shouldDeliverSafeExecutionControlForContinuation(
        input.previousFailureReason,
      )
    ) {
      const deferred = supportsDeferredControlDelivery(this.options.controlInbox);
      controlBatch = await this.options.controlInbox.consumeForContinuation({
        target: input.controlTarget ?? {
          jobId: input.taskId,
          workspaceId: input.workspacePath,
        },
        deliveryAttemptId: `${input.taskId}:attempt-${input.attemptNumber}`,
        ...(deferred ? { deferDeliveryConfirmation: true } : {}),
        now: this.clock.now(),
      });
      if (deferred && controlBatch.signalIds.length > 0) {
        input.onDeferredControlDelivery?.(
          new DeferredWorkerControlDelivery({
            source: this.options.controlInbox,
            batch: controlBatch,
          }),
        );
      }
    }
    return this.continuationPacketBuilder.build({
      taskId: input.taskId,
      attemptNumber: input.attemptNumber,
      provider: input.provider,
      workspacePath: input.workspacePath,
      originalPrompt: input.originalPrompt,
      previousFailureReason: input.previousFailureReason,
      snapshot: input.snapshot,
      ...(input.previousOutputSummary === undefined
        ? {}
        : { previousOutputSummary: input.previousOutputSummary }),
      ...(controlBatch === undefined ? {} : { controlBatch }),
    });
  }
}

function supportsDeferredControlDelivery(
  source: WorkerControlContinuationSource | undefined,
): source is WorkerControlContinuationSource & {
  confirmContinuationDelivery(input: {
    readonly batch: WorkerControlContinuationBatch;
    readonly now?: Date;
  }): Promise<void>;
  releaseContinuationDelivery(input: {
    readonly batch: WorkerControlContinuationBatch;
  }): Promise<void>;
} {
  return Boolean(
    source?.supportsDeferredDeliveryConfirmation === true &&
      source.confirmContinuationDelivery &&
      source.releaseContinuationDelivery,
  );
}

class DeferredWorkerControlDelivery {
  private state: "claimed" | "confirmed" | "released" = "claimed";

  constructor(
    private readonly input: {
      readonly source: WorkerControlContinuationSource & {
        confirmContinuationDelivery(input: {
          readonly batch: WorkerControlContinuationBatch;
          readonly now?: Date;
        }): Promise<void>;
        releaseContinuationDelivery(input: {
          readonly batch: WorkerControlContinuationBatch;
        }): Promise<void>;
      };
      readonly batch: WorkerControlContinuationBatch;
    },
  ) {}

  async confirm(): Promise<void> {
    if (this.state !== "claimed") return;
    await this.input.source.confirmContinuationDelivery({
      batch: this.input.batch,
    });
    this.state = "confirmed";
  }

  async release(): Promise<void> {
    if (this.state !== "claimed") return;
    await this.input.source.releaseContinuationDelivery({
      batch: this.input.batch,
    });
    this.state = "released";
  }
}

function attemptControlTarget<Job, Result>(input: {
  readonly input: SafeExecutionRunInput<Job, Result>;
  readonly workspacePath: string;
  readonly attemptNumber: number;
}): WorkerControlTarget {
  const base = input.input.controlTarget ?? {
    jobId: input.input.taskId,
    workspaceId: input.workspacePath,
  };
  return {
    ...base,
    taskId: base.taskId ?? input.input.taskId,
    workspaceId: base.workspaceId ?? input.workspacePath,
    attemptId:
      base.attemptId ?? `${input.input.taskId}:attempt-${input.attemptNumber}`,
  };
}

function createAttemptAbortController(parent: AbortSignal | undefined): {
  readonly controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  if (!parent) return { controller, dispose: () => undefined };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parent.reason);
    }
  };
  if (parent.aborted) {
    abort();
    return { controller, dispose: () => undefined };
  }
  parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    dispose: () => parent.removeEventListener("abort", abort),
  };
}

function validateRunInput<Job, Result>(
  input: SafeExecutionRunInput<Job, Result>,
): void {
  if (!input.taskId.trim()) {
    throw new SafeExecutionError(
      "safe_execution_invalid_task",
      "Safe execution taskId is required.",
    );
  }
  if (!input.workspace.path.trim()) {
    throw new SafeExecutionError(
      "safe_execution_invalid_task",
      "Safe execution workspace path is required.",
    );
  }
  if (!input.provider.trim()) {
    throw new SafeExecutionError(
      "safe_execution_invalid_task",
      "Safe execution provider is required.",
    );
  }
  if (
    input.effectMode === "external_side_effects" &&
    normalizeSafeExecutionPolicy(input).maxAttempts > 1
  ) {
    throw new SafeExecutionError(
      "safe_execution_external_retry_disabled",
      "Safe execution does not retry external side effects by default.",
    );
  }
}

const defaultWorkspaceAccess: SafeExecutionWorkspaceAccess = {
  async canonicalizePath(input): Promise<string> {
    return input.path;
  },
  async assertGitWorkspace(input): Promise<void> {
    throw new SafeExecutionError(
      "safe_execution_workspace_not_git",
      "Safe execution requires a git worktree workspace.",
      { details: { workspacePath: input.workspacePath } },
    );
  },
};

const defaultRuntime: SafeExecutionRuntime = {
  createOwnerId(): string {
    return `safe-execution:${Date.now().toString(36)}`;
  },
  currentPid(): number | undefined {
    return undefined;
  },
};

const defaultSnapshotter: WorkspaceSnapshotter = {
  async capture(input): Promise<WorkspaceSnapshot> {
    const capturedAt = new Date();
    return {
      mode: "unavailable",
      workspacePath: input.workspacePath,
      capturedAt,
      dirty: false,
      changedFiles: [],
      fingerprint: `unconfigured:${input.workspacePath}:${capturedAt.toISOString()}`,
      summary: "Workspace snapshotter was not configured.",
      warnings: ["workspace_snapshotter_unconfigured"],
    };
  },
};
