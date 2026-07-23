import type {
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  ProviderFailure,
} from "@vioxen/subscription-runtime/core";
import { isAbortLikeError } from "../domain/app-server-errors";
import { CodexAppServerTurnError } from "./app-server-client";

export async function assertManagedRunCanResume(input: {
  readonly runStore: ManagedRunStorePort;
  readonly runId: string;
  readonly requestId: string;
  readonly resumeHandle: ManagedRunResumeHandle;
  readonly workspacePath: string;
}): Promise<void> {
  const threadId = input.resumeHandle.threadId;
  if (!threadId) throw new Error("codex_managed_run_thread_missing");
  if (input.resumeHandle.providerId !== "codex") {
    throw new Error("codex_managed_run_provider_mismatch");
  }
  if (
    input.resumeHandle.agentId !== undefined &&
    input.resumeHandle.agentId !== "codex-json"
  ) {
    throw new Error("codex_managed_run_agent_mismatch");
  }
  if (input.resumeHandle.runId !== input.runId) {
    throw new Error("codex_managed_run_resume_handle_mismatch");
  }
  if (input.resumeHandle.workspacePath !== input.workspacePath) {
    throw new Error("codex_managed_run_workspace_mismatch");
  }
  const current = await input.runStore.get({ runId: input.runId });
  if (!current || current.status !== "waiting_for_input") {
    throw new Error("codex_managed_run_not_waiting_for_input");
  }
  if (current.request?.id !== input.requestId) {
    throw new Error("codex_managed_run_request_mismatch");
  }
  if (
    current.resumeHandle?.runId !== input.runId ||
    current.resumeHandle.threadId !== threadId ||
    current.resumeHandle.workspacePath !== input.workspacePath
  ) {
    throw new Error("codex_managed_run_resume_handle_mismatch");
  }
}

export async function failManagedRunForProviderOutput(input: {
  readonly goalMode: boolean | undefined;
  readonly runId: string | undefined;
  readonly runStore: ManagedRunStorePort;
}): Promise<void> {
  if (!input.goalMode || !input.runId) return;
  await input.runStore
    .fail({
      runId: input.runId,
      failure: {
        code: "provider_output_invalid",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex provider output was invalid.",
      },
      now: new Date(),
    })
    .catch(() => undefined);
}

export function managedRunFailureFromError(error: unknown): ProviderFailure {
  const details =
    error instanceof CodexAppServerTurnError ? error.details() : undefined;
  if (isAbortLikeError(error)) {
    return {
      code: "task_cancelled",
      retryable: false,
      reconnectRequired: false,
      safeMessage: "Codex managed run resume was cancelled.",
      ...(details === undefined ? {} : { details }),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) {
    return {
      code: "task_timeout",
      retryable: true,
      reconnectRequired: false,
      safeMessage: "Codex managed run resume timed out.",
      ...(details === undefined ? {} : { details }),
    };
  }
  return {
    code: "unknown_runtime_failure",
    retryable: true,
    reconnectRequired: false,
    safeMessage: "Codex managed run resume failed.",
    ...(details === undefined ? {} : { details }),
  };
}

export function isManagedRunResumeValidationError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("codex_managed_run_")
  );
}
