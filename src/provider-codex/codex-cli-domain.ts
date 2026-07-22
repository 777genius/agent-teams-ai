import { accessSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, isAbsolute } from "node:path";
import { codexEnvironmentPolicy } from "./capabilities";
import { codexProviderEgressCliConfigArgs } from "./codex-provider-egress-policy";
import { codexAgentTempRootFromEnv } from "./app-server/domain/app-server-types";

export const codexAuthJsonMaxBytes = 32 * 1024;

export type ValidatedCodexAuthJson = {
  readonly auth_mode: "chatgpt";
  readonly tokens: {
    readonly refresh_token: string;
    readonly access_token?: string;
    readonly id_token?: string;
    readonly expiry?: string | number;
    readonly [key: string]: unknown;
  };
  readonly last_refresh?: string;
  readonly [key: string]: unknown;
};

export type CodexAuthJsonValidationResult = {
  readonly parsed: ValidatedCodexAuthJson;
  readonly byteLength: number;
  readonly exactBytesSha256: string;
  readonly warnings: readonly string[];
};

export type CodexAuthJsonFreshness = {
  readonly lastRefreshAt: Date | null;
  readonly expiresAt: Date | null;
  readonly warnings: readonly string[];
};

export function validateCodexAuthJsonBytes(input: {
  readonly authJsonBytes: string;
  readonly maxBytes?: number;
  readonly staleWarningDays?: number;
  readonly now?: Date;
}): CodexAuthJsonValidationResult {
  const maxBytes = input.maxBytes ?? codexAuthJsonMaxBytes;
  const byteLength = Buffer.byteLength(input.authJsonBytes, "utf8");
  if (byteLength === 0) {
    throw new Error("codex_auth_json_empty");
  }
  if (byteLength > maxBytes) {
    throw new Error("codex_auth_json_too_large");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(input.authJsonBytes);
  } catch {
    throw new Error("codex_auth_json_invalid_json");
  }
  const parsed = parseCodexAuthJson(parsedJson);

  return {
    parsed,
    byteLength,
    exactBytesSha256: createHash("sha256")
      .update(input.authJsonBytes, "utf8")
      .digest("hex"),
    warnings: collectCodexAuthJsonWarnings({
      parsed,
      staleWarningDays: input.staleWarningDays ?? 30,
      now: input.now ?? new Date(),
    }),
  };
}

export function compactCodexAuthJson(input: {
  readonly authJsonBytes: string;
  readonly maxBytes?: number;
}): {
  readonly compactAuthJsonBytes: string;
  readonly byteLength: number;
} {
  const validation = validateCodexAuthJsonBytes(input);
  const compactAuthJsonBytes = JSON.stringify(validation.parsed);
  const byteLength = Buffer.byteLength(compactAuthJsonBytes, "utf8");
  if (byteLength > (input.maxBytes ?? codexAuthJsonMaxBytes)) {
    throw new Error("codex_auth_json_too_large_after_compact");
  }
  return { compactAuthJsonBytes, byteLength };
}

export function readCodexAuthJsonFreshness(input: {
  readonly authJsonBytes: string;
  readonly now?: Date;
}): CodexAuthJsonFreshness {
  const validation = validateCodexAuthJsonBytes({
    authJsonBytes: input.authJsonBytes,
    ...(input.now ? { now: input.now } : {}),
  });
  const warnings: string[] = [...validation.warnings];
  const lastRefreshAt = parseOptionalDate(
    validation.parsed.last_refresh,
    "last_refresh_unparseable",
    warnings,
  );
  const expiresAt = parseOptionalExpiry(
    validation.parsed.tokens.expiry,
    warnings,
  );
  return {
    lastRefreshAt,
    expiresAt,
    warnings,
  };
}

export function classifyCodexRuntimeFailure(message: string): string {
  const normalized = message.toLowerCase();
  if (isCodexCancelledFailure(normalized)) {
    return "task_cancelled";
  }
  if (isCodexTimeoutFailure(normalized)) {
    return "task_timeout";
  }
  if (isCodexInvalidOutputFailure(normalized)) {
    return "provider_output_invalid";
  }
  if (isCodexQuotaOrRateLimitFailure(normalized)) {
    return "quota_limited";
  }
  if (normalized.includes("codex_app_server_goal_blocked")) {
    return "backend_unavailable";
  }
  if (normalized.includes("codex_app_server_goal_max_turns_exceeded")) {
    return "goal_slice_exhausted";
  }
  if (
    isCodexInvalidatedAuthFailure(normalized) ||
    isCodexInvalidAuthJsonFailure(normalized)
  ) {
    return "provider_session_invalid";
  }
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("invalid_grant") ||
    normalized.includes("refresh token") ||
    normalized.includes("login required") ||
    isCodexReconnectableAuthShapeFailure(normalized)
  ) {
    return "needs_reconnect";
  }
  if (
    normalized.includes("permission") ||
    normalized.includes("forbidden") ||
    normalized.includes("resource not accessible")
  ) {
    return "permission_required";
  }
  return "unknown_auth_state";
}

function isCodexReconnectableAuthShapeFailure(
  normalizedMessage: string,
): boolean {
  return (
    normalizedMessage.includes("missing field") &&
    (normalizedMessage.includes("id_token") ||
      normalizedMessage.includes("access_token") ||
      normalizedMessage.includes("refresh_token") ||
      normalizedMessage.includes("auth.json"))
  );
}

function isCodexInvalidAuthJsonFailure(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes("codex_auth_json_invalid_") ||
    normalizedMessage.includes("codex_auth_json_empty") ||
    normalizedMessage.includes("codex_auth_json_too_large")
  );
}

function isCodexCancelledFailure(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes("node_process_runner_aborted") ||
    normalizedMessage.includes("subscription_worker_run_aborted") ||
    normalizedMessage.includes("codex_app_server_aborted") ||
    (normalizedMessage.includes("codex_app_server_turn_aborted") &&
      !normalizedMessage.includes("codex_app_server_turn_aborted:replaced")) ||
    normalizedMessage.includes("aborterror") ||
    /\baborted\b/.test(normalizedMessage)
  );
}

function isCodexTimeoutFailure(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes("node_process_runner_timeout") ||
    normalizedMessage.includes("codex_app_server_request_timeout") ||
    normalizedMessage.includes("codex_app_server_turn_timeout") ||
    /\btimeout\b/.test(normalizedMessage) ||
    /\btimed out\b/.test(normalizedMessage)
  );
}

function isCodexInvalidOutputFailure(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes("codex_json_event_invalid") ||
    normalizedMessage.includes("codex_json_final_message_missing") ||
    normalizedMessage.includes("codex_structured_output_invalid") ||
    normalizedMessage.includes("codex_json_output_too_large") ||
    normalizedMessage.includes("codex_app_server_final_message_missing") ||
    normalizedMessage.includes("codex_app_server_goal_turn_output_missing") ||
    normalizedMessage.includes("codex_app_server_structured_output_invalid") ||
    normalizedMessage.includes("codex_app_server_output_too_large")
  );
}

function isCodexQuotaOrRateLimitFailure(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes("usagelimitexceeded") ||
    normalizedMessage.includes("ratelimitexceeded") ||
    normalizedMessage.includes("codex_app_server_goal_usagelimited") ||
    /\b(?:429|too many requests|rate[_ -]?limit(?:ed| exceeded)?|rate_limit_exceeded)\b/.test(
      normalizedMessage,
    ) ||
    /\b(?:rate[_ -]?limits?|not enough retry quota|usage[_ -]?limit(?: reached| exceeded)?|limit reached)\b/.test(
      normalizedMessage,
    ) ||
    /\b(?:insufficient_quota|quota_exceeded|exceeded (?:your )?(?:current )?quota|quota (?:limit|exceeded))\b/.test(
      normalizedMessage,
    ) ||
    /\byou(?:'|’)ve hit your usage limit\b/.test(normalizedMessage) ||
    /\b(?:purchase|buy|add|get) more credits\b/.test(normalizedMessage) ||
    /\bout of credits\b/.test(normalizedMessage) ||
    /\b(?:billing_hard_limit|payment required|billing (?:limit|quota|hard limit|not active|required))\b/.test(
      normalizedMessage,
    )
  );
}

function isCodexInvalidatedAuthFailure(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes("token_invalidated") ||
    normalizedMessage.includes("refresh_token_invalidated") ||
    normalizedMessage.includes("refresh token was revoked") ||
    normalizedMessage.includes("authentication token has been invalidated") ||
    normalizedMessage.includes("access token could not be refreshed") ||
    normalizedMessage.includes("please log out and sign in again")
  );
}

export function pruneCodexChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!shouldAllowChildEnvKey(key)) continue;
    allowed[key] = value;
  }
  allowed.PATH = codexChildPath(env);
  const agentTempRoot = codexAgentTempRootFromEnv(env);
  if (agentTempRoot) {
    allowed.TMPDIR = agentTempRoot;
    allowed.TMP = agentTempRoot;
    allowed.TEMP = agentTempRoot;
    // Dependency bootstrap has already validated and installed the exact
    // lockfile. Prevent pnpm from reopening its shared store database from
    // inside the narrower provider sandbox before every script execution.
    allowed.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = "false";
  }
  return allowed;
}

export function codexChildPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  // Preserve caller PATH precedence, then add host fallbacks for pruned worker envs.
  return uniquePathEntries([
    ...(env.PATH ?? "").split(delimiter),
    ...standardHostPathEntries,
    ...availableExecutableDirs(env),
  ]).join(delimiter);
}

export function buildCodexRefreshBootstrapPlan(input: {
  readonly codexBinaryPath: string;
  readonly tempHome: string;
  readonly tempCodexHome: string;
  readonly emptyWorkingDirectory: string;
  readonly authJsonPath: string;
  readonly model?: string;
}): {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
} {
  const model = input.model?.trim();
  return {
    command: input.codexBinaryPath,
    args: [
      "exec",
      ...(model ? ["--model", model] : []),
      ...codexProviderEgressCliConfigArgs(),
      "--sandbox",
      "read-only",
      "--ignore-rules",
      "--ephemeral",
      "-C",
      input.emptyWorkingDirectory,
      "--skip-git-repo-check",
      "-",
    ],
    cwd: input.emptyWorkingDirectory,
    env: {
      HOME: input.tempHome,
      CODEX_HOME: input.tempCodexHome,
      REVIEWROUTER_CODEX_AUTH_PATH: input.authJsonPath,
    },
  };
}

function parseCodexAuthJson(value: unknown): ValidatedCodexAuthJson {
  if (!isObject(value)) {
    throw new Error("codex_auth_json_invalid_shape");
  }
  if (value.auth_mode !== "chatgpt") {
    throw new Error("codex_auth_json_invalid_auth_mode");
  }
  if (!isObject(value.tokens)) {
    throw new Error("codex_auth_json_missing_tokens");
  }
  if (
    typeof value.tokens.refresh_token !== "string" ||
    value.tokens.refresh_token.length === 0
  ) {
    throw new Error("codex_auth_json_missing_refresh_token");
  }
  for (const key of ["access_token", "id_token"] as const) {
    const token = value.tokens[key];
    if (token !== undefined && typeof token !== "string") {
      throw new Error(`codex_auth_json_invalid_${key}`);
    }
  }
  if (
    value.last_refresh !== undefined &&
    typeof value.last_refresh !== "string"
  ) {
    throw new Error("codex_auth_json_invalid_last_refresh");
  }
  if (
    value.tokens.expiry !== undefined &&
    typeof value.tokens.expiry !== "string" &&
    typeof value.tokens.expiry !== "number"
  ) {
    throw new Error("codex_auth_json_invalid_expiry");
  }
  return value as ValidatedCodexAuthJson;
}

function collectCodexAuthJsonWarnings(input: {
  readonly parsed: ValidatedCodexAuthJson;
  readonly staleWarningDays: number;
  readonly now: Date;
}): readonly string[] {
  const warnings: string[] = [];
  if (!input.parsed.last_refresh) {
    warnings.push("last_refresh_missing");
    return warnings;
  }
  const refreshedAt = Date.parse(input.parsed.last_refresh);
  if (!Number.isFinite(refreshedAt)) {
    warnings.push("last_refresh_unparseable");
    return warnings;
  }
  const ageDays = (input.now.getTime() - refreshedAt) / 86_400_000;
  if (ageDays > input.staleWarningDays) {
    warnings.push("last_refresh_stale");
  }
  return warnings;
}

function parseOptionalDate(
  value: string | undefined,
  warning: string,
  warnings: string[],
): Date | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    if (!warnings.includes(warning)) warnings.push(warning);
    return null;
  }
  return new Date(parsed);
}

function parseOptionalExpiry(
  value: string | number | undefined,
  warnings: string[],
): Date | null {
  if (value === undefined) return null;
  const ms =
    typeof value === "number"
      ? normalizeEpochToMs(value)
      : Number.isFinite(Number(value))
        ? normalizeEpochToMs(Number(value))
        : Date.parse(value);
  if (!Number.isFinite(ms)) {
    warnings.push("expiry_unparseable");
    return null;
  }
  return new Date(ms);
}

function normalizeEpochToMs(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function shouldDropChildEnvKey(key: string): boolean {
  return codexEnvironmentPolicy.denylist.some((pattern) =>
    matchesEnvPattern(key, pattern),
  );
}

function shouldAllowChildEnvKey(key: string): boolean {
  if (shouldDropChildEnvKey(key)) {
    return false;
  }
  if (codexEnvironmentPolicy.inheritHostEnvironment) {
    return true;
  }
  return codexEnvironmentPolicy.allowlist.some((pattern) =>
    matchesEnvPattern(key, pattern),
  );
}

function matchesEnvPattern(key: string, pattern: string): boolean {
  if (pattern.endsWith("*") && pattern.startsWith("*")) {
    return key.includes(pattern.slice(1, -1));
  }
  if (pattern.endsWith("*")) {
    return key.startsWith(pattern.slice(0, -1));
  }
  if (pattern.startsWith("*")) {
    return key.endsWith(pattern.slice(1));
  }
  return key === pattern;
}

const standardHostPathEntries = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const;

const explicitGhPathEnvNames = [
  "SUBSCRIPTION_RUNTIME_GH_PATH",
  "GH_PATH",
] as const;

const ghPathCandidates = [
  "/usr/bin/gh",
  "/usr/local/bin/gh",
  "/opt/homebrew/bin/gh",
] as const;

function availableExecutableDirs(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const candidates = [
    ...explicitGhPathEnvNames
      .map((name) => env[name]?.trim())
      .filter(
        (path): path is string =>
          path !== undefined && path.length > 0 && isAbsolute(path),
      ),
    ...ghPathCandidates,
  ];
  return candidates.filter(isExecutable).map((path) => dirname(path));
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniquePathEntries(entries: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of entries) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
