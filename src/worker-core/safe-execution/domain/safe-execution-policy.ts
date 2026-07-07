import { isSubscriptionWorkerError } from "../../errors";

export type TaskEffectMode =
  | "read_only"
  | "workspace_patch"
  | "external_side_effects";

export type ContinuationMode = "packet_first" | "disabled";

export type SafeExecutionPolicy = {
  readonly retryOnCapacity?: boolean;
  readonly retryOnAccountUnavailable?: boolean;
  readonly retryOnReconnectRequired?: boolean;
  readonly retryUnknownCleanWorkspace?: boolean;
  readonly retryUnknownChangedWorkspace?: boolean;
  readonly maxAttempts?: number;
  readonly continuationMode?: ContinuationMode;
};

export type NormalizedSafeExecutionPolicy = Required<SafeExecutionPolicy>;

export const attemptFailureReasons = [
  "quota_limited",
  "capacity_unavailable",
  "account_unavailable",
  "reconnect_required",
  "permission_required",
  "task_timeout",
  "provider_output_invalid",
  "runtime_interrupted",
  "goal_slice_exhausted",
  "user_abort",
  "unknown_error",
] as const;

export type AttemptFailureReason = (typeof attemptFailureReasons)[number];

export type SafeExecutionErrorCode =
  | "safe_execution_invalid_task"
  | "safe_execution_workspace_locked"
  | "safe_execution_workspace_not_git"
  | "safe_execution_external_retry_disabled"
  | "safe_execution_continuation_disabled"
  | "safe_execution_attempts_exhausted";

export class SafeExecutionError extends Error {
  constructor(
    readonly code: SafeExecutionErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SafeExecutionError";
    this.details = options.details ?? {};
  }

  readonly details: Readonly<Record<string, string>>;
}

export function isSafeExecutionError(
  error: unknown,
): error is SafeExecutionError {
  return error instanceof SafeExecutionError;
}

export type SafeExecutionFailureClassification = {
  readonly reason: AttemptFailureReason;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string>>;
};

export type SafeExecutionContinuationDecision = {
  readonly allowed: boolean;
  readonly safeMessage?: string;
};

export function shouldReplaceSafeExecutionWorkspaceLock(input: {
  readonly acquiredAt: Date;
  readonly now: Date;
  readonly staleLockMs?: number;
  readonly ownerPid?: number;
  readonly ownerProcessAlive?: boolean;
}): boolean {
  if (input.ownerPid !== undefined && input.ownerProcessAlive === false) {
    return true;
  }
  if (input.staleLockMs === undefined) return false;
  if (input.now.getTime() - input.acquiredAt.getTime() < input.staleLockMs) {
    return false;
  }
  if (input.ownerPid === undefined) return false;
  return input.ownerProcessAlive === false;
}

export function normalizeSafeExecutionPolicy(input: {
  readonly policy?: SafeExecutionPolicy;
  readonly continuationMode?: ContinuationMode;
}): NormalizedSafeExecutionPolicy {
  const policy = input.policy ?? {};
  return {
    retryOnCapacity: policy.retryOnCapacity ?? true,
    retryOnAccountUnavailable: policy.retryOnAccountUnavailable ?? true,
    retryOnReconnectRequired: policy.retryOnReconnectRequired ?? true,
    retryUnknownCleanWorkspace: policy.retryUnknownCleanWorkspace ?? true,
    retryUnknownChangedWorkspace:
      policy.retryUnknownChangedWorkspace ?? false,
    maxAttempts: Math.max(1, policy.maxAttempts ?? 1),
    continuationMode:
      input.continuationMode ?? policy.continuationMode ?? "packet_first",
  };
}

export function shouldContinueSafeExecutionAfterFailure(input: {
  readonly classification: SafeExecutionFailureClassification;
  readonly policy: NormalizedSafeExecutionPolicy;
  readonly effectMode: TaskEffectMode;
  readonly workspaceChanged: boolean;
  readonly attemptsRemaining: boolean;
}): SafeExecutionContinuationDecision {
  if (!input.attemptsRemaining) {
    return {
      allowed: false,
      safeMessage: "Safe execution has no attempts remaining.",
    };
  }
  if (input.policy.continuationMode === "disabled") {
    return {
      allowed: false,
      safeMessage: "Safe execution continuation is disabled.",
    };
  }
  if (input.effectMode === "external_side_effects") {
    return {
      allowed: false,
      safeMessage: "Safe execution will not retry external side effects.",
    };
  }
  switch (input.classification.reason) {
    case "runtime_interrupted":
    case "goal_slice_exhausted":
      return { allowed: true };
    case "quota_limited":
    case "capacity_unavailable":
      return { allowed: input.policy.retryOnCapacity };
    case "account_unavailable":
      return { allowed: input.policy.retryOnAccountUnavailable };
    case "reconnect_required":
      return { allowed: input.policy.retryOnReconnectRequired };
    case "unknown_error":
    case "task_timeout":
    case "provider_output_invalid":
      if (input.workspaceChanged) {
        return {
          allowed:
            input.classification.reason === "unknown_error"
              ? input.policy.retryUnknownChangedWorkspace
              : false,
          ...(input.classification.reason !== "unknown_error"
            ? {
                safeMessage:
                  `Safe execution stopped after ${input.classification.reason} changed the workspace.`,
              }
            : input.policy.retryUnknownChangedWorkspace
            ? {}
            : {
                safeMessage:
                  "Safe execution stopped after an unknown error changed the workspace.",
              }),
        };
      }
      return {
        allowed:
          input.classification.reason === "unknown_error"
            ? input.policy.retryUnknownCleanWorkspace
            : true,
      };
    case "permission_required":
    case "user_abort":
      return { allowed: false };
  }
}

export function safeExecutionFinalStatusForFailure(
  reason: AttemptFailureReason,
): "partial" | "failed" | "aborted" {
  if (reason === "user_abort") return "aborted";
  if (
    reason === "unknown_error" ||
    reason === "permission_required" ||
    reason === "provider_output_invalid"
  ) {
    return "failed";
  }
  return "partial";
}

export function safeExecutionWaitingStatusForFailure(
  reason: AttemptFailureReason | undefined,
): "waiting_capacity" | null {
  return reason === "quota_limited" ||
    reason === "capacity_unavailable" ||
    reason === "account_unavailable" ||
    reason === "reconnect_required"
    ? "waiting_capacity"
    : null;
}

export function safeExecutionWaitingStatusForBlockedFailure(input: {
  readonly reason: AttemptFailureReason;
  readonly workspaceChanged: boolean;
}): "waiting_capacity" | null {
  if (input.workspaceChanged) return null;
  return safeExecutionWaitingStatusForFailure(input.reason);
}

export function shouldDeliverSafeExecutionControlForContinuation(
  previousFailureReason: AttemptFailureReason,
): boolean {
  return (
    previousFailureReason !== "account_unavailable" &&
    previousFailureReason !== "reconnect_required"
  );
}

export function runtimeInterruptClassification(
  reason: unknown,
): SafeExecutionFailureClassification | null {
  if (!isRuntimeInterruptReason(reason)) return null;
  return {
    reason: "runtime_interrupted",
    safeMessage: reason.safeMessage,
    retryable: true,
    details: {
      runtimeControl: "interrupt_then_continue",
      ...(reason.signalId === undefined ? {} : { signalId: reason.signalId }),
      ...(reason.requestedBy === undefined
        ? {}
        : { requestedBy: reason.requestedBy }),
    },
  };
}

export function defaultSafeExecutionErrorClassifier(
  error: unknown,
): SafeExecutionFailureClassification {
  const chain = errorChain(error);
  for (const item of chain) {
    if (!isSubscriptionWorkerError(item)) continue;
    if (item.code === "subscription_worker_pool_run_aborted") {
      return {
        reason: "user_abort",
        safeMessage: item.message,
        retryable: false,
      };
    }
    if (item.code === "subscription_worker_pool_capacity_unavailable") {
      return {
        reason: "capacity_unavailable",
        safeMessage: item.message,
        retryable: true,
        details: item.details,
      };
    }
    if (item.code === "subscription_worker_account_unavailable") {
      return {
        reason: "account_unavailable",
        safeMessage: item.message,
        retryable: true,
        details: item.details,
      };
    }
    const classified = classifyWorkerFailureCode(
      item.details.reason ?? item.details.code,
      item.message,
      unknownFailureDetails(chain, item.details),
    );
    if (classified) return classified;
  }

  const messages = chain.map(safeExecutionErrorMessage);
  const message = messages.find((candidate) => candidate.trim()) ?? "";
  const authInvalidMessage = messages.find((candidate) =>
    /refresh_token_invalidated|token_invalidated|refresh token (?:was )?revoked|session has ended|log (?:out|in) and sign in again|access token could not be refreshed|401 unauthorized/i.test(
      candidate,
    ),
  );
  if (authInvalidMessage) {
    return {
      reason: "account_unavailable",
      safeMessage: "Provider account session is unavailable.",
      retryable: true,
    };
  }
  if (messages.some((candidate) => /abort/i.test(candidate))) {
    return {
      reason: "user_abort",
      safeMessage: message,
      retryable: false,
    };
  }
  const quotaMessage = messages.find((candidate) =>
    /quota|rate limit|allowance/i.test(candidate),
  );
  if (quotaMessage) {
    return {
      reason: "quota_limited",
      safeMessage: quotaMessage,
      retryable: true,
    };
  }
  const timeoutMessage = messages.find((candidate) =>
    /\btimeout\b|\btimed out\b/i.test(candidate),
  );
  if (timeoutMessage) {
    return {
      reason: "task_timeout",
      safeMessage: timeoutMessage,
      retryable: true,
    };
  }
  const rawDetails = unknownFailureDetails(chain);
  const backendUnavailableMessage = [
    ...messages,
    rawDetails?.rawCause,
    rawDetails?.stderrTail,
    rawDetails?.stdoutTail,
  ].find((candidate) => isBackendUnavailableMessage(candidate));
  if (backendUnavailableMessage) {
    return {
      reason: "capacity_unavailable",
      safeMessage: "Codex app-server goal backend is temporarily blocked.",
      retryable: true,
      ...optionalFailureDetails(rawDetails),
    };
  }
  const invalidOutputMessage = messages.find((candidate) =>
    /final_message_missing|structured_output_invalid|output_too_large|provider output was invalid/i.test(
      candidate,
    ),
  );
  if (invalidOutputMessage) {
    return {
      reason: "provider_output_invalid",
      safeMessage: invalidOutputMessage,
      retryable: true,
    };
  }
  const goalSliceMessage = messages.find((candidate) =>
    /goal slice exhausted/i.test(candidate),
  );
  if (goalSliceMessage) {
    return {
      reason: "goal_slice_exhausted",
      safeMessage: goalSliceMessage,
      retryable: true,
    };
  }
  return {
    reason: "unknown_error",
    safeMessage: message,
    retryable: false,
    ...optionalFailureDetails(rawDetails),
  };
}

export function safeExecutionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failureDetailsFromUnknown(
  error: unknown,
): Readonly<Record<string, string>> | undefined {
  return unknownFailureDetails(errorChain(error));
}

export function safeExecutionAttemptMetadataFromError(error: unknown): {
  readonly workerId?: string;
  readonly accountId?: string;
} {
  let workerId: string | undefined;
  let accountId: string | undefined;
  for (const item of errorChain(error)) {
    if (!isSubscriptionWorkerError(item)) continue;
    workerId = workerId ?? item.details.workerId;
    accountId = accountId ?? item.details.accountId;
  }
  return {
    ...(workerId === undefined ? {} : { workerId }),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

export function withFailureDetails(
  classification: SafeExecutionFailureClassification,
  details: Readonly<Record<string, string>> | undefined,
): SafeExecutionFailureClassification {
  const merged = mergeFailureDetails(classification.details, details);
  return merged === undefined ? classification : { ...classification, details: merged };
}

export function prefixFailureDetails(
  prefix: string,
  details: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [`${prefix}.${key}`, value]),
  );
}

export function safeExecutionDetailTail(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 1000 ? compact.slice(-1000) : compact;
}

function isRuntimeInterruptReason(
  value: unknown,
): value is {
  readonly code: "runtime_controlled_interrupt";
  readonly safeMessage: string;
  readonly signalId?: string;
  readonly requestedBy?: string;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.code === "runtime_controlled_interrupt" &&
    typeof record.safeMessage === "string"
  );
}

function isBackendUnavailableMessage(value: string | undefined): boolean {
  return (
    value !== undefined &&
    /codex_app_server_goal_blocked|app-server goal backend is temporarily blocked/i.test(
      value,
    )
  );
}

function classifyWorkerFailureCode(
  code: string | undefined,
  safeMessage: string,
  details?: Readonly<Record<string, string>>,
): SafeExecutionFailureClassification | null {
  switch (code) {
    case "quota_limited":
      return {
        reason: "quota_limited",
        safeMessage,
        retryable: true,
      };
    case "provider_reconnect_required":
    case "needs_reconnect":
      return {
        reason: "reconnect_required",
        safeMessage,
        retryable: true,
      };
    case "provider_session_invalid":
      return {
        reason: "account_unavailable",
        safeMessage,
        retryable: true,
      };
    case "backend_unavailable":
      return {
        reason: "capacity_unavailable",
        safeMessage,
        retryable: true,
        ...optionalFailureDetails(details),
      };
    case "permission_required":
      return {
        reason: "permission_required",
        safeMessage,
        retryable: false,
      };
    case "task_cancelled":
      return {
        reason: "user_abort",
        safeMessage,
        retryable: false,
      };
    case "runtime_interrupted":
      return {
        reason: "runtime_interrupted",
        safeMessage,
        retryable: true,
        ...optionalFailureDetails(details),
      };
    case "goal_slice_exhausted":
      return {
        reason: "goal_slice_exhausted",
        safeMessage,
        retryable: true,
        ...optionalFailureDetails(details),
      };
    case "task_timeout":
      return {
        reason: "task_timeout",
        safeMessage,
        retryable: true,
      };
    case "provider_output_invalid":
      return {
        reason: "provider_output_invalid",
        safeMessage,
        retryable: true,
      };
    case "unknown_runtime_failure":
      return {
        reason: "unknown_error",
        safeMessage,
        retryable: true,
        ...optionalFailureDetails(details),
      };
    default:
      return null;
  }
}

function errorChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current =
      current instanceof Error
        ? (current as Error & { cause?: unknown }).cause
        : undefined;
  }
  return chain;
}

function unknownFailureDetails(
  chain: readonly unknown[],
  baseDetails?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const details: Record<string, string> = {};
  mergeStringDetails(details, baseDetails);

  const messages: string[] = [];
  for (const item of chain) {
    const message = safeExecutionErrorMessage(item);
    if (message.trim()) messages.push(message);
    if (isSafeExecutionError(item)) {
      details.safeExecutionCode = item.code;
      mergeStringDetails(details, item.details);
    }
    if (isSubscriptionWorkerError(item)) {
      details.subscriptionWorkerCode ??= item.code;
      mergeStringDetails(details, item.details);
    }
    mergeStringDetails(details, processFailureDetails(item, message));
  }

  if (details.rawCause === undefined && messages.length > 0) {
    details.rawCause = safeExecutionDetailTail(messages.join(" <- "));
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

function processFailureDetails(
  error: unknown,
  message: string,
): Readonly<Record<string, string>> | undefined {
  const details: Record<string, string> = {};
  if (typeof error === "object" && error !== null) {
    const record = error as {
      readonly exitCode?: unknown;
      readonly stdout?: unknown;
      readonly stderr?: unknown;
    };
    if (typeof record.exitCode === "number" && Number.isInteger(record.exitCode)) {
      details.exitCode = String(record.exitCode);
    }
    if (typeof record.stderr === "string" && record.stderr.trim()) {
      details.stderrTail = safeExecutionDetailTail(record.stderr);
    }
    if (typeof record.stdout === "string" && record.stdout.trim()) {
      details.stdoutTail = safeExecutionDetailTail(record.stdout);
    }
  }

  const match =
    /\b(?:node_process_runner_failed|codex_json_exec_failed|codex_cli_exec_failed):(\d+):(.*)$/s.exec(
      message,
    );
  if (match) {
    details.exitCode ??= match[1]!;
    if (match[2]?.trim()) {
      details.stderrTail ??= safeExecutionDetailTail(match[2]);
    }
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

function mergeStringDetails(
  target: Record<string, string>,
  source: Readonly<Record<string, string>> | undefined,
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    target[key] ??= safeExecutionDetailTail(value);
  }
}

function mergeFailureDetails(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  const merged: Record<string, string> = {};
  mergeStringDetails(merged, left);
  mergeStringDetails(merged, right);
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function optionalFailureDetails(
  details: Readonly<Record<string, string>> | undefined,
): { readonly details?: Readonly<Record<string, string>> } {
  return details === undefined || Object.keys(details).length === 0
    ? {}
    : { details };
}
