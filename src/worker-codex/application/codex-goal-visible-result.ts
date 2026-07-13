type CodexGoalVisibleResultInput = {
  readonly exists?: boolean | undefined;
  readonly status?: string | undefined;
  readonly reason?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly progress: {
    readonly status?: string | undefined;
    readonly updatedAt?: string | undefined;
  };
  readonly workerAlive: boolean;
};

export type CodexGoalVisibleResult = {
  readonly exists?: boolean;
  readonly status?: string;
  readonly reason?: string;
  readonly updatedAt?: string;
  readonly warning?: string;
};

export function isCodexGoalAttemptProcess(input: {
  readonly alive?: boolean | undefined;
  readonly command?: string | undefined;
  readonly taskId?: string | undefined;
  readonly progressPath?: string | undefined;
}): boolean {
  if (!input.alive || !input.command || !input.taskId || !input.progressPath)
    return false;
  if (!commandHasExecutable(input.command)) return false;
  return (
    commandHasOption(input.command, "--task-id", input.taskId) &&
    commandHasOption(input.command, "--progress", input.progressPath)
  );
}

function commandHasExecutable(command: string): boolean {
  return /(?:^|\s)(?:\S*\/)?(?:subscription-runtime-codex-goal|codex-goal-cli\.js)(?=\s|$)/
    .test(command);
}

export function resolveVisibleCodexGoalResult(
  input: CodexGoalVisibleResultInput,
): CodexGoalVisibleResult {
  if (
    input.exists &&
    input.workerAlive &&
    input.progress.status === "running" &&
    timestampPrecedes(input.updatedAt, input.progress.updatedAt)
  ) {
    return {
      exists: false,
      warning:
        "terminal result predates the active worker attempt and was ignored",
    };
  }
  return {
    ...(input.exists === undefined ? {} : { exists: input.exists }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  };
}

function timestampPrecedes(
  earlier: string | undefined,
  later: string | undefined,
): boolean {
  if (!earlier || !later) return false;
  const earlierMs = Date.parse(earlier);
  const laterMs = Date.parse(later);
  return (
    Number.isFinite(earlierMs) &&
    Number.isFinite(laterMs) &&
    earlierMs < laterMs
  );
}

function commandHasOption(
  command: string,
  option: string,
  value: string,
): boolean {
  const optionPattern = escapeRegex(option);
  const valuePattern = escapeRegex(value);
  return new RegExp(
    `(?:^|\\s)${optionPattern}(?:=|\\s+)${valuePattern}(?=\\s|$)`,
  ).test(command);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
