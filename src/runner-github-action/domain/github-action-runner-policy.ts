export const defaultMaxCapturedOutputBytes = 256_000;
export const defaultKillGraceMs = 5_000;

export type GitHubActionProcessPolicyInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
};

export function assertSafeGitHubActionProcessInput(
  input: GitHubActionProcessPolicyInput,
): void {
  if (!input.command || input.command.includes("\0")) {
    throw new Error("runner_invalid_command");
  }
  if (!input.cwd || input.cwd.includes("\0")) {
    throw new Error("runner_invalid_cwd");
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("runner_invalid_timeout");
  }
  for (const arg of input.args) {
    if (arg.includes("\0")) {
      throw new Error("runner_invalid_arg");
    }
  }
  for (const key of Object.keys(input.env)) {
    if (isForbiddenGitHubActionRunnerEnvKey(key)) {
      throw new Error(`runner_forbidden_env:${key}`);
    }
  }
}

export function isForbiddenGitHubActionRunnerEnvKey(key: string): boolean {
  return (
    key === "GITHUB_TOKEN" ||
    key === "GH_TOKEN" ||
    key === "ACTIONS_ID_TOKEN_REQUEST_URL" ||
    key === "ACTIONS_ID_TOKEN_REQUEST_TOKEN" ||
    key === "GITHUB_ENV" ||
    key === "GITHUB_OUTPUT" ||
    key === "GITHUB_PATH" ||
    key === "GITHUB_STEP_SUMMARY" ||
    key === "GITHUB_STATE" ||
    key === "NODE_OPTIONS" ||
    key === "BASH_ENV" ||
    key === "ENV" ||
    key.startsWith("INPUT_AUTH") ||
    key.includes("AUTH_JSON") ||
    key.includes("OPENAI_API_KEY") ||
    key.includes("CLAUDE_CODE_OAUTH_TOKEN") ||
    key.includes("OPENROUTER_API_KEY")
  );
}

export function safeGitHubActionFailureOutput(output: string): string {
  const compact = output.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(-1000) : "empty_process_output";
}
