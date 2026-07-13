import type { ProviderFailure } from "@vioxen/subscription-runtime/core";
import { classifyCodexRuntimeFailure } from "./codex-cli-domain";
import { isCodexModelUnavailableError } from "./app-server/domain/model-catalog";

export function classifyCodexFailure(error: unknown): ProviderFailure {
  if (isCodexModelUnavailableError(error)) {
    return {
      code: "model_unavailable",
      retryable: true,
      reconnectRequired: false,
      safeMessage: error.message,
      causeCategory: "model_unavailable",
      details: error.details(),
    };
  }
  const message = codexFailureMessage(error);
  const state = classifyCodexRuntimeFailure(message);
  const details = codexFailureDetails(error, message);

  switch (state) {
    case "task_cancelled":
      return {
        code: "task_cancelled",
        retryable: false,
        reconnectRequired: false,
        safeMessage: "Codex task was cancelled.",
        causeCategory: state,
      };
    case "task_timeout":
      return {
        code: "task_timeout",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex task timed out.",
        causeCategory: state,
      };
    case "provider_output_invalid":
      return {
        code: "provider_output_invalid",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex provider output was invalid.",
        causeCategory: state,
      };
    case "needs_reconnect":
      return {
        code: "needs_reconnect",
        retryable: false,
        reconnectRequired: true,
        safeMessage: "Codex session needs reconnect.",
        causeCategory: state,
      };
    case "provider_session_invalid":
      return {
        code: "provider_session_invalid",
        retryable: false,
        reconnectRequired: true,
        safeMessage: "Codex session is invalid.",
        causeCategory: state,
      };
    case "quota_limited":
      return {
        code: "quota_limited",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex quota or billing limit was reached.",
        causeCategory: state,
      };
    case "backend_unavailable":
      return {
        code: "backend_unavailable",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex app-server goal backend is temporarily blocked.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "goal_slice_exhausted":
      return {
        code: "goal_slice_exhausted",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex app-server goal slice exhausted.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
    case "permission_required":
      return {
        code: "permission_required",
        retryable: false,
        reconnectRequired: false,
        safeMessage: "Codex permission is required.",
        causeCategory: state,
      };
    default:
      return {
        code: "unknown_runtime_failure",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex runtime failed.",
        causeCategory: state,
        ...(details === undefined ? {} : { details }),
      };
  }
}

function codexFailureMessage(error: unknown): string {
  const process = processFailureLike(error);
  if (process) return `${process.stdout ?? ""}\n${process.stderr ?? ""}`;
  return error instanceof Error ? error.message : String(error);
}

function codexFailureDetails(
  error: unknown,
  message: string,
): Readonly<Record<string, string>> | undefined {
  const details: Record<string, string> = {};
  const process = processFailureLike(error);
  if (process?.exitCode !== undefined) {
    details.exitCode = String(process.exitCode);
  }
  if (process?.stderr) {
    details.stderrTail = safeTail(process.stderr);
  }
  if (process?.stdout) {
    details.stdoutTail = safeTail(process.stdout);
  }
  const lastOutputText = lastOutputTextFromError(error);
  if (lastOutputText) {
    details.lastOutputTail = safeTail(lastOutputText);
  }

  const parsed = parseProcessFailureMessage(message);
  if (details.exitCode === undefined && parsed?.exitCode !== undefined) {
    details.exitCode = parsed.exitCode;
  }
  if (details.stderrTail === undefined && parsed?.stderrTail) {
    details.stderrTail = parsed.stderrTail;
  }
  if (message.trim()) {
    details.rawCause = safeTail(message);
  }

  return Object.keys(details).length === 0 ? undefined : details;
}

function lastOutputTextFromError(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { readonly lastOutputText?: unknown }).lastOutputText;
  return typeof value === "string" && value.trim() ? value : null;
}

function processFailureLike(error: unknown): {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
} | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as {
    readonly exitCode?: unknown;
    readonly stdout?: unknown;
    readonly stderr?: unknown;
  };
  const exitCode =
    typeof record.exitCode === "number" && Number.isInteger(record.exitCode)
      ? record.exitCode
      : undefined;
  const stdout = typeof record.stdout === "string" ? record.stdout : undefined;
  const stderr = typeof record.stderr === "string" ? record.stderr : undefined;
  if (exitCode === undefined && stdout === undefined && stderr === undefined) {
    return null;
  }
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

function parseProcessFailureMessage(
  message: string,
): { readonly exitCode: string; readonly stderrTail: string } | null {
  const match =
    /\b(?:node_process_runner_failed|codex_json_exec_failed|codex_cli_exec_failed):(\d+):(.*)$/s.exec(
      message,
    );
  if (!match) return null;
  return {
    exitCode: match[1]!,
    stderrTail: safeTail(match[2] ?? ""),
  };
}

function safeTail(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 1000 ? compact.slice(-1000) : compact;
}
